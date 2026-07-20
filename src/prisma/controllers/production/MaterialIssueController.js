const { prisma } = require("../../index");
const { Prisma } = require("@prisma/client");
const { buildSort } = require("../../utils/buildSort");
const { mapDoc } = require("../../utils/mapDoc");
const { generateMovementNumber } = require("../../utils/movementNumberGenerator");
const { parseFilter } = require("../../utils/parseFilter");
const { createWIPEntry } = require("./WIPController");
const {
  IDENTITY_REQUIRED_MESSAGE,
  resolveItemIdentityInput,
  hasItemIdentity,
  buildIdentityWhere,
} = require("../inventory/utils/itemIdentity");
const {
  buildExcludeSpecialRackCondition,
  isSpecialRackCode,
} = require("../inventory/utils/stockReservationHelpers");
const { assertStockBalanceNotFrozen } = require("../inventory/utils/stockOpnameFreezeGuard");

// Generate nomor Material Issue otomatis: MI-YYYYMMDD-001
async function generateIssueNumber() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const datePrefix = `MI-${y}${m}${d}`;

  const last = await prisma.materialIssue.findFirst({
    where: { issueNumber: { startsWith: datePrefix } },
    orderBy: { issueNumber: "desc" },
    select: { issueNumber: true },
  });

  let seq = 1;
  if (last) {
    const parts = last.issueNumber.split("-");
    seq = parseInt(parts[parts.length - 1], 10) + 1;
  }

  return `${datePrefix}-${String(seq).padStart(3, "0")}`;
}

function getAuthenticatedIssuer(user) {
  return user?.username || user?.email || user?.employeeId || user?.fullName || "system";
}

const getDetailItemLabel = (detail = {}) =>
  detail.partCode ||
  detail.partNumber ||
  detail.partName ||
  detail.productCode ||
  detail.product?.productCode ||
  detail.description ||
  detail.spec ||
  `Line ${detail.lineNumber || "?"}`;

const resolveMaterialIssueIdentity = async (tx, detail = {}) => {
  const identity = await resolveItemIdentityInput(tx, detail || {});

  if (!hasItemIdentity(identity)) {
    throw Object.assign(
      new Error(
        `Identitas stock kosong pada item ${getDetailItemLabel(detail)}. ${IDENTITY_REQUIRED_MESSAGE}`,
      ),
      { statusCode: 400 },
    );
  }

  return identity;
};

const mapMaterialIssueDetailInput = async (tx, detail = {}, index = 0, issueId) => {
  const identity = await resolveMaterialIssueIdentity(tx, detail);

  return {
    issueId,
    lineNumber: detail.lineNumber ?? index + 1,
    partCode: identity.partCode ?? null,
    partNumber: identity.partNumber ?? null,
    partName: detail.partName ?? identity.partName ?? null,
    spec: identity.spec ?? null,
    thickness: identity.thickness ?? null,
    width: identity.width ?? null,
    CSP: identity.CSP ?? null,
    productId: identity.productId ?? null,
    description: identity.description ?? null,
    stockBalanceId: detail.stockBalanceId ?? null,
    requirementSource: detail.requirementSource ?? null,
    isSubAssembly: Boolean(detail.isSubAssembly) || detail.requirementSource === "SubAssembly",
    rackCode: detail.rackCode ?? null,
    qtyRequired: detail.qtyRequired,
    qtyIssued: detail.qtyIssued ?? 0,
    qtyReturned: detail.qtyReturned ?? 0,
    uomCode: detail.uomCode ?? null,
    lotNumber: detail.lotNumber ?? null,
    notes: detail.notes ?? null,
  };
};

function formatRelationList(items) {
  return items.filter(Boolean).join(", ");
}

function assertWorkOrderReleasedForMaterialIssue(workOrder) {
  if (!workOrder) {
    throw Object.assign(new Error("Work Order tidak ditemukan."), { statusCode: 404 });
  }
  if (workOrder.status !== "Released") {
    throw Object.assign(
      new Error(
        `Material Issue hanya bisa dibuat untuk WO Released. Status WO ${workOrder.woNumber || ""} sekarang "${workOrder.status}".`,
      ),
      { statusCode: 409 },
    );
  }
}

