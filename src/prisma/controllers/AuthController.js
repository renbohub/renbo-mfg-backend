// -----------------------------
// File: src/prisma/controllers/AuthController.js
// -----------------------------
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const { prisma } = require("../index");
const { normalizeEmail, normalizeUsername } = require("../utils/strictIdentifiers");
const JWT_SECRET = process.env.JWT_SECRET || "secret-key";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN; // e.g. '30d', '3600', or 'unlimited' to disable expiry

const USER_ROLE_INCLUDE = {
  where: { isActive: true },
  include: {
    role: {
      include: {
        permissions: { where: { isDeleted: false, isActive: true } },
      },
    },
  },
};

function mapUserUniqueConstraintError(err) {
  if (err?.code !== "P2002") return null;

  const targets = Array.isArray(err?.meta?.target) ? err.meta.target : [];
  if (targets.includes("email")) {
    return {
      code: "AUTH_EMAIL_ALREADY_EXISTS",
      message: "Email already exists",
    };
  }

  if (targets.includes("username")) {
    return {
      code: "AUTH_USERNAME_ALREADY_EXISTS",
      message: "Username already exists",
    };
  }

  return {
    code: "AUTH_DUPLICATE_DATA",
    message: "Duplicate data detected",
  };
}

async function findUserConflict({ username, email, excludeId = null } = {}) {
  const conditions = [];

  const normalizedUsername = normalizeUsername(username) || "";
  const normalizedEmail = normalizeEmail(email) || "";

  if (normalizedUsername) {
    conditions.push({ username: { equals: normalizedUsername, mode: "insensitive" } });
  }

  if (normalizedEmail) {
    conditions.push({ email: { equals: normalizedEmail, mode: "insensitive" } });
  }

  if (conditions.length === 0) return null;

  const where = {
    isDeleted: false,
    OR: conditions,
  };

  if (excludeId) {
    where.NOT = { id: excludeId };
  }

  return prisma.user.findFirst({
    where,
    select: {
      id: true,
      username: true,
      email: true,
    },
  });
}

function mapUserConflictToResponse(conflict, { username, email } = {}) {
  if (!conflict) return null;

  const normalizedUsername = normalizeUsername(username) || "";
  const normalizedEmail = normalizeEmail(email) || "";
  const conflictUsername = typeof conflict.username === "string" ? conflict.username.trim().toLowerCase() : "";
  const conflictEmail = typeof conflict.email === "string" ? conflict.email.trim().toLowerCase() : "";

  if (normalizedEmail && conflictEmail && normalizedEmail === conflictEmail) {
    return {
      code: "AUTH_EMAIL_ALREADY_EXISTS",
      message: "Email already exists",
    };
  }

  if (normalizedUsername && conflictUsername && normalizedUsername === conflictUsername) {
    return {
      code: "AUTH_USERNAME_ALREADY_EXISTS",
      message: "Username already exists",
    };
  }

  return {
    code: "AUTH_DUPLICATE_DATA",
    message: "Duplicate data detected",
  };
}

