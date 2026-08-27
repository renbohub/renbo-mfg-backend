"use strict";

const crypto = require("node:crypto");
const { loadAdditionalDemandCoverage } = require("./additionalDemandCoverageService");

const TOLERANCE = 0.000001;
const number = (value) => (Number.isFinite(Number(value)) ? Math.max(Number(value), 0) : 0);
const rounded = (value) => {
  const result = Math.round((number(value) + Number.EPSILON) * 1000000) / 1000000;
  return result <= TOLERANCE ? 0 : result;
};
const unique = (values) => [...new Set(values.filter(Boolean))];
const dateValue = (value) => {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};
const monthStart = (month) => new Date(`${month}-01T00:00:00.000Z`);
const monthEnd = (month) => {
  const date = monthStart(month);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0, 23, 59, 59, 999));
};

function conflict(code, message) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 409;
  return error;
}

function deltaSourceKey(baselineMpsNumber, sequence) {
  return `DELTA:${baselineMpsNumber}:${String(sequence).padStart(3, "0")}`;
}

function buildDeltaCoveragePlan({ demands = [], stockCandidates = [], receiptCandidates = [] }) {
  const sortedDemands = [...demands].map((row) => ({ ...row, pendingDeltaQty: rounded(row.pendingDeltaQty) })).filter((row) => row.pendingDeltaQty > TOLERANCE).sort((left, right) => (
    (dateValue(left.requiredDate)?.getTime() || Number.MAX_SAFE_INTEGER) - (dateValue(right.requiredDate)?.getTime() || Number.MAX_SAFE_INTEGER)
      || String(left.customerCode).localeCompare(String(right.customerCode))
      || String(left.baselineLockId).localeCompare(String(right.baselineLockId))
  ));
  const stockPools = [...stockCandidates].map((row) => ({ ...row, remainingQty: rounded(row.availableQty) })).sort((left, right) => String(left.id).localeCompare(String(right.id)));
  const receiptPools = [...receiptCandidates].map((row) => ({ ...row, remainingQty: rounded(row.availableQty) })).sort((left, right) => (
    (dateValue(left.availableDate)?.getTime() || Number.MAX_SAFE_INTEGER) - (dateValue(right.availableDate)?.getTime() || Number.MAX_SAFE_INTEGER)
      || String(left.id).localeCompare(String(right.id))
  ));
  const allocations = [];
  const deltaLines = [];

  const allocatePool = (demand, pool, coverageType, eligible) => {
    let remaining = demand.remainingQty;
    for (const source of pool) {
      if (remaining <= TOLERANCE) break;
      if (source.partCode !== demand.partCode || source.remainingQty <= TOLERANCE || !eligible(source, demand)) continue;
      const qty = rounded(Math.min(remaining, source.remainingQty));
      allocations.push({
        baselineLockId: demand.baselineLockId,
        coverageType,
        qty,
        sourceLineId: source.id,
        sourceNumber: coverageType === "FG_STOCK"
          ? `STOCK:${source.warehouseCode || "-"}:${source.rackCode || "-"}:${source.lotNumber || "-"}`
          : source.moNumber,
        availableDate: source.availableDate || null,
        metadata: coverageType === "FG_STOCK"
          ? { warehouseCode: source.warehouseCode || null, rackCode: source.rackCode || null, lotNumber: source.lotNumber || null }
          : { manufacturingOrderId: source.id, moNumber: source.moNumber },
      });
      source.remainingQty = rounded(source.remainingQty - qty);
      remaining = rounded(remaining - qty);
    }
    demand.remainingQty = remaining;
  };

  for (const sourceDemand of sortedDemands) {
    const demand = { ...sourceDemand, remainingQty: sourceDemand.pendingDeltaQty };
    allocatePool(demand, stockPools, "FG_STOCK", () => true);
    allocatePool(demand, receiptPools, "FIRM_FG_RECEIPT", (source, current) => {
      const available = dateValue(source.availableDate);
      const required = dateValue(current.requiredDate);
      return !available || !required || available <= required;
    });
    if (demand.remainingQty > TOLERANCE) deltaLines.push({ ...sourceDemand, qty: demand.remainingQty });
  }

  const summary = {
    additionalQty: rounded(sortedDemands.reduce((sum, row) => sum + row.pendingDeltaQty, 0)),
    stockQty: rounded(allocations.filter((row) => row.coverageType === "FG_STOCK").reduce((sum, row) => sum + row.qty, 0)),
    firmReceiptQty: rounded(allocations.filter((row) => row.coverageType === "FIRM_FG_RECEIPT").reduce((sum, row) => sum + row.qty, 0)),
    deltaMpsQty: rounded(deltaLines.reduce((sum, row) => sum + row.qty, 0)),
  };
  return {
    demands: sortedDemands,
    allocations,
    deltaLines,
    summary,
    status: deltaLines.length ? "DELTA_REQUIRED" : "COVERED_WITHOUT_PRODUCTION",
  };
}

