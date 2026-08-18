const { prisma } = require("../../index");
const { assertStockBalanceNotFrozen } = require("./utils/stockOpnameFreezeGuard");
const { generateReservationNumber } = require("./utils/stockReservationHelpers");

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
  if (referenceType === "PART_ALLOCATION") result.reservedForPartCode = row.targetPartCode || sourceNumber;
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

const throwHttp = (message, statusCode = 400) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
};

exports.stockOptions = async (req, res, next) => {
  try {
    const q = String(req.query.q || "").trim();
    const items = await prisma.stockBalance.findMany({
      where: {
        isDeleted: false,
        stockType: "Material",
        materialId: { not: null },
        qtyAvailable: { gt: 0 },
        ...(q ? { OR: [
          { materialCode: { contains: q, mode: "insensitive" } },
          { materialName: { contains: q, mode: "insensitive" } },
          { materialType: { contains: q, mode: "insensitive" } },
          { partCode: { contains: q, mode: "insensitive" } },
          { partNumber: { contains: q, mode: "insensitive" } },
          { partName: { contains: q, mode: "insensitive" } },
          { warehouseCode: { contains: q, mode: "insensitive" } },
          { rackCode: { contains: q, mode: "insensitive" } },
          { lotNumber: { contains: q, mode: "insensitive" } },
        ] } : {}),
      },
      select: {
        id: true, warehouseCode: true, rackCode: true, lotNumber: true, stockType: true, uomCode: true,
        partCode: true, partNumber: true, partName: true, materialId: true, materialCode: true,
        materialName: true, materialType: true, qtyOnHand: true, qtyReserved: true, qtyQC: true, qtyAvailable: true,
      },
      orderBy: [{ materialCode: "asc" }, { partCode: "asc" }, { qtyAvailable: "desc" }],
      take: 100,
    });
    res.json({ items: items.map((row) => ({ ...row, freeStockQty: number(row.qtyAvailable) })) });
  } catch (error) { next(error); }
};

exports.partOptions = async (req, res, next) => {
  try {
    const stockBalanceId = String(req.query.stockBalanceId || "").trim();
    if (!stockBalanceId) return res.status(400).json({ message: "Pilih material stock terlebih dahulu." });
    const stock = await prisma.stockBalance.findFirst({
      where: { id: stockBalanceId, isDeleted: false, stockType: "Material", materialId: { not: null } },
      select: { id: true, materialId: true, materialCode: true },
    });
    if (!stock) return res.status(404).json({ message: "Material stock tidak ditemukan." });
    const items = await prisma.part.findMany({
      where: {
        isDeleted: false,
        status: { not: "Inactive" },
        itemType: "RAW",
        rawType: "MATERIAL",
        materialId: stock.materialId,
      },
      select: { id: true, partCode: true, partNumber: true, partName: true, itemType: true, rawType: true },
      orderBy: [{ partNumber: "asc" }, { partCode: "asc" }],
      take: 100,
    });
    res.json({ materialId: stock.materialId, materialCode: stock.materialCode, items });
  } catch (error) { next(error); }
};

