const { prisma } = require("../../index");
const { assertStockBalanceNotFrozen } = require("./utils/stockOpnameFreezeGuard");

const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const sourceDocumentNumber = (row) => String(row.referenceNumber || "").split("#")[0] || null;
const sourceLineNumber = (row) => {
  const match = String(row.referenceNumber || "").match(/#(\d+)$/);
  return match ? Number(match[1]) : null;
};

function mapReservation(row) {
  const sourceNumber = sourceDocumentNumber(row);
  const referenceType = String(row.referenceType || "").toUpperCase();
  const result = {
    ...row,
    sourceDocumentNumber: sourceNumber,
    sourceLineNumber: sourceLineNumber(row),
    qtyOpen: Math.max(number(row.qtyReserved) - number(row.qtyReleased), 0),
    uomCode: row.stockBalance?.uomCode || null,
    currentStockOnHand: number(row.stockBalance?.qtyOnHand),
    currentStockReserved: number(row.stockBalance?.qtyReserved),
    currentStockAvailable: number(row.stockBalance?.qtyAvailable),
  };
  if (referenceType === "SO") result.soNumber = sourceNumber;
  if (referenceType === "MANUFACTURING_ORDER" || referenceType === "MO") result.moNumber = sourceNumber;
  if (referenceType === "MPS") result.mpsNumber = sourceNumber;
  return result;
}

const include = {
  stockBalance: {
    select: {
      id: true,
      stockType: true,
      uomCode: true,
      qtyOnHand: true,
      qtyReserved: true,
      qtyQC: true,
      qtyAvailable: true,
      lastMovement: true,
    },
  },
};

exports.list = async (req, res, next) => {
  try {
    const { q, status, type, referenceType, warehouseCode, partCode, page = 1, limit = 20 } = req.query;
    const where = { isDeleted: false };
    if (status) where.status = String(status);
    if (type || referenceType) where.referenceType = String(type || referenceType).toUpperCase();
    if (warehouseCode) where.warehouseCode = String(warehouseCode);
    if (partCode) where.partCode = String(partCode);
    if (q) {
      const search = String(q).trim();
      where.OR = [
        { reservationNumber: { contains: search, mode: "insensitive" } },
        { referenceNumber: { contains: search, mode: "insensitive" } },
        { partCode: { contains: search, mode: "insensitive" } },
        { partNumber: { contains: search, mode: "insensitive" } },
        { partName: { contains: search, mode: "insensitive" } },
        { warehouseCode: { contains: search, mode: "insensitive" } },
        { rackCode: { contains: search, mode: "insensitive" } },
        { lotNumber: { contains: search, mode: "insensitive" } },
      ];
    }
    const take = Math.min(Math.max(Number(limit) || 20, 1), 500);
    const skip = (Math.max(Number(page) || 1, 1) - 1) * take;
    const [items, total] = await Promise.all([
      prisma.stockReservation.findMany({ where, include, orderBy: [{ status: "asc" }, { reservationDate: "desc" }, { createdAt: "desc" }], skip, take }),
      prisma.stockReservation.count({ where }),
    ]);
    res.json({ items: items.map(mapReservation), total });
  } catch (error) { next(error); }
};

exports.get = async (req, res, next) => {
  try {
    const row = await prisma.stockReservation.findFirst({
      where: { reservationNumber: req.params.reservationNumber, isDeleted: false },
      include,
    });
    if (!row) return res.status(404).json({ message: "Stock Reservation tidak ditemukan." });
    res.json(mapReservation(row));
  } catch (error) { next(error); }
};

exports.cancel = async (req, res, next) => {
  try {
    const reason = String(req.body?.reason || "").trim();
    if (!reason) return res.status(400).json({ message: "Alasan manual unreserve wajib diisi." });
    const result = await prisma.$transaction(async (tx) => {
      const reservation = await tx.stockReservation.findFirst({
        where: { reservationNumber: req.params.reservationNumber, isDeleted: false },
        include: { stockBalance: true },
      });
      if (!reservation) throw Object.assign(new Error("Stock Reservation tidak ditemukan."), { statusCode: 404 });
      if (reservation.status !== "Active") throw Object.assign(new Error("Hanya reservation Active yang dapat dibatalkan."), { statusCode: 409 });
      const openQty = Math.max(number(reservation.qtyReserved) - number(reservation.qtyReleased), 0);
      if (openQty > 0 && reservation.stockBalance) {
        await assertStockBalanceNotFrozen(tx, reservation.stockBalance.id);
        const nextReserved = Math.max(number(reservation.stockBalance.qtyReserved) - openQty, 0);
        const nextAvailable = Math.max(number(reservation.stockBalance.qtyOnHand) - nextReserved - number(reservation.stockBalance.qtyQC), 0);
        await tx.stockBalance.update({ where: { id: reservation.stockBalance.id }, data: { qtyReserved: nextReserved, qtyAvailable: nextAvailable } });
      }
      const updated = await tx.stockReservation.update({
        where: { id: reservation.id },
        data: { status: "Cancelled", qtyReleased: number(reservation.qtyReserved), notes: `[MANUAL-UNRESERVE] ${reason}` },
        include,
      });
      return mapReservation(updated);
    });
    res.json({ item: result, message: "Reservation dibatalkan; SO tetap aktif dan line ini tidak akan di-reserve ulang otomatis." });
  } catch (error) { next(error); }
};
