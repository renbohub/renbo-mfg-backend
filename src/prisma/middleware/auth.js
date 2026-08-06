const jwt = require("jsonwebtoken");
const { prisma } = require("../index");
const { attachContextAudit } = require("../utils/pageContext");
const { resolvePageContext } = require("../utils/pageContext");

const JWT_SECRET = process.env.JWT_SECRET || "secret-key";
const EXPORT_TOKEN_SECRET = process.env.EXPORT_TOKEN_SECRET || JWT_SECRET;

// Middleware untuk verify token
exports.auth = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(" ")[1]; // "Bearer token"
    if (!token) return res.status(401).json({ message: "No token provided" });

    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
      include: {
        roleAssignments: {
          where: { isActive: true },
          include: {
            role: {
              include: {
                permissions: { where: { isDeleted: false, isActive: true } },
              },
            },
          },
        },
      },
    });
    
    if (!user || user.isDeleted) {
      return res.status(401).json({ message: "Invalid or inactive user" });
    }
    
    req.user = user;
    req.user.effectiveRoles = (user.roleAssignments || [])
      .filter((assignment) => assignment.role?.isActive && !assignment.role?.isDeleted)
      .map((assignment) => ({
        id: assignment.role.id,
        roleCode: assignment.role.roleCode,
        roleName: assignment.role.roleName,
        isPrimary: assignment.isPrimary,
      }));
    attachContextAudit(req, res);
    next();
  } catch (err) {
    if (["ECONNREFUSED", "P1001", "P1017"].includes(err?.code)) {
      console.error("Authentication database unavailable:", err.code);
      return res.status(503).json({
        code: "DATABASE_UNAVAILABLE",
        message: "Database PostgreSQL belum aktif. Silakan coba kembali setelah service database berjalan.",
      });
    }
    return res.status(401).json({ message: "Unauthorized" });
  }
};

// Middleware untuk cek izin akses menu
exports.authorize = (resource, action = "read") => {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ message: "No user context" });

    // super admin full akses
    if (req.user.isSuperAdmin) return next();

    const normalizeKey = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9*]/g, "");
    const requiredAction = String(action).toLowerCase();
    const targetResource = normalizeKey(resource);
    const pageContext = resolvePageContext(req);
    const contextModule = normalizeKey(pageContext.moduleCode);
    const contextPage = normalizeKey(pageContext.pageCode);
    const activeAssignments = (req.user.roleAssignments || []).filter(
      (assignment) => assignment.isActive && assignment.role?.isActive && !assignment.role?.isDeleted,
    );

    if (activeAssignments.length > 0) {
      const hasRoleAccess = activeAssignments.some((assignment) =>
        (assignment.role.permissions || []).some((permission) => {
          const targets = [permission.resourceCode, permission.pageCode, permission.moduleCode].map(normalizeKey);
          const moduleMatch = normalizeKey(permission.moduleCode) === "*" || normalizeKey(permission.moduleCode) === contextModule;
          const pageMatch = normalizeKey(permission.pageCode) === "*" || normalizeKey(permission.pageCode) === contextPage;
          const resourceMatch = normalizeKey(permission.resourceCode) === "*" || normalizeKey(permission.resourceCode) === targetResource;
          const explicitlyGlobal = normalizeKey(permission.moduleCode) === "*"
            && normalizeKey(permission.pageCode) === "*"
            && normalizeKey(permission.resourceCode) === "*";
          const legacyMatch = explicitlyGlobal || (normalizeKey(permission.resourceCode) !== "*" && targets.includes(targetResource));
          if (!(moduleMatch && pageMatch && resourceMatch) && !legacyMatch) return false;
          const actions = Array.isArray(permission.actions)
            ? permission.actions.map((item) => String(item).toLowerCase())
            : [];
          if (actions.includes("*")) return true;
          if (requiredAction === "read") {
            return ["read", "create", "update", "delete", "approve", "submit", "release", "export"].some((item) => actions.includes(item));
          }
          return actions.includes(requiredAction);
        }),
      );

      if (hasRoleAccess) return next();
      return res.status(403).json({ message: `Forbidden: Role tidak memiliki akses ${action} ke ${resource}` });
    }

    // Fallback sementara untuk user lama yang belum diberi role master.
    const listMenu = Array.isArray(req.user.listMenu) ? req.user.listMenu : [];

    const hasAccess = listMenu.some((entry) => {
      if (!entry) return false;

      // untuk object { resource: "buyers", actions: ["read","update"] }
      if (typeof entry === "object" && entry.resource) {
        if (normalizeKey(entry.resource) !== targetResource)
          return false;
        const actions = Array.isArray(entry.actions)
          ? entry.actions.map((x) => String(x).toLowerCase())
          : [];

        // wildcard
        if (actions.includes("*")) return true;

        // jika actions kosong, auto dapat read access
        if (actions.length === 0 && requiredAction === "read") return true;

        // jika request read, auto dapat akses jika punya create/update/delete
        if (requiredAction === "read") {
          return (
            actions.includes("read") ||
            actions.includes("create") ||
            actions.includes("update") ||
            actions.includes("delete") ||
            actions.includes("approve")
          );
        }

        // untuk action selain read, harus ada permission spesifik
        return actions.includes(requiredAction);
      }

      return false;
    });

    if (!hasAccess) {
      return res
        .status(403)
        .json({ message: `Forbidden: No ${action} access to ${resource}` });
    }

    next();
  };
};

exports.requireSuperAdmin = (req, res, next) => {
  if (!req.user) return res.status(401).json({ message: "No user context" });

  if (req.user.isSuperAdmin === true) return next();

  return res.status(403).json({
    message: "Forbidden: Maintenance access requires super admin.",
  });
};

// Middleware untuk endpoint integrasi export (tanpa login user)
exports.authExportToken = async (req, res, next) => {
  try {
    const authHeaderToken = req.headers.authorization?.split(" ")[1];
    const headerToken = req.headers["x-export-token"];
    const token = authHeaderToken || headerToken;

    if (!token) {
      return res.status(401).json({ message: "Export token tidak ditemukan" });
    }

    const decoded = jwt.verify(token, EXPORT_TOKEN_SECRET);
    if (decoded?.type !== "export") {
      return res.status(401).json({ message: "Export token tidak valid" });
    }

    if (!decoded?.jti) {
      return res.status(401).json({ message: "Export token tidak memiliki jti" });
    }

    const tokenRecord = await prisma.exportToken.findUnique({
      where: { jti: decoded.jti },
      select: { jti: true, revokedAt: true, expiresAt: true },
    });

    if (!tokenRecord) {
      return res.status(401).json({ message: "Export token tidak terdaftar" });
    }

    if (tokenRecord.revokedAt) {
      return res.status(401).json({ message: "Export token sudah di-revoke" });
    }

    if (new Date(tokenRecord.expiresAt).getTime() <= Date.now()) {
      return res.status(401).json({ message: "Export token sudah expired" });
    }

    req.exportToken = decoded;
    next();
  } catch (_err) {
    return res.status(401).json({ message: "Export token tidak valid atau sudah expired" });
  }
};