async function getMaterialIssueDeleteBlockers(tx, issue) {
  const [stockMovementCount, wipEntryCount] = await Promise.all([
    tx.stockMovement.count({
      where: {
        referenceNumber: issue.issueNumber,
        isDeleted: false,
      },
    }),
    tx.wIPEntry.count({
      where: {
        sourceType: "MaterialIssue",
        sourceId: issue.id,
      },
    }),
  ]);

  return [
    !["Draft", "Cancelled"].includes(issue.status) && `status ${issue.status}`,
    stockMovementCount > 0 && `${stockMovementCount} Stock Movement`,
    wipEntryCount > 0 && `${wipEntryCount} WIP Entry`,
  ].filter(Boolean);
}

exports.list = async (req, res, next) => {
  try {
    const {
      q,
      isDeleted,
      page = 1,
      limit = 20,
      moId,
      woId,
      warehouseCode,
      status,
      startDate,
      endDate,
    } = req.query;

    const where = {};

    if (isDeleted !== undefined) {
      where.isDeleted = isDeleted === "true";
    } else {
      where.isDeleted = false;
    }

    if (moId) where.moId = moId;
    if (woId) where.woId = woId;
    if (warehouseCode) where.warehouseCode = warehouseCode;
    const statusFilter = parseFilter(status);
    if (statusFilter) where.status = statusFilter;

    if (startDate || endDate) {
      where.issueDate = {};
      if (startDate) where.issueDate.gte = new Date(startDate);
      if (endDate) where.issueDate.lte = new Date(endDate);
    }

    if (q) {
      where.OR = [
        { issueNumber: { contains: q, mode: "insensitive" } },
        { issuedBy: { contains: q, mode: "insensitive" } },
        { receivedBy: { contains: q, mode: "insensitive" } },
        { notes: { contains: q, mode: "insensitive" } },
      ];
    }

    const orderBy = buildSort(req.query, { defaultSort: { issueDate: "desc" } });
    const skip = (Number(page) - 1) * Number(limit);

    const [items, total] = await Promise.all([
      prisma.materialIssue.findMany({
        where,
        orderBy,
        skip,
        take: Number(limit),
        include: {
          manufacturingOrder: {
            select: {
              moNumber: true,
              status: true,
              part: { select: { partCode: true, partName: true } },
            },
          },
          workOrder: {
            select: {
              woNumber: true,
              status: true,
              plannedQty: true,
              process: { select: { processCode: true, processName: true } },
            },
          },
          warehouse: { select: { warehouseCode: true, warehouseName: true } },
          _count: { select: { details: true } },
        },
      }),
      prisma.materialIssue.count({ where }),
    ]);

    res.json({
      items: items.map(mapDoc),
      total,
      page: Number(page),
      limit: Number(limit),
    });
  } catch (e) {
    next(e);
  }
};

exports.get = async (req, res, next) => {
  try {
    const doc = await prisma.materialIssue.findFirst({
      where: { issueNumber: req.params.issueNumber, isDeleted: false },
      include: {
        manufacturingOrder: {
          select: {
            moNumber: true,
            status: true,
            qtyPlanned: true,
            part: { select: { partCode: true, partNumber: true, partName: true } },
          },
        },
        workOrder: {
          select: {
            woNumber: true,
            status: true,
            plannedQty: true,
            process: { select: { processCode: true, processName: true } },
          },
        },
        warehouse: { select: { warehouseCode: true, warehouseName: true, location: true } },
        details: {
          where: { isDeleted: false },
          orderBy: { lineNumber: "asc" },
          include: {
            product: { select: { productCode: true, productName: true, uomCode: true } },
          },
        },
      },
    });

    if (!doc) return res.status(404).json({ message: "Data Material Issue tidak ditemukan." });
    res.json(mapDoc(doc));
  } catch (e) {
    next(e);
  }
};

