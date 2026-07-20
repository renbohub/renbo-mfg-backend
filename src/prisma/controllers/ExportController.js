const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { prisma } = require("../index");
const { mapDoc } = require("../utils/mapDoc");

const EXPORT_TOKEN_SECRET = process.env.EXPORT_TOKEN_SECRET || process.env.JWT_SECRET || "secret-key";
const EXPORT_TOKEN_EXPIRES_IN = "1y";

const allowedResources = [
  "parts",
  "machines",
  "dies",
  "manufacturing-orders",
  "work-orders",
  "production-logs",
  "downtime-logs",
];

const buildPartsWhere = (query) => {
  const { q, isDeleted, customerCode, category, status, supplierId } = query;
  const where = { isDeleted: isDeleted !== undefined ? isDeleted === "true" : false };

  if (customerCode) {
    where.OR = [{ customerCode }, { customerCodes: { has: customerCode } }];
  }
  if (category) where.category = category;
  if (status) where.status = status;
  if (supplierId) where.supplierId = supplierId;

  if (q) {
    const searchOR = [
      { partCode: { contains: q, mode: "insensitive" } },
      { partNumber: { contains: q, mode: "insensitive" } },
      { partName: { contains: q, mode: "insensitive" } },
      { customerCode: { contains: q, mode: "insensitive" } },
      { noPhp: { contains: q, mode: "insensitive" } },
    ];

    if (where.OR) {
      where.AND = [{ OR: where.OR }, { OR: searchOR }];
      delete where.OR;
    } else {
      where.OR = searchOR;
    }
  }

  return where;
};

const buildMachinesWhere = (query) => {
  const { q, isDeleted, status, machineType } = query;
  const where = { isDeleted: isDeleted !== undefined ? isDeleted === "true" : false };

  if (status) where.status = status;
  if (machineType) where.machineType = machineType;

  if (q) {
    where.OR = [
      { machineCode: { contains: q, mode: "insensitive" } },
      { machineName: { contains: q, mode: "insensitive" } },
      { machineType: { contains: q, mode: "insensitive" } },
      { brand: { contains: q, mode: "insensitive" } },
      { serialNumber: { contains: q, mode: "insensitive" } },
      { location: { contains: q, mode: "insensitive" } },
    ];
  }

  return where;
};

const buildDiesWhere = (query) => {
  const { q, isDeleted, ownerType, customerCode, category, status, warehouseCode } = query;
  const where = { isDeleted: isDeleted !== undefined ? isDeleted === "true" : false };

  if (ownerType) where.ownerType = ownerType;
  if (customerCode) where.customerCode = customerCode;
  if (category) where.category = category;
  if (status) where.status = status;
  if (warehouseCode) where.warehouseCode = warehouseCode;

  if (q) {
    where.OR = [
      { diesCode: { contains: q, mode: "insensitive" } },
      { diesNumber: { contains: q, mode: "insensitive" } },
      { diesName: { contains: q, mode: "insensitive" } },
      { location: { contains: q, mode: "insensitive" } },
    ];
  }

  return where;
};

exports.generateToken = async (req, res, next) => {
  try {
    if (!req.user?.isSuperAdmin) {
      return res.status(403).json({ message: "Hanya super admin yang bisa generate export token" });
    }

    const now = Date.now();
    const jti = crypto.randomUUID();
    const payload = {
      type: "export",
      jti,
      issuedBy: req.user.username,
      iatMs: now,
    };

    const token = jwt.sign(payload, EXPORT_TOKEN_SECRET, { expiresIn: EXPORT_TOKEN_EXPIRES_IN });
    const expiresAt = new Date(now + 365 * 24 * 60 * 60 * 1000).toISOString();

    await prisma.exportToken.create({
      data: {
        jti,
        tokenName: token,
        issuedBy: req.user.username,
        expiresAt: new Date(expiresAt),
      },
    });

    res.json({
      token,
      jti,
      tokenType: "Bearer",
      expiresIn: EXPORT_TOKEN_EXPIRES_IN,
      expiresAt,
      resources: allowedResources,
    });
  } catch (e) {
    next(e);
  }
};

