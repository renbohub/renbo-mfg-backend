const { prisma } = require("../../index");

const ROLE_INCLUDE = {
  permissions: {
    where: { isDeleted: false },
    orderBy: [{ moduleCode: "asc" }, { pageCode: "asc" }],
  },
  users: {
    where: { isActive: true },
    include: {
      user: {
        select: {
          id: true,
          username: true,
          fullName: true,
          email: true,
          employee: { select: { fullName: true, position: true } },
        },
      },
    },
  },
  _count: { select: { users: true, permissions: true, approvalSteps: true } },
};

const ALLOWED_ACTIONS = new Set([
  "read",
  "create",
  "update",
  "delete",
  "approve",
  "submit",
  "release",
  "export",
  "manual-complete",
  "*",
]);

function actor(req) {
  return req.user?.username || req.user?.email || "system";
}

function roleCode(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeActions(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((item) => String(item || "").trim().toLowerCase())
    .filter((item) => ALLOWED_ACTIONS.has(item)))];
}

function normalizePermissions(items, req) {
  const unique = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const moduleCode = String(item?.moduleCode || "").trim().toLowerCase();
    const pageCode = String(item?.pageCode || "").trim().toLowerCase();
    if (!moduleCode || !pageCode) continue;
    unique.set(`${moduleCode}|${pageCode}`, {
      moduleCode,
      pageCode,
      resourceCode: String(item.resourceCode || pageCode).trim(),
      actions: normalizeActions(item.actions),
      dataScope: item.dataScope && typeof item.dataScope === "object" ? item.dataScope : undefined,
      isActive: item.isActive !== false,
      isDeleted: false,
      createdBy: actor(req),
      updatedBy: actor(req),
    });
  }
  return [...unique.values()];
}

function normalizeUserIds(value) {
  return [...new Set((Array.isArray(value) ? value : []).map(String).filter(Boolean))];
}

function mapRole(role) {
  return {
    ...role,
    userIds: (role.users || []).map((entry) => entry.userId),
    assignedUsers: (role.users || []).map((entry) => ({
      ...entry.user,
      isPrimary: entry.isPrimary,
    })),
  };
}

async function replaceRoleRelations(tx, id, body, req) {
  if (Array.isArray(body.permissions)) {
    const permissions = normalizePermissions(body.permissions, req);
    await tx.rolePermission.deleteMany({ where: { roleId: id } });
    if (permissions.length) {
      await tx.rolePermission.createMany({ data: permissions.map((item) => ({ ...item, roleId: id })) });
    }
  }

  if (Array.isArray(body.userIds)) {
    const userIds = normalizeUserIds(body.userIds);
    await tx.userRole.deleteMany({ where: { roleId: id } });
    if (userIds.length) {
      const validUsers = await tx.user.findMany({
        where: { id: { in: userIds }, isDeleted: false },
        select: { id: true },
      });
      await tx.userRole.createMany({
        data: validUsers.map((user, index) => ({
          roleId: id,
          userId: user.id,
          isPrimary: index === 0,
          isActive: true,
          assignedBy: actor(req),
        })),
      });
    }
  }
}

exports.list = async (req, res, next) => {
  try {
    const q = String(req.query.q || "").trim();
    const includeDeleted = String(req.query.isDeleted || "false") === "true";
    const where = {
      isDeleted: includeDeleted,
      ...(q ? {
        OR: [
          { roleCode: { contains: q, mode: "insensitive" } },
          { roleName: { contains: q, mode: "insensitive" } },
          { description: { contains: q, mode: "insensitive" } },
        ],
      } : {}),
    };
    const [items, total] = await Promise.all([
      prisma.role.findMany({ where, include: ROLE_INCLUDE, orderBy: [{ isSystem: "desc" }, { roleName: "asc" }] }),
      prisma.role.count({ where }),
    ]);
    res.json({ items: items.map(mapRole), total });
  } catch (error) {
    next(error);
  }
};