// Reusable untuk mapping return user
function mapUser(user) {
  if (!user) return null;
  const roleAssignments = (user.roleAssignments || []).filter(
    (assignment) => assignment.role?.isActive && !assignment.role?.isDeleted,
  );
  const effectivePermissions = [];
  for (const assignment of roleAssignments) {
    for (const permission of assignment.role.permissions || []) {
      effectivePermissions.push({
        roleId: assignment.role.id,
        roleCode: assignment.role.roleCode,
        moduleCode: permission.moduleCode,
        pageCode: permission.pageCode,
        resourceCode: permission.resourceCode,
        actions: Array.isArray(permission.actions) ? permission.actions : [],
        dataScope: permission.dataScope || null,
      });
    }
  }
  return {
    id: user.id,
    username: user.username,
    fullName: user.fullName,
    employeeId: user.employeeId,
    employee: user.employee
      ? {
          employeeId: user.employee.employeeId,
          fullName: user.employee.fullName,
          email: user.employee.email,
          position: user.employee.position,
          profilePhoto: user.employee.profilePhoto,
          signature: user.employee.signature,
        }
      : null,
    isSuperAdmin: user.isSuperAdmin,
    listMenu: user.listMenu,
    roles: roleAssignments.map((assignment) => ({
      id: assignment.role.id,
      roleCode: assignment.role.roleCode,
      roleName: assignment.role.roleName,
      isPrimary: assignment.isPrimary,
    })),
    effectivePermissions,
    email: user.email,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

const USER_EMPLOYEE_SELECT = {
  employeeId: true,
  fullName: true,
  email: true,
  position: true,
  profilePhoto: true,
  signature: true,
};

const USER_PUBLIC_SELECT = {
  id: true,
  username: true,
  fullName: true,
  employeeId: true,
  employee: { select: USER_EMPLOYEE_SELECT },
  email: true,
  isSuperAdmin: true,
  listMenu: true,
  roleAssignments: USER_ROLE_INCLUDE,
  isDeleted: true,
  createdAt: true,
  updatedAt: true,
};

// Register user baru (sementara, nanti bisa batasi superadmin only)
exports.register = async (req, res, next) => {
  try {
    const { username, password, fullName, email, employeeId, isSuperAdmin, listMenu } = req.body;
    const normalizedUsername = normalizeUsername(username);
    const normalizedEmail = normalizeEmail(email);

    if (!normalizedUsername) {
      return res.status(400).json({ message: "Username tidak valid" });
    }

    const conflict = await findUserConflict({ username: normalizedUsername, email: normalizedEmail });
    const conflictResponse = mapUserConflictToResponse(conflict, { username: normalizedUsername, email: normalizedEmail });
    if (conflictResponse) {
      return res.status(409).json(conflictResponse);
    }
    
    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);
    
    const user = await prisma.user.create({
      data: {
        username: normalizedUsername,
        password: hashedPassword,
        fullName,
        email: normalizedEmail,
        employeeId: employeeId || null,
        isSuperAdmin: isSuperAdmin || false,
        listMenu: listMenu || [],
      },
      include: {
        employee: {
          select: {
            employeeId: true,
            fullName: true,
            email: true,
            position: true,
            profilePhoto: true,
            signature: true,
          },
        },
        roleAssignments: USER_ROLE_INCLUDE,
      },
    });
    
    res.status(201).json(mapUser(user));
  } catch (err) {
    const uniqueErr = mapUserUniqueConstraintError(err);
    if (uniqueErr) {
      return res.status(409).json(uniqueErr);
    }
    next(err);
  }
};

// Login
exports.login = async (req, res, next) => {
  try {
    const { username, email, identifier, password } = req.body;
    const loginIdentifier = (identifier || username || email || "").trim();

    if (!loginIdentifier) {
      return res.status(401).json({
        code: 'AUTH_USER_NOT_FOUND',
        message: 'Username or email not found',
      });
    }

    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { username: { equals: loginIdentifier, mode: 'insensitive' } },
          { email: { equals: loginIdentifier, mode: 'insensitive' } },
        ],
      },
      include: {
        employee: { select: USER_EMPLOYEE_SELECT },
        roleAssignments: USER_ROLE_INCLUDE,
      },
    });
    if (!user) {
      return res.status(401).json({
        code: 'AUTH_USER_NOT_FOUND',
        message: 'Username or email not found',
      });
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.status(401).json({
        code: 'AUTH_INVALID_PASSWORD',
        message: 'Incorrect password',
      });
    }

    // Build sign options: if JWT_EXPIRES_IN is set to the literal string 'unlimited' (case-insensitive)
    // or is empty/undefined, omit the expiresIn option to create a non-expiring token.
    const signOptions = {};
    if (typeof JWT_EXPIRES_IN !== 'undefined' && JWT_EXPIRES_IN !== null) {
      if (String(JWT_EXPIRES_IN).toLowerCase() !== 'unlimited' && String(JWT_EXPIRES_IN) !== '') {
        signOptions.expiresIn = JWT_EXPIRES_IN;
      }
    }

    const token = jwt.sign({ id: user.id }, JWT_SECRET, signOptions);
    res.json({
      token,
      user: mapUser(user),
    });
  } catch (err) {
    next(err);
  }
};