exports.revokeToken = async (req, res, next) => {
  try {
    if (!req.user?.isSuperAdmin) {
      return res.status(403).json({ message: "Hanya super admin yang bisa revoke export token" });
    }

    const { token, jti, note } = req.body || {};
    let targetJti = jti;

    if (!targetJti && token) {
      try {
        const decoded = jwt.verify(token, EXPORT_TOKEN_SECRET, { ignoreExpiration: true });
        targetJti = decoded?.jti;
      } catch (_err) {
        const decodedNoVerify = jwt.decode(token);
        targetJti = decodedNoVerify?.jti;
      }
    }

    if (!targetJti) {
      return res.status(400).json({ message: "jti atau token wajib diisi" });
    }

    const existing = await prisma.exportToken.findUnique({ where: { jti: targetJti } });
    if (!existing) {
      return res.status(404).json({ message: "Export token tidak ditemukan" });
    }

    if (existing.revokedAt) {
      return res.json({ ok: true, message: "Token sudah dalam status revoked", jti: targetJti });
    }

    await prisma.exportToken.update({
      where: { jti: targetJti },
      data: {
        revokedAt: new Date(),
        revokedBy: req.user.username,
        revokeNote: note || null,
      },
    });

    return res.json({ ok: true, message: "Token berhasil di-revoke", jti: targetJti });
  } catch (e) {
    next(e);
  }
};

exports.listTokens = async (req, res, next) => {
  try {
    if (!req.user?.isSuperAdmin) {
      return res.status(403).json({ message: "Hanya super admin yang bisa melihat daftar export token" });
    }

    const { status = "all", q, page = 1, limit = 20 } = req.query;
    const where = {};

    if (status === "active") {
      where.revokedAt = null;
      where.expiresAt = { gt: new Date() };
    } else if (status === "revoked") {
      where.revokedAt = { not: null };
    } else if (status === "expired") {
      where.revokedAt = null;
      where.expiresAt = { lte: new Date() };
    }

    if (q) {
      where.OR = [
        { jti: { contains: q, mode: "insensitive" } },
        { tokenName: { contains: q, mode: "insensitive" } },
        { issuedBy: { contains: q, mode: "insensitive" } },
        { revokedBy: { contains: q, mode: "insensitive" } },
      ];
    }

    const skip = (Number(page) - 1) * Number(limit);
    const take = Number(limit);

    const [items, total] = await Promise.all([
      prisma.exportToken.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take,
        select: {
          id: true,
          jti: true,
          tokenName: true,
          issuedBy: true,
          issuedAt: true,
          expiresAt: true,
          revokedAt: true,
          revokedBy: true,
          revokeNote: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      prisma.exportToken.count({ where }),
    ]);

    return res.json({
      items,
      total,
      page: Number(page),
      limit: take,
    });
  } catch (e) {
    next(e);
  }
};

exports.deleteToken = async (req, res, next) => {
  try {
    if (!req.user?.isSuperAdmin) {
      return res.status(403).json({ message: "Hanya super admin yang bisa menghapus export token" });
    }

    const { jti } = req.params;
    if (!jti) {
      return res.status(400).json({ message: "Parameter token identifier wajib diisi" });
    }

    const existing = await prisma.exportToken.findFirst({
      where: {
        OR: [{ jti }, { id: jti }],
      },
      select: { id: true, jti: true },
    });

    if (!existing) {
      return res.status(404).json({ message: "Export token tidak ditemukan (cek jti/id token)" });
    }

    await prisma.exportToken.delete({ where: { id: existing.id } });
    return res.json({ ok: true, message: "Export token berhasil dihapus", jti: existing.jti, id: existing.id });
  } catch (e) {
    next(e);
  }
};