exports.users = async (_req, res, next) => {
  try {
    const users = await prisma.user.findMany({
      where: { isDeleted: false },
      orderBy: [{ fullName: "asc" }, { username: "asc" }],
      select: {
        id: true,
        username: true,
        fullName: true,
        email: true,
        isSuperAdmin: true,
        employee: { select: { fullName: true, position: true } },
        roleAssignments: {
          where: { isActive: true },
          include: { role: { select: { id: true, roleCode: true, roleName: true, isActive: true, isDeleted: true } } },
        },
      },
    });
    res.json({ items: users, total: users.length });
  } catch (error) {
    next(error);
  }
};

exports.get = async (req, res, next) => {
  try {
    const role = await prisma.role.findFirst({
      where: {
        isDeleted: false,
        OR: [{ id: req.params.id }, { roleCode: roleCode(req.params.id) }],
      },
      include: ROLE_INCLUDE,
    });
    if (!role) return res.status(404).json({ message: "Role tidak ditemukan." });
    res.json(mapRole(role));
  } catch (error) {
    next(error);
  }
};

exports.create = async (req, res, next) => {
  try {
    const code = roleCode(req.body.roleCode);
    const name = String(req.body.roleName || "").trim();
    if (!code || !name) return res.status(400).json({ message: "Kode dan nama role wajib diisi." });

    const role = await prisma.$transaction(async (tx) => {
      const created = await tx.role.create({
        data: {
          roleCode: code,
          roleName: name,
          description: req.body.description || null,
          isSystem: req.body.isSystem === true,
          isActive: req.body.isActive !== false,
          createdBy: actor(req),
          updatedBy: actor(req),
        },
      });
      await replaceRoleRelations(tx, created.id, req.body, req);
      return tx.role.findUnique({ where: { id: created.id }, include: ROLE_INCLUDE });
    });
    res.status(201).json(mapRole(role));
  } catch (error) {
    next(error);
  }
};

exports.update = async (req, res, next) => {
  try {
    const existing = await prisma.role.findUnique({ where: { id: req.params.id } });
    if (!existing || existing.isDeleted) return res.status(404).json({ message: "Role tidak ditemukan." });
    const code = req.body.roleCode === undefined ? existing.roleCode : roleCode(req.body.roleCode);
    const name = req.body.roleName === undefined ? existing.roleName : String(req.body.roleName || "").trim();
    if (!code || !name) return res.status(400).json({ message: "Kode dan nama role wajib diisi." });

    const role = await prisma.$transaction(async (tx) => {
      await tx.role.update({
        where: { id: existing.id },
        data: {
          roleCode: code,
          roleName: name,
          description: req.body.description === undefined ? existing.description : req.body.description || null,
          isActive: req.body.isActive === undefined ? existing.isActive : req.body.isActive === true,
          updatedBy: actor(req),
        },
      });
      await replaceRoleRelations(tx, existing.id, req.body, req);
      return tx.role.findUnique({ where: { id: existing.id }, include: ROLE_INCLUDE });
    });
    res.json(mapRole(role));
  } catch (error) {
    next(error);
  }
};

exports.remove = async (req, res, next) => {
  try {
    const role = await prisma.role.findUnique({ where: { id: req.params.id } });
    if (!role || role.isDeleted) return res.status(404).json({ message: "Role tidak ditemukan." });
    if (role.isSystem) return res.status(409).json({ message: "Role sistem tidak dapat dihapus." });
    await prisma.$transaction([
      prisma.role.update({ where: { id: role.id }, data: { isDeleted: true, isActive: false, updatedBy: actor(req) } }),
      prisma.userRole.updateMany({ where: { roleId: role.id }, data: { isActive: false } }),
      prisma.rolePermission.updateMany({ where: { roleId: role.id }, data: { isActive: false, isDeleted: true, updatedBy: actor(req) } }),
    ]);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
};

exports.ALLOWED_ACTIONS = [...ALLOWED_ACTIONS];