exports.create = async (req, res, next) => {
  try {
    const {
      details = [],
      issueNumber: _issueNumber,
      issueDate: _issueDate,
      issuedBy: _issuedBy,
      status: _status,
      ...data
    } = req.body;

    const issueNumber = await generateIssueNumber();

    const doc = await prisma.$transaction(async (tx) => {
      if (!data.woId) {
        throw Object.assign(new Error("WO Number wajib diisi untuk Material Issue."), {
          statusCode: 400,
        });
      }
      const workOrder = await tx.workOrder.findFirst({
        where: { id: data.woId, isDeleted: false },
        select: { id: true, moId: true, woNumber: true, status: true },
      });
      assertWorkOrderReleasedForMaterialIssue(workOrder);
      data.moId = workOrder.moId;

      const created = await tx.materialIssue.create({
        data: {
          ...data,
          issueNumber,
          issueDate: new Date(),
        },
      });

      if (details.length > 0) {
        const detailRows = await Promise.all(
          details.map((detail, index) => mapMaterialIssueDetailInput(tx, detail, index, created.id)),
        );
        await tx.materialIssueDetail.createMany({
          data: detailRows,
        });
      }

      return tx.materialIssue.findUnique({
        where: { id: created.id },
        include: {
          manufacturingOrder: {
            select: { moNumber: true, part: { select: { partCode: true, partName: true } } },
          },
          workOrder: {
            select: { woNumber: true, process: { select: { processCode: true, processName: true } } },
          },
          warehouse: { select: { warehouseCode: true, warehouseName: true } },
          details: {
            where: { isDeleted: false },
            orderBy: { lineNumber: "asc" },
          },
        },
      });
    });

    res.status(201).json(mapDoc(doc));
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return res.status(409).json({ message: "Nomor Material Issue sudah digunakan." });
    }
    if (e.statusCode) return res.status(e.statusCode).json({ message: e.message });
    next(e);
  }
};

exports.update = async (req, res, next) => {
  try {
    const {
      details,
      issueNumber: _issueNumber,
      issueDate: _issueDate,
      issuedBy: _issuedBy,
      status: _status,
      ...data
    } = req.body;

    const updateData = { ...data };

    const existing = await prisma.materialIssue.findFirst({
      where: { issueNumber: req.params.issueNumber, isDeleted: false },
      select: { id: true, status: true },
    });
    if (!existing) return res.status(404).json({ message: "Data Material Issue tidak ditemukan." });
    if (existing.status === "Closed") {
      return res.status(409).json({ message: "Material Issue yang sudah ditutup tidak dapat diubah." });
    }

    const doc = await prisma.$transaction(async (tx) => {
      if (!updateData.woId) {
        throw Object.assign(new Error("WO Number wajib diisi untuk Material Issue."), {
          statusCode: 400,
        });
      }
      const workOrder = await tx.workOrder.findFirst({
        where: { id: updateData.woId, isDeleted: false },
        select: { id: true, moId: true, woNumber: true, status: true },
      });
      assertWorkOrderReleasedForMaterialIssue(workOrder);
      updateData.moId = workOrder.moId;

      const updated = await tx.materialIssue.update({
        where: { id: existing.id },
        data: updateData,
      });

      // Jika details dikirim, hapus yang lama dan buat ulang
      if (Array.isArray(details)) {
        await tx.materialIssueDetail.deleteMany({ where: { issueId: existing.id } });
        if (details.length > 0) {
          const detailRows = await Promise.all(
            details.map((detail, index) => mapMaterialIssueDetailInput(tx, detail, index, existing.id)),
          );
          await tx.materialIssueDetail.createMany({
            data: detailRows,
          });
        }
      }

      return tx.materialIssue.findUnique({
        where: { id: updated.id },
        include: {
          manufacturingOrder: {
            select: { moNumber: true, part: { select: { partCode: true, partName: true } } },
          },
          workOrder: {
            select: { woNumber: true, process: { select: { processCode: true, processName: true } } },
          },
          warehouse: { select: { warehouseCode: true, warehouseName: true } },
          details: {
            where: { isDeleted: false },
            orderBy: { lineNumber: "asc" },
          },
        },
      });
    });

    res.json(mapDoc(doc));
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") {
      return res.status(404).json({ message: "Data Material Issue tidak ditemukan." });
    }
    if (e.statusCode) return res.status(e.statusCode).json({ message: e.message });
    next(e);
  }
};