// get self profile
exports.profile = async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: USER_PUBLIC_SELECT,
    });
    
    if (!user) return res.status(404).json({ message: "User not found" });

    res.json(mapUser(user));
  } catch (err) {
    next(err);
  }
};

// update self
exports.updateProfile = async (req, res, next) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: "No user context" });

    // mencegah perubahan privileged fields
    const privileged = ["isSuperAdmin", "isDeleted", "password"];
    for (const p of privileged) {
      if (typeof req.body[p] !== "undefined") {
        return res.status(403).json({ message: `Forbidden: cannot change ${p}` });
      }
    }

    const conflict = await findUserConflict({
      username: req.body.username,
      email: req.body.email,
      excludeId: userId,
    });
    const conflictResponse = mapUserConflictToResponse(conflict, {
      username: req.body.username,
      email: req.body.email,
    });
    if (conflictResponse) {
      return res.status(409).json(conflictResponse);
    }

    if (typeof req.body.username !== "undefined") {
      req.body.username = normalizeUsername(req.body.username);
      if (!req.body.username) {
        return res.status(400).json({ message: "Username tidak valid" });
      }
    }
    if (typeof req.body.employeeId !== "undefined" && !req.body.employeeId) {
      req.body.employeeId = null;
    }

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: req.body,
      select: USER_PUBLIC_SELECT,
    });

    if (!updatedUser) return res.status(404).json({ message: "User not found" });

    res.json(mapUser(updatedUser));
  } catch (e) {
    const uniqueErr = mapUserUniqueConstraintError(e);
    if (uniqueErr) {
      return res.status(409).json(uniqueErr);
    }
    next(e);
  }
};

// update password untuk themself
exports.updateProfilePassword = async (req, res, next) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: "No user context" });

    const { currentPassword, newPassword, confirmPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: "currentPassword and newPassword are required" });
    }
    if (typeof confirmPassword !== "undefined" && newPassword !== confirmPassword) {
      return res.status(400).json({ message: "newPassword and confirmPassword do not match" });
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ message: "User not found" });

    const match = await bcrypt.compare(currentPassword, user.password);
    if (!match) return res.status(400).json({ message: "Current password is incorrect" });

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({
      where: { id: userId },
      data: { password: hashedPassword },
    });

    res.json({ message: "Password updated" });
  } catch (e) {
    next(e);
  }
};