exports.create = async (req, res, next) => {
  try {
    const requestedItems = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!requestedItems.length) return res.status(400).json({ message: "Tambahkan minimal satu part number tujuan." });
    if (requestedItems.length > 100) return res.status(400).json({ message: "Maksimal 100 alokasi part dalam satu transaksi." });
    const normalizedItems = requestedItems.map((item) => ({ targetPartCode: String(item?.targetPartCode || "").trim(), qty: number(item?.qty) }));
    if (normalizedItems.some((item) => !item.targetPartCode || !(item.qty > 0))) {
      return res.status(400).json({ message: "Setiap baris wajib memiliki part tujuan dan qty lebih besar dari 0." });
    }
    const duplicate = normalizedItems.find((item, index) => normalizedItems.findIndex((other) => other.targetPartCode === item.targetPartCode) !== index);
    if (duplicate) return res.status(400).json({ message: `Part ${duplicate.targetPartCode} tercatat lebih dari sekali. Gabungkan qty-nya.` });
    const totalQty = normalizedItems.reduce((sum, item) => sum + item.qty, 0);
    const result = await prisma.$transaction(async (tx) => {
      const stockBalanceId = String(req.body?.stockBalanceId || "").trim();
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`STOCK_RESERVATION|${stockBalanceId}`}, 0))`;
      const stock = await tx.stockBalance.findFirst({ where: { id: stockBalanceId, isDeleted: false } });
      if (!stock) throwHttp("Lokasi stock tidak ditemukan.", 404);
      if (stock.stockType !== "Material" || !stock.materialId) throwHttp("Hanya stock Material yang terhubung ke Material Master yang dapat dialokasikan.", 409);
      await assertStockBalanceNotFrozen(tx, stock.id);
      if (number(stock.qtyAvailable) + 0.0000001 < totalQty) {
        throwHttp(`Free stock hanya ${number(stock.qtyAvailable)} ${stock.uomCode || ""}.`, 409);
      }
      const targetParts = await tx.part.findMany({
        where: {
          partCode: { in: normalizedItems.map((item) => item.targetPartCode) },
          isDeleted: false,
          itemType: "RAW",
          rawType: "MATERIAL",
          materialId: stock.materialId,
        },
        select: { partCode: true, partNumber: true, partName: true },
      });
      if (targetParts.length !== normalizedItems.length) {
        const found = new Set(targetParts.map((part) => part.partCode));
        const missing = normalizedItems.filter((item) => !found.has(item.targetPartCode)).map((item) => item.targetPartCode);
        throwHttp(`Part RAW MATERIAL tidak terkait dengan material ${stock.materialCode || stock.materialId}: ${missing.join(", ")}.`, 409);
      }
      const partByCode = new Map(targetParts.map((part) => [part.partCode, part]));
      const reservationDate = req.body?.reservationDate ? new Date(req.body.reservationDate) : new Date();
      if (Number.isNaN(reservationDate.getTime())) throwHttp("Tanggal reservation tidak valid.");
      const expiryValue = String(req.body?.expiryDate || "").trim();
      const expiryDate = expiryValue
        ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(expiryValue) ? `${expiryValue}T23:59:59.999+07:00` : expiryValue)
        : null;
      if (expiryDate && Number.isNaN(expiryDate.getTime())) throwHttp("Expiry date tidak valid.");
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`STOCK_RESERVATION_NUMBER|${reservationDate.toISOString().slice(0, 10)}`}, 0))`;
      const updatedStock = await tx.stockBalance.update({
        where: { id: stock.id },
        data: {
          qtyReserved: number(stock.qtyReserved) + totalQty,
          qtyAvailable: Math.max(number(stock.qtyAvailable) - totalQty, 0),
        },
      });
      const reservations = [];
      for (const item of normalizedItems) {
        const target = partByCode.get(item.targetPartCode);
        const reservationNumber = await generateReservationNumber(tx, reservationDate);
        const created = await tx.stockReservation.create({ data: {
          reservationNumber,
          reservationDate,
          stockBalanceId: stock.id,
          warehouseCode: stock.warehouseCode,
          rackCode: stock.rackCode,
          lotNumber: stock.lotNumber,
          partCode: stock.partCode,
          partNumber: stock.partNumber,
          partName: stock.partName,
          materialId: stock.materialId,
          materialCode: stock.materialCode,
          materialName: stock.materialName,
          materialType: stock.materialType,
          targetPartCode: target.partCode,
          targetPartNumber: target.partNumber,
          targetPartName: target.partName,
          productId: stock.productId,
          description: stock.description,
          spec: stock.spec,
          thickness: stock.thickness,
          width: stock.width,
          CSP: stock.CSP,
          qtyReserved: item.qty,
          referenceType: "PART_ALLOCATION",
          referenceNumber: target.partCode,
          expiryDate,
          notes: [`[MANUAL-PART-ALLOCATION] ${stock.materialCode || stock.partCode || stock.id} -> ${target.partCode}`, String(req.body?.notes || "").trim()].filter(Boolean).join(" | "),
        }, include });
        reservations.push(mapReservation(created));
      }
      return { reservations, stockBalance: updatedStock, totalQty };
    });
    res.status(201).json({ ...result, reservation: result.reservations[0], message: `${result.reservations.length} alokasi berhasil dibuat; total reserve ${result.totalQty} ${result.stockBalance.uomCode || ""}.` });
  } catch (error) { next(error); }
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
        { materialCode: { contains: search, mode: "insensitive" } },
        { materialName: { contains: search, mode: "insensitive" } },
        { targetPartCode: { contains: search, mode: "insensitive" } },
        { targetPartNumber: { contains: search, mode: "insensitive" } },
        { targetPartName: { contains: search, mode: "insensitive" } },
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
    res.json({ item: result, message: "Reservation dibatalkan dan qty kembali menjadi free stock." });
  } catch (error) { next(error); }
};