exports.remove = async (req, res, next) => {
  try {
    const existing = await prisma.materialIssue.findUnique({
      where: { issueNumber: req.params.issueNumber },
      select: { id: true, issueNumber: true, isDeleted: true, status: true },
    });

    if (!existing) return res.status(404).json({ message: "Data Material Issue tidak ditemukan." });
    if (existing.isDeleted) return res.status(409).json({ message: "Data Material Issue sudah dihapus." });

    const blockers = await getMaterialIssueDeleteBlockers(prisma, existing);
    if (blockers.length > 0) {
      return res.status(409).json({
        message: `Material Issue tidak bisa dihapus karena sudah punya data terkait: ${formatRelationList(blockers)}.`,
      });
    }

    await prisma.materialIssue.updateMany({
      where: { id: existing.id, isDeleted: false },
      data: { isDeleted: true },
    });

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

    const records = await prisma.materialIssue.findMany({
      where: { id: { in: ids }, isDeleted: false },
      select: { id: true, issueNumber: true, status: true },
    });

    const deletable = [];
    const skipped = [];
    for (const issue of records) {
      const blockers = await getMaterialIssueDeleteBlockers(prisma, issue);
      if (blockers.length > 0) {
        skipped.push({ issueNumber: issue.issueNumber, reason: formatRelationList(blockers) });
      } else {
        deletable.push(issue);
      }
    }

    if (deletable.length === 0) {
      return res.status(409).json({
        message: "Tidak ada Material Issue yang bisa dihapus. Material Issue hanya bisa dihapus jika Draft/Cancelled dan belum punya transaksi.",
        skipped,
      });
    }

    const result = await prisma.materialIssue.updateMany({
      where: { id: { in: deletable.map((issue) => issue.id) }, isDeleted: false },
      data: { isDeleted: true },
    });

    res.json({ deletedCount: result.count, skipped });
  } catch (e) {
    next(e);
  }
};

// ============================================================
// HELPER ROUTES & STATUS TRANSITIONS
// ============================================================

exports.generateNumber = async (req, res, next) => {
  try {
    const issueNumber = await generateIssueNumber();
    res.json({ issueNumber });
  } catch (e) { next(e); }
};