// Users
exports.list = async (req, res, next) => {
  try {
    const { 
      q, 
      isDeleted, 
      isSuperAdmin, 
      page = 1, 
      limit = 100,
      sortBy = "createdAt", 
      sortOrder = "desc" 
    } = req.query;

    const where = {};

    if (q) {
      where.OR = [
        { username: { contains: q, mode: 'insensitive' } },
        { fullName: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
      ];
    }
    
    if (isDeleted !== undefined) {
      where.isDeleted = String(isDeleted) === "true";
    } else {
      where.isDeleted = false; // default
    }
    
    if (isSuperAdmin !== undefined) {
      where.isSuperAdmin = String(isSuperAdmin) === "true";
    }

    const orderBy = {};
    if (sortBy) {
      orderBy[sortBy] = sortOrder === "asc" ? "asc" : "desc";
    } else {
      orderBy.createdAt = "desc";
    }

    const [items, total] = await Promise.all([
      prisma.user.findMany({
        where,
        orderBy,
        skip: (page - 1) * limit,
        take: Number(limit),
        select: USER_PUBLIC_SELECT,
      }),
      prisma.user.count({ where }),
    ]);

    res.json({ 
      items: items.map(mapUser), 
      total, 
      page: Number(page), 
      limit: Number(limit) 
    });
  } catch (err) {
    next(err);
  }
};

exports.get = async (req, res, next) => {
  try {
    const doc = await prisma.user.findUnique({
      where: { username: req.params.username },
      select: USER_PUBLIC_SELECT,
    });
    
    if (!doc) return res.status(404).json({ message: "User not found" });
    res.json(mapUser(doc));
  } catch (e) {
    next(e);
  }
};

exports.getByEmail = async (req, res, next) => {
  try {
    const email = String(req.params.email || "").trim();
    if (!email) return res.status(404).json({ message: "User not found" });

    const doc = await prisma.user.findFirst({
      where: {
        email: { equals: email, mode: "insensitive" },
        isDeleted: false,
      },
      select: USER_PUBLIC_SELECT,
    });

    if (!doc) return res.status(404).json({ message: "User not found" });
    res.json(mapUser(doc));
  } catch (e) {
    next(e);
  }
};

exports.update = async (req, res, next) => {
  try {
    if (typeof req.body.username !== "undefined") {
      req.body.username = normalizeUsername(req.body.username);
      if (!req.body.username) {
        return res.status(400).json({ message: "Username tidak valid" });
      }
    }
    if (typeof req.body.employeeId !== "undefined" && !req.body.employeeId) {
      req.body.employeeId = null;
    }

    // Jika ada password di body, hash dulu
    if (req.body.password) {
      req.body.password = await bcrypt.hash(req.body.password, 10);
    }

    const conflict = await findUserConflict({
      username: req.body.username,
      email: req.body.email,
      excludeId: req.params.id,
    });
    const conflictResponse = mapUserConflictToResponse(conflict, {
      username: req.body.username,
      email: req.body.email,
    });
    if (conflictResponse) {
      return res.status(409).json(conflictResponse);
    }
    
    const doc = await prisma.user.update({
      where: { id: req.params.id },
      data: req.body,
      select: USER_PUBLIC_SELECT,
    });
    
    if (!doc) return res.status(404).json({ message: "User not found" });
    res.json(mapUser(doc));
  } catch (e) {
    const uniqueErr = mapUserUniqueConstraintError(e);
    if (uniqueErr) {
      return res.status(409).json(uniqueErr);
    }
    next(e);
  }
};

exports.updatePassword = async (req, res, next) => {
  try {
    const hashedPassword = await bcrypt.hash(req.body.password, 10);
    
    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: { password: hashedPassword },
    });
    
    if (!user) return res.status(404).json({ message: "User not found" });
    res.json({ message: "Password updated" });
  } catch (e) {
    next(e);
  }
};

exports.remove = async (req, res, next) => {
  try {
    // Soft delete
    const doc = await prisma.user.update({
      where: { id: req.params.id },
      data: { isDeleted: true },
    });
    
    if (!doc) return res.status(404).json({ message: "User not found" });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
};

exports.bulkRemove = async (req, res, next) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: "ids array required" });
    }
    
    // Soft delete
    const result = await prisma.user.updateMany({
      where: { id: { in: ids } },
      data: { isDeleted: true },
    });
    
    res.json({ deletedCount: result.count });
  } catch (e) {
    next(e);
  }
};

exports.stats = async (req, res, next) => {
  try {
    const [totalUsers, totalActiveUsers, totalSuperAdminUsers] = await Promise.all([
      prisma.user.count({ where: { isDeleted: false } }),
      prisma.user.count({ where: { isDeleted: false } }),
      prisma.user.count({ where: { isSuperAdmin: true, isDeleted: false } }),
    ]);
    
    res.json({
      totalUsers,
      totalActiveUsers,
      totalSuperAdminUsers,
    });
  } catch (e) {
    next(e);
  }
};