function fingerprintDeltaPreview(plan) {
  const canonical = {
    demands: [...(plan.demands || [])].map((row) => ({ baselineLockId: row.baselineLockId, partCode: row.partCode, month: row.month, pendingDeltaQty: rounded(row.pendingDeltaQty), requiredDate: dateValue(row.requiredDate)?.toISOString() || null })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    allocations: [...(plan.allocations || [])].map((row) => ({ baselineLockId: row.baselineLockId, coverageType: row.coverageType, qty: rounded(row.qty), sourceLineId: row.sourceLineId, sourceNumber: row.sourceNumber })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    deltaLines: [...(plan.deltaLines || [])].map((row) => ({ baselineLockId: row.baselineLockId, partCode: row.partCode, month: row.month, qty: rounded(row.qty) })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  };
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

async function previewDeltaMps(tx, { lockIds = [] }) {
  const selectedIds = unique(lockIds.map((value) => String(value || "").trim()).filter(Boolean));
  if (!selectedIds.length) throw conflict("DELTA_LOCK_REQUIRED", "Pilih minimal satu scope ADD untuk Preview Delta.");
  const locks = await tx.planningBaselineLock.findMany({ where: { id: { in: selectedIds }, status: "ACTIVE" } });
  if (locks.length !== selectedIds.length) throw conflict("DELTA_LOCK_NOT_FOUND", "Sebagian baseline lock tidak aktif atau tidak ditemukan.");
  const years = unique(locks.map((row) => new Date(row.periodMonth).getUTCFullYear()));
  const coveragePayloads = await Promise.all(years.map((year) => loadAdditionalDemandCoverage(tx, { year, partCodes: unique(locks.map((row) => row.partCode)) })));
  const coverageItems = coveragePayloads.flatMap((payload) => payload.items).filter((row) => selectedIds.includes(row.baselineLockId));
  const demands = coverageItems.filter((row) => row.pendingDeltaQty > TOLERANCE).map((row) => ({
    baselineLockId: row.baselineLockId,
    customerCode: row.customerCode,
    partCode: row.partCode,
    month: row.month,
    pendingDeltaQty: row.pendingDeltaQty,
    requiredDate: [...row.sourceSalesOrders].map((source) => dateValue(source.targetDate)).filter(Boolean).sort((a, b) => a - b)[0] || monthEnd(row.month),
    uomCode: row.uomCode,
    baselineMpsNumber: row.baselineMpsNumber,
    sourceSalesOrders: row.sourceSalesOrders,
  }));
  const partCodes = unique(demands.map((row) => row.partCode));
  const [stockRows, receiptRows, priorAllocations] = partCodes.length ? await Promise.all([
    tx.stockBalance.findMany({
      where: { partCode: { in: partCodes }, isDeleted: false, qtyAvailable: { gt: 0 }, warehouse: { isDeleted: false, availableForProduction: true } },
      orderBy: [{ partCode: "asc" }, { warehouseCode: "asc" }, { rackCode: "asc" }, { lotNumber: "asc" }],
    }),
    tx.manufacturingOrder.findMany({
      where: { isDeleted: false, status: { in: ["Draft", "Planned", "Released", "In Progress"] }, part: { partCode: { in: partCodes } } },
      include: { part: { select: { partCode: true } } },
      orderBy: [{ plannedEndDate: "asc" }, { moNumber: "asc" }],
    }),
    tx.additionalDemandCoverage.findMany({
      where: { status: "ALLOCATED", coverageType: { in: ["FG_STOCK", "FIRM_FG_RECEIPT"] }, sourceLineId: { not: null } },
      select: { coverageType: true, sourceLineId: true, qty: true },
    }),
  ]) : [[], [], []];
  const usedBySource = new Map();
  for (const row of priorAllocations) {
    const key = `${row.coverageType}|${row.sourceLineId}`;
    usedBySource.set(key, rounded((usedBySource.get(key) || 0) + number(row.qty)));
  }
  const stockCandidates = stockRows.map((row) => ({
    id: row.id,
    partCode: row.partCode,
    availableQty: rounded(number(row.qtyAvailable) - number(usedBySource.get(`FG_STOCK|${row.id}`))),
    warehouseCode: row.warehouseCode,
    rackCode: row.rackCode,
    lotNumber: row.lotNumber,
  })).filter((row) => row.availableQty > TOLERANCE);
  const receiptCandidates = receiptRows.map((row) => ({
    id: row.id,
    moNumber: row.moNumber,
    partCode: row.part?.partCode,
    availableQty: rounded(number(row.qtyPlanned) - Math.max(number(row.qtyProduced), number(row.qtyGood)) - number(usedBySource.get(`FIRM_FG_RECEIPT|${row.id}`))),
    availableDate: row.plannedEndDate,
  })).filter((row) => row.availableQty > TOLERANCE);
  const plan = buildDeltaCoveragePlan({ demands, stockCandidates, receiptCandidates });
  return { ...plan, fingerprint: fingerprintDeltaPreview(plan), lockIds: selectedIds };
}

async function nextDeltaIdentity(tx, month, baselineMpsNumber) {
  const prefix = `MPS-${month.replace("-", "")}-D`;
  const rows = await tx.mPS.findMany({ where: { mpsNumber: { startsWith: prefix } }, select: { mpsNumber: true, sourceKey: true } });
  const sequence = rows.reduce((max, row) => Math.max(max, Number(String(row.mpsNumber).slice(prefix.length)) || 0), 0) + 1;
  return { sequence, mpsNumber: `${prefix}${String(sequence).padStart(3, "0")}`, sourceKey: deltaSourceKey(baselineMpsNumber, sequence) };
}

async function createDeltaDocuments(tx, plan, actor) {
  const grouped = new Map();
  for (const line of plan.deltaLines) {
    const key = `${line.month}|${line.baselineMpsNumber}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(line);
  }
  const documents = [];
  for (const [key, lines] of grouped) {
    const [month, baselineMpsNumber] = key.split("|");
    const identity = await nextDeltaIdentity(tx, month, baselineMpsNumber);
    const partRows = await tx.part.findMany({ where: { partCode: { in: unique(lines.map((row) => row.partCode)) }, isDeleted: false }, select: { id: true, partCode: true } });
    const partIdByCode = new Map(partRows.map((row) => [row.partCode, row.id]));
    const byPart = new Map();
    for (const line of lines) {
      if (!byPart.has(line.partCode)) byPart.set(line.partCode, []);
      byPart.get(line.partCode).push(line);
    }
    const doc = await tx.mPS.create({
      data: {
        mpsNumber: identity.mpsNumber,
        mpsName: `Delta MPS ${month} · ${baselineMpsNumber}`,
        sourceKey: identity.sourceKey,
        periodStart: monthStart(month),
        periodEnd: monthEnd(month),
        status: "Draft",
        lifecycleStatus: "DRAFT",
        simulationOnly: false,
        planKind: "DELTA",
        baselineMpsNumber,
        lockedAt: new Date(),
        lockedBy: actor,
        notes: `Additional customer PO coverage linked to ${baselineMpsNumber}`,
        createdBy: actor,
      },
    });
    let lineNumber = 1;
    for (const [partCode, partLines] of [...byPart.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      const qty = rounded(partLines.reduce((sum, row) => sum + row.qty, 0));
      const detail = await tx.mPSDetail.create({
        data: {
          mpsNumber: doc.mpsNumber,
          lineNumber: lineNumber++,
          partCode,
          ...(partIdByCode.get(partCode) ? { partId: partIdByCode.get(partCode) } : {}),
          forecastQty: 0,
          actualSalesOrderQty: qty,
          effectiveDemandQty: qty,
          qtyPlanned: qty,
          openingAvailableQty: 0,
          firmScheduledReceiptQty: 0,
          targetEndingStockQty: 0,
          projectedEndingStockQty: 0,
          startDate: monthStart(month),
          endDate: monthEnd(month),
          demandPolicy: "MTO",
          calculationTrace: { planKind: "DELTA", baselineMpsNumber, lockIds: partLines.map((row) => row.baselineLockId), coverageFingerprint: plan.fingerprint },
          notes: `[ADDITIONAL-PO] ${partLines.map((row) => row.customerCode).join(", ")}`,
        },
      });
      await tx.mPSDemandSource.createMany({
        data: partLines.map((row) => ({
          mpsDetailId: detail.id,
          sourceType: "SALES_ORDER",
          sourceNumber: `ADD:${row.customerCode}`,
          sourceLineId: row.baselineLockId,
          customerCode: row.customerCode,
          periodMonth: monthStart(row.month),
          qty: row.qty,
          uomCode: row.uomCode,
          requiredDate: dateValue(row.requiredDate),
          effectiveRequiredDate: dateValue(row.requiredDate),
          targetDeliveryDate: dateValue(row.requiredDate),
          sourcePegging: row.sourceSalesOrders || [],
        })),
      });
      for (const row of partLines) row.deltaMpsNumber = doc.mpsNumber;
    }
    documents.push(doc);
  }
  return documents;
}

async function generateDeltaMps(tx, { lockIds, expectedFingerprint, idempotencyKey, actor }) {
  const key = String(idempotencyKey || "").trim();
  if (!key) throw conflict("DELTA_IDEMPOTENCY_KEY_REQUIRED", "Idempotency key wajib untuk Generate Delta.");
  const existing = await tx.additionalDemandCoverage.findFirst({ where: { idempotencyKey: { startsWith: `${key}:` } } });
  if (existing) return { ...(await previewDeltaMps(tx, { lockIds })), idempotent: true, createdDocuments: [] };
  const plan = await previewDeltaMps(tx, { lockIds });
  if (expectedFingerprint && expectedFingerprint !== plan.fingerprint) throw conflict("DELTA_SOURCE_CHANGED", "Stock, firm receipt, atau SO berubah setelah Preview Delta. Muat ulang preview.");
  let allocationIndex = 0;
  for (const allocation of plan.allocations) {
    await tx.additionalDemandCoverage.create({
      data: {
        ...allocation,
        idempotencyKey: `${key}:${String(++allocationIndex).padStart(4, "0")}`,
        status: "ALLOCATED",
        allocatedBy: actor || "system",
      },
    });
  }
  const createdDocuments = await createDeltaDocuments(tx, plan, actor || "system");
  for (const line of plan.deltaLines) {
    await tx.additionalDemandCoverage.create({
      data: {
        baselineLockId: line.baselineLockId,
        coverageType: "DELTA_MPS",
        qty: line.qty,
        sourceNumber: line.deltaMpsNumber,
        sourceLineId: line.deltaMpsNumber,
        availableDate: dateValue(line.requiredDate),
        status: "ALLOCATED",
        idempotencyKey: `${key}:${String(++allocationIndex).padStart(4, "0")}`,
        allocatedBy: actor || "system",
        metadata: { baselineMpsNumber: line.baselineMpsNumber, customerCode: line.customerCode, partCode: line.partCode },
      },
    });
  }
  return { ...plan, idempotent: false, createdDocuments };
}

module.exports = {
  buildDeltaCoveragePlan,
  fingerprintDeltaPreview,
  deltaSourceKey,
  previewDeltaMps,
  generateDeltaMps,
};