// Draft → Issued (penerbitan material ke lantai produksi + auto stock deduction)
exports.issue = async (req, res, next) => {
  try {
    const issuedBy = getAuthenticatedIssuer(req.user);
    const existing = await prisma.materialIssue.findUnique({
      where: { issueNumber: req.params.issueNumber },
      include: {
        details: { where: { isDeleted: false } },
        manufacturingOrder: { select: { moNumber: true } },
        workOrder: { select: { id: true, woNumber: true } },
      },
    });
    if (!existing || existing.isDeleted) return res.status(404).json({ message: "Data Material Issue tidak ditemukan." });
    if (existing.status !== "Draft") {
      return res.status(409).json({ message: `Material Issue tidak bisa diterbitkan dari status "${existing.status}".` });
    }

    const doc = await prisma.$transaction(async (tx) => {
      const movementDate = new Date();

      // Kurangi stok per detail line
      for (const detail of existing.details) {
        const qtyToIssue = Number(detail.qtyIssued || 0);
        if (qtyToIssue <= 0) continue;

        const identity = await resolveMaterialIssueIdentity(tx, detail);

        // Cari stock balance berdasarkan sumber yang dipilih dari FE. Jika belum ada,
        // fallback ke warehouse + lot + identitas item yang sama dengan purchasing.
        const balanceWhere = detail.stockBalanceId
          ? {
              id: detail.stockBalanceId,
              warehouseCode: existing.warehouseCode,
              uomCode: detail.uomCode || null,
              isDeleted: false,
            }
          : {
              warehouseCode: existing.warehouseCode,
              ...buildIdentityWhere(identity),
              uomCode: detail.uomCode || null,
              isDeleted: false,
            };
        if (!detail.stockBalanceId && detail.rackCode) balanceWhere.rackCode = detail.rackCode;
        if (detail.lotNumber) balanceWhere.lotNumber = detail.lotNumber;
        if (!detail.stockBalanceId) {
          balanceWhere.AND = [
            ...(balanceWhere.AND || []),
            buildExcludeSpecialRackCondition(),
          ];
        }

        let stockBalance = await tx.stockBalance.findFirst({
          where: balanceWhere,
          orderBy: [{ qtyAvailable: "asc" }, { lastMovement: "asc" }],
          select: { id: true, warehouseCode: true, stockType: true, qtyOnHand: true, qtyReserved: true, qtyAvailable: true,
                    partCode: true, partNumber: true, partName: true,
                    spec: true, thickness: true, width: true, CSP: true,
                    productId: true, description: true, rackCode: true, lotNumber: true, uomCode: true },
        });

        const moNumber = existing.manufacturingOrder?.moNumber || null;
        let activeReservation = null;

        if (moNumber && stockBalance) {
          activeReservation = await tx.stockReservation.findFirst({
            where: {
              stockBalanceId: stockBalance.id,
              referenceType: "MANUFACTURING_ORDER",
              OR: [{ referenceNumber: moNumber }, { referenceNumber: { startsWith: `${moNumber}#` } }],
              status: "Active",
              isDeleted: false,
            },
            orderBy: { createdAt: "asc" },
            select: { id: true, qtyReserved: true, qtyReleased: true },
          });
        }

        if (!stockBalance && moNumber) {
          const reservationWhere = {
            referenceType: "MANUFACTURING_ORDER",
            OR: [{ referenceNumber: moNumber }, { referenceNumber: { startsWith: `${moNumber}#` } }],
            warehouseCode: existing.warehouseCode,
            status: "Active",
            isDeleted: false,
          };
          const reservationPartCode = identity.partCode || detail.partCode;
          if (reservationPartCode) reservationWhere.partCode = reservationPartCode;
          if (identity.productId) reservationWhere.productId = identity.productId;
          if (identity.description) reservationWhere.description = identity.description;
          if (identity.spec) reservationWhere.spec = identity.spec;
          if (identity.thickness != null) reservationWhere.thickness = identity.thickness;
          if (identity.width != null) reservationWhere.width = identity.width;
          if (identity.CSP) reservationWhere.CSP = identity.CSP;
          if (detail.rackCode) reservationWhere.rackCode = detail.rackCode;
          if (detail.lotNumber) reservationWhere.lotNumber = detail.lotNumber;
          if (detail.uomCode) reservationWhere.stockBalance = { uomCode: detail.uomCode };

          let reservation = await tx.stockReservation.findFirst({
            where: reservationWhere,
            orderBy: { createdAt: "asc" },
            include: {
              stockBalance: {
                select: {
                  id: true,
                  warehouseCode: true,
                  stockType: true,
                  qtyOnHand: true,
                  qtyReserved: true,
                  qtyAvailable: true,
                  partCode: true,
                  partNumber: true,
                  partName: true,
                  spec: true,
                  thickness: true,
                  width: true,
                  CSP: true,
                  productId: true,
                  description: true,
                  rackCode: true,
                  lotNumber: true,
                  isDeleted: true,
                  uomCode: true,
                },
              },
            },
          });

          if (!reservation) {
            const broadReservationWhere = {
              referenceType: "MANUFACTURING_ORDER",
              OR: [{ referenceNumber: moNumber }, { referenceNumber: { startsWith: `${moNumber}#` } }],
              warehouseCode: existing.warehouseCode,
              status: "Active",
              isDeleted: false,
            };
            if (detail.stockBalanceId) broadReservationWhere.stockBalanceId = detail.stockBalanceId;
            else if (reservationPartCode) broadReservationWhere.partCode = reservationPartCode;
            if (detail.uomCode) broadReservationWhere.stockBalance = { uomCode: detail.uomCode };

            reservation = await tx.stockReservation.findFirst({
              where: broadReservationWhere,
              orderBy: { createdAt: "asc" },
              include: {
                stockBalance: {
                  select: {
                    id: true,
                    warehouseCode: true,
                    stockType: true,
                    qtyOnHand: true,
                    qtyReserved: true,
                    qtyAvailable: true,
                    partCode: true,
                    partNumber: true,
                    partName: true,
                    spec: true,
                    thickness: true,
                    width: true,
                    CSP: true,
                    productId: true,
                    description: true,
                    rackCode: true,
                    lotNumber: true,
                    isDeleted: true,
                    uomCode: true,
                  },
                },
              },
            });
          }

          if (reservation?.stockBalance && !reservation.stockBalance.isDeleted) {
            const { isDeleted: _isDeleted, ...reservationStockBalance } = reservation.stockBalance;
            stockBalance = reservationStockBalance;
            activeReservation = {
              id: reservation.id,
              qtyReserved: reservation.qtyReserved,
              qtyReleased: reservation.qtyReleased,
            };
          }
        }

        if (!stockBalance) {
          throw new Error(
            `Stok tidak mencukupi untuk ${detail.partCode || detail.description || "item"} ` +
            `(tersedia: 0, dibutuhkan: ${qtyToIssue})`
          );
        }

        if (isSpecialRackCode(stockBalance.rackCode)) {
          throw new Error(
            `Stok ${detail.partCode || detail.description || "item"} berada di special rack ${stockBalance.rackCode} dan tidak boleh dipakai untuk Material Issue produksi`
          );
        }
        const qtyStillReserved = Math.max(
          0,
          Number(activeReservation?.qtyReserved || 0) - Number(activeReservation?.qtyReleased || 0)
        );
        const reservationReleaseQty = Math.min(qtyToIssue, qtyStillReserved);
        const nextReservedQty = Math.max(0, Number(stockBalance.qtyReserved) - reservationReleaseQty);
        const issuableQty = Number(stockBalance.qtyAvailable || 0) + qtyStillReserved;

        if (issuableQty < qtyToIssue) {
          throw new Error(
            `Stok tidak mencukupi untuk ${detail.partCode || detail.description || "item"} ` +
            `(bisa issue: ${issuableQty}, dibutuhkan: ${qtyToIssue})`
          );
        }

        const qtyBefore = Number(stockBalance.qtyOnHand);
        const qtyAfter = qtyBefore - qtyToIssue;

        // Buat stock movement OUT
        const movementNumber = await generateMovementNumber("OUT", tx);
        await tx.stockMovement.create({
          data: {
            movementNumber,
            movementDate,
            movementType: "OUT",
            direction: "OUT",
            transactionType: "PRODUCTION",
            warehouseCode: existing.warehouseCode,
            rackCode: stockBalance.rackCode || detail.rackCode || null,
            lotNumber: stockBalance.lotNumber || null,
            partCode: stockBalance.partCode || null,
            partNumber: identity.partNumber || stockBalance.partNumber || null,
            partName: detail.partName || identity.partName || stockBalance.partName || null,
            spec: identity.spec || stockBalance.spec || null,
            thickness: identity.thickness ?? stockBalance.thickness ?? null,
            width: identity.width ?? stockBalance.width ?? null,
            CSP: identity.CSP || stockBalance.CSP || null,
            productId: stockBalance.productId || null,
            description: stockBalance.description || identity.description || null,
            qty: qtyToIssue,
            deltaQty: -qtyToIssue,
            qtyBefore,
            qtyAfter,
            uomCode: detail.uomCode || null,
            referenceType: "WORK_ORDER",
            referenceNumber: existing.workOrder?.woNumber || existing.issueNumber,
            notes: `Material Issue untuk WO ${existing.workOrder?.woNumber || ""}`,
            performedBy: issuedBy || "system",
          },
        });

        if (activeReservation && reservationReleaseQty > 0) {
          const nextReleasedQty = Number(activeReservation.qtyReleased || 0) + reservationReleaseQty;
          await tx.stockReservation.update({
            where: { id: activeReservation.id },
            data: {
              qtyReleased: nextReleasedQty,
              status: nextReleasedQty >= Number(activeReservation.qtyReserved || 0) ? "Released" : "Active",
            },
          });
        }

        // Update stock balance. Reservation ikut dilepas karena barang sudah keluar dari gudang.
        await assertStockBalanceNotFrozen(tx, stockBalance.id);
        await tx.stockBalance.update({
          where: { id: stockBalance.id },
          data: {
            qtyOnHand: qtyAfter,
            qtyReserved: nextReservedQty,
            qtyAvailable: qtyAfter - nextReservedQty,
            lastMovement: movementDate,
          },
        });

        // Catat WIP Entry — material cost masuk WIP
        await createWIPEntry(tx, {
          entryDate: movementDate,
          moId: existing.moId,
          woId: existing.woId || null,
          costType: "Material",
          sourceType: "MaterialIssue",
          sourceId: existing.id,
          sourceRef: existing.issueNumber,
          partCode: identity.partCode || null,
          partNumber: identity.partNumber || null,
          partName: identity.partName || identity.description || null,
          uomCode: detail.uomCode || null,
          warehouseCode: stockBalance.warehouseCode || null,
          rackCode: stockBalance.rackCode || null,
          lotNumber: stockBalance.lotNumber || null,
          stockType: stockBalance.stockType || null,
          qty: qtyToIssue,
          rate: 0, // Bisa diisi dari price list nanti
          amount: 0, // Bisa diisi dari price list nanti
          direction: "IN",
          notes: `Material ${identity.partCode || identity.partNumber || identity.description || ""} issued`,
          createdBy: issuedBy || "system",
        });
      }

      // Update status MI
      const updatedIssue = await tx.materialIssue.update({
        where: { id: existing.id },
        data: {
          status: "Issued",
          issueDate: movementDate,
          issuedBy: issuedBy || undefined,
        },
        include: {
          manufacturingOrder: { select: { moNumber: true } },
          warehouse: { select: { warehouseCode: true, warehouseName: true } },
          details: { where: { isDeleted: false }, orderBy: { lineNumber: "asc" } },
        },
      });

      if (existing.woId) {
        await tx.workOrder.updateMany({
          where: {
            id: existing.woId,
            isDeleted: false,
            status: "Released",
          },
          data: { status: "Material Issued" },
        });
      }

      return updatedIssue;
    });

    res.json(mapDoc(doc));
  } catch (e) {
    if (e.message?.startsWith("Stok tidak mencukupi")) {
      return res.status(409).json({ message: e.message });
    }
    next(e);
  }
};

