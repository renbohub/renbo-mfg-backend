const jwt = require("jsonwebtoken");
const { prisma } = require("../index");
const { attachContextAudit } = require("../utils/pageContext");
const { resolvePageContext } = require("../utils/pageContext");
const { userHasPermission } = require("../services/ai/permissionEvaluator");

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
    const pageContext = resolvePageContext(req);
    const requirement = { resourceCode: resource, action };
    if (userHasPermission(req.user, requirement, pageContext)) return next();
    const hasRoleAssignments = (req.user.roleAssignments || []).some(
      (assignment) => assignment.isActive && assignment.role?.isActive && !assignment.role?.isDeleted
    );
    if (hasRoleAssignments) {
      return res.status(403).json({ message: `Forbidden: Role tidak memiliki akses ${action} ke ${resource}` });
    }
    return res.status(403).json({ message: `Forbidden: No ${action} access to ${resource}` });
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