// Issued / Partially Returned → Closed (+ proses pengembalian stok jika ada qtyReturned)
exports.close = async (req, res, next) => {
  try {
    const existing = await prisma.materialIssue.findUnique({
      where: { issueNumber: req.params.issueNumber },
      include: {
        details: { where: { isDeleted: false } },
        manufacturingOrder: { select: { moNumber: true } },
        workOrder: { select: { woNumber: true } },
      },
    });
    if (!existing || existing.isDeleted) return res.status(404).json({ message: "Data Material Issue tidak ditemukan." });
    if (![ "Issued", "Partially Returned" ].includes(existing.status)) {
      return res.status(409).json({ message: `Material Issue tidak bisa ditutup dari status "${existing.status}".` });
    }

    const doc = await prisma.$transaction(async (tx) => {
      const movementDate = new Date();

      // Proses pengembalian stok untuk setiap detail yang punya qtyReturned > 0
      for (const detail of existing.details) {
        const qtyToReturn = Number(detail.qtyReturned || 0);
        if (qtyToReturn <= 0) continue;

        const identity = await resolveMaterialIssueIdentity(tx, detail);

        // Cari stock balance berdasarkan sumber yang dipilih dari FE. Jika belum ada,
        // fallback ke warehouse + lot + identitas item yang sama dengan purchasing.
        const balanceWhere = detail.stockBalanceId
          ? {
              id: detail.stockBalanceId,
              warehouseCode: existing.warehouseCode,
              uomCode: detail.uomCode || null,
              isDeleted: false,
            }
          : {
              warehouseCode: existing.warehouseCode,
              ...buildIdentityWhere(identity),
              uomCode: detail.uomCode || null,
              isDeleted: false,
            };
        if (!detail.stockBalanceId && detail.rackCode) balanceWhere.rackCode = detail.rackCode;
        if (detail.lotNumber) balanceWhere.lotNumber = detail.lotNumber;

        let stockBalance = await tx.stockBalance.findFirst({
          where: balanceWhere,
          select: { id: true, qtyOnHand: true, qtyReserved: true, partCode: true, partNumber: true, partName: true,
                    spec: true, thickness: true, width: true, CSP: true,
                    productId: true, description: true, rackCode: true, lotNumber: true, uomCode: true },
        });

        const qtyBefore = Number(stockBalance?.qtyOnHand || 0);
        const qtyAfter  = qtyBefore + qtyToReturn;

        // Buat stock movement IN (return material ke gudang)
        const movementNumber = await generateMovementNumber("IN", tx);
        await tx.stockMovement.create({
          data: {
            movementNumber,
            movementDate,
            movementType: "IN",
            direction: "IN",
            transactionType: "RETURN",
            warehouseCode: existing.warehouseCode,
            rackCode: stockBalance?.rackCode || detail.rackCode || null,
            lotNumber: stockBalance?.lotNumber || detail.lotNumber || null,
            partCode: identity.partCode || stockBalance?.partCode || null,
            partNumber: identity.partNumber || stockBalance?.partNumber || null,
            partName: detail.partName || identity.partName || stockBalance?.partName || null,
            spec: identity.spec || stockBalance?.spec || null,
            thickness: identity.thickness ?? stockBalance?.thickness ?? null,
            width: identity.width ?? stockBalance?.width ?? null,
            CSP: identity.CSP || stockBalance?.CSP || null,
            productId: identity.productId || stockBalance?.productId || null,
            description: stockBalance?.description || identity.description || null,
            qty: qtyToReturn,
            deltaQty: qtyToReturn,
            qtyBefore,
            qtyAfter,
            uomCode: detail.uomCode || null,
            referenceType: existing.workOrder?.woNumber ? "WORK_ORDER" : "MANUFACTURING_ORDER",
            referenceNumber: existing.workOrder?.woNumber || existing.manufacturingOrder?.moNumber || existing.issueNumber,
            notes: `Return material MI ${existing.issueNumber} ke gudang`,
            performedBy: req.user?.username || "system",
          },
        });

        // Update atau buat stock balance
        if (stockBalance) {
          await assertStockBalanceNotFrozen(tx, stockBalance.id);
          await tx.stockBalance.update({
            where: { id: stockBalance.id },
            data: {
              qtyOnHand: qtyAfter,
              qtyAvailable: qtyAfter - Number(stockBalance.qtyReserved || 0),
              lastMovement: movementDate,
            },
          });
        } else {
          // Balance tidak ada → buat baru
          await tx.stockBalance.create({
            data: {
              warehouseCode: existing.warehouseCode,
              rackCode: detail.rackCode || null,
              partCode: identity.partCode || null,
              partNumber: identity.partNumber || null,
              partName: detail.partName || identity.partName || null,
              spec: identity.spec || null,
              thickness: identity.thickness ?? null,
              width: identity.width ?? null,
              CSP: identity.CSP || null,
              productId: identity.productId || null,
              description: identity.description || null,
              lotNumber: detail.lotNumber || null,
              uomCode: detail.uomCode || null,
              qtyOnHand: qtyToReturn,
              qtyReserved: 0,
              qtyAvailable: qtyToReturn,
              lastMovement: movementDate,
            },
          });
        }
      }

      return tx.materialIssue.update({
        where: { id: existing.id },
        data: { status: "Closed" },
      });
    });

    res.json(mapDoc(doc));
  } catch (e) { next(e); }
};
