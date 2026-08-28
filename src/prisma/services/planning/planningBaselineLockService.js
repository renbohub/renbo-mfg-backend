"use strict";

const crypto = require("node:crypto");

const TOLERANCE = 0.000001;
const GENERATED_PROCESS_PREFIX = "[MRP-PRODUCTION]";
const number = (value) => (Number.isFinite(Number(value)) ? Math.max(Number(value), 0) : 0);
const rounded = (value) => {
  const result = Math.round((number(value) + Number.EPSILON) * 1000000) / 1000000;
  return result <= TOLERANCE ? 0 : result;
};
const monthStart = (value) => {
  const date = value instanceof Date ? value : new Date(value);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
};

function planningConflict(code, message) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 409;
  return error;
}

function allocateTotal(total, groups, weightFor) {
  const target = rounded(total);
  if (!groups.length) return [];
  const weights = groups.map((group) => number(weightFor(group)));
  const weightTotal = weights.reduce((sum, value) => sum + value, 0);
  let allocated = 0;
  return groups.map((group, index) => {
    if (index === groups.length - 1) return rounded(target - allocated);
    const share = weightTotal > TOLERANCE
      ? rounded(target * (weights[index] / weightTotal))
      : rounded(target / groups.length);
    allocated = rounded(allocated + share);
    return share;
  });
}

function buildBaselineRows(documents = []) {
  const rows = [];
  const sortedDocuments = [...documents].sort((left, right) => (
    new Date(left.periodStart) - new Date(right.periodStart)
      || String(left.mpsNumber).localeCompare(String(right.mpsNumber))
  ));

  for (const document of sortedDocuments) {
    for (const detail of [...(document.details || [])]
      .filter((row) => !row.isDeleted && !String(row.notes || "").startsWith(GENERATED_PROCESS_PREFIX))
      .sort((left, right) => String(left.partCode).localeCompare(String(right.partCode)))) {
      const sourceGroups = new Map();
      for (const source of detail.demandSources || []) {
        const customerCode = String(source.customerCode || "UNASSIGNED").trim() || "UNASSIGNED";
        if (!sourceGroups.has(customerCode)) sourceGroups.set(customerCode, { customerCode, forecastRaw: 0, poRaw: 0, sources: [] });
        const group = sourceGroups.get(customerCode);
        if (String(source.sourceType || "").toUpperCase() === "FORECAST") group.forecastRaw += number(source.qty);
        if (String(source.sourceType || "").toUpperCase() === "SALES_ORDER") group.poRaw += number(source.qty);
        group.sources.push({
          sourceType: source.sourceType,
          sourceNumber: source.sourceNumber,
          sourceLineId: source.sourceLineId || null,
          deliveryTargetId: source.deliveryTargetId || null,
          qty: rounded(source.qty),
        });
      }
      if (!sourceGroups.size) {
        const customerCode = String(detail.customerCode || "UNASSIGNED").trim() || "UNASSIGNED";
        sourceGroups.set(customerCode, { customerCode, forecastRaw: number(detail.forecastQty), poRaw: number(detail.actualSalesOrderQty), sources: [] });
      }

      const groups = [...sourceGroups.values()].sort((left, right) => left.customerCode.localeCompare(right.customerCode));
      const forecastAllocations = allocateTotal(detail.forecastQty, groups, (group) => group.forecastRaw);
      const poAllocations = allocateTotal(detail.actualSalesOrderQty, groups, (group) => group.poRaw);
      const efdTotal = number(detail.calculationTrace?.efd?.qty ?? detail.effectiveDemandQty);
      const efdAllocations = allocateTotal(efdTotal, groups, (group, index) => (
        Math.max(group.forecastRaw, group.poRaw, forecastAllocations[index] || 0, poAllocations[index] || 0)
      ));

      groups.forEach((group, index) => {
        rows.push({
          periodMonth: monthStart(document.periodStart),
          customerCode: group.customerCode,
          partCode: detail.partCode,
          uomCode: detail.part?.salesUomCode || detail.part?.baseUomCode || detail.demandSources?.find((source) => source.uomCode)?.uomCode || null,
          forecastQtyLocked: forecastAllocations[index],
          poQtyLocked: poAllocations[index],
          efdQtyLocked: efdAllocations[index],
          baselineMpsNumber: document.mpsNumber,
          sourceSnapshot: {
            mpsId: document.id,
            mpsDetailId: detail.id,
            mpsNumber: document.mpsNumber,
            efdSource: detail.calculationTrace?.efd?.source || null,
            sources: [...group.sources].sort((left, right) => (
              String(left.sourceType).localeCompare(String(right.sourceType))
                || String(left.sourceNumber).localeCompare(String(right.sourceNumber))
                || String(left.sourceLineId).localeCompare(String(right.sourceLineId))
            )),
          },
        });
      });
    }
  }
  return rows;
}

function fingerprintBaselineRows(rows = []) {
  const canonical = [...rows].map((row) => ({
    periodMonth: monthStart(row.periodMonth).toISOString(),
    customerCode: row.customerCode,
    partCode: row.partCode,
    uomCode: row.uomCode || null,
    forecastQtyLocked: rounded(row.forecastQtyLocked),
    poQtyLocked: rounded(row.poQtyLocked),
    efdQtyLocked: rounded(row.efdQtyLocked),
    baselineMpsNumber: row.baselineMpsNumber,
    sourceSnapshot: row.sourceSnapshot || null,
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

async function loadMpsDocuments(tx, mpsNumbers) {
  const numbers = [...new Set((mpsNumbers || []).map((value) => String(value || "").trim()).filter(Boolean))];
  if (!numbers.length) throw planningConflict("BASELINE_MPS_REQUIRED", "Pilih minimal satu MPS untuk dikunci sebagai baseline.");
  const documents = await tx.mPS.findMany({
    where: { mpsNumber: { in: numbers }, isDeleted: false },
    include: {
      details: {
        where: { isDeleted: false },
        include: {
          part: { select: { salesUomCode: true, baseUomCode: true } },
          demandSources: { orderBy: [{ customerCode: "asc" }, { sourceType: "asc" }, { sourceNumber: "asc" }] },
        },
      },
    },
    orderBy: { periodStart: "asc" },
  });
  if (documents.length !== numbers.length) throw planningConflict("BASELINE_MPS_NOT_FOUND", "Sebagian MPS baseline tidak ditemukan.");
  return documents;
}

async function previewBaselineLocks(tx, { mpsNumbers }) {
  const documents = await loadMpsDocuments(tx, mpsNumbers);
  const rows = buildBaselineRows(documents);
  return { rows, fingerprint: fingerprintBaselineRows(rows), mpsNumbers: documents.map((row) => row.mpsNumber) };
}

async function lockBaselineForMps(tx, { mpsNumbers, actor, expectedFingerprint }) {
  const preview = await previewBaselineLocks(tx, { mpsNumbers });
  if (expectedFingerprint && expectedFingerprint !== preview.fingerprint) {
    throw planningConflict("BASELINE_SOURCE_CHANGED", "Sumber EFD berubah setelah Preview. Muat ulang Preview Baseline sebelum Generate.");
  }

  const existingRows = await tx.planningBaselineLock.findMany({
    where: {
      OR: preview.rows.map((row) => ({
        periodMonth: row.periodMonth,
        customerCode: row.customerCode,
        partCode: row.partCode,
      })),
    },
  });
  const existingByScope = new Map(existingRows.map((row) => [
    `${monthStart(row.periodMonth).toISOString()}|${row.customerCode}|${row.partCode}`,
    row,
  ]));
  let createdCount = 0;
  const lockedRows = [];
  for (const row of preview.rows) {
    const scope = `${monthStart(row.periodMonth).toISOString()}|${row.customerCode}|${row.partCode}`;
    const existing = existingByScope.get(scope);
    if (existing) {
      if (existing.status !== "ACTIVE"
        || existing.sourceFingerprint !== preview.fingerprint
        || existing.baselineMpsNumber !== row.baselineMpsNumber) {
        throw planningConflict("BASELINE_ALREADY_LOCKED", `EFD ${row.customerCode}/${row.partCode}/${row.periodMonth.toISOString().slice(0, 7)} sudah mempunyai baseline berbeda.`);
      }
      lockedRows.push(existing);
      continue;
    }
    const created = await tx.planningBaselineLock.create({
      data: {
        ...row,
        sourceFingerprint: preview.fingerprint,
        status: "ACTIVE",
        lockedBy: actor || "system",
      },
    });
    lockedRows.push(created);
    createdCount += 1;
  }

  if (createdCount > 0) {
    await tx.mPS.updateMany({
      where: { mpsNumber: { in: preview.mpsNumbers }, isDeleted: false },
      data: { planKind: "BASELINE", lockedAt: new Date(), lockedBy: actor || "system" },
    });
  }
  return { ...preview, rows: lockedRows, createdCount, idempotent: createdCount === 0 };
}

async function refreshBaselineLocksForMps(tx, { mpsNumbers, actor }) {
  const documents = await loadMpsDocuments(tx, mpsNumbers);
  const rows = buildBaselineRows(documents);
  const fingerprint = fingerprintBaselineRows(rows);
  const documentNumbers = documents.map((row) => row.mpsNumber);
  const scopeFilters = rows.map((row) => ({
    periodMonth: row.periodMonth,
    customerCode: row.customerCode,
    partCode: row.partCode,
  }));
  const existingRows = await tx.planningBaselineLock.findMany({
    where: {
      OR: [
        { baselineMpsNumber: { in: documentNumbers }, status: "ACTIVE" },
        ...scopeFilters,
      ],
    },
  });
  const keyFor = (row) => `${monthStart(row.periodMonth).toISOString()}|${row.customerCode}|${row.partCode}`;
  const existingByScope = new Map(existingRows.map((row) => [keyFor(row), row]));
  const refreshedScopes = new Set();
  const appliedAt = new Date();
  let createdCount = 0;
  let updatedCount = 0;

  for (const row of rows) {
    const scope = keyFor(row);
    refreshedScopes.add(scope);
    const existing = existingByScope.get(scope);
    const sourceSnapshot = {
      ...(row.sourceSnapshot || {}),
      recalculatedAt: appliedAt.toISOString(),
      recalculatedBy: actor || "system",
    };
    if (existing) {
      await tx.planningBaselineLock.update({
        where: { id: existing.id },
        data: {
          uomCode: row.uomCode,
          forecastQtyLocked: row.forecastQtyLocked,
          poQtyLocked: row.poQtyLocked,
          efdQtyLocked: row.efdQtyLocked,
          baselineMpsNumber: row.baselineMpsNumber,
          sourceFingerprint: fingerprint,
          sourceSnapshot,
          status: "ACTIVE",
        },
      });
      updatedCount += 1;
      continue;
    }
    await tx.planningBaselineLock.create({
      data: {
        ...row,
        sourceFingerprint: fingerprint,
        sourceSnapshot,
        status: "ACTIVE",
        lockedBy: actor || "system",
      },
    });
    createdCount += 1;
  }

  for (const existing of existingRows) {
    if (!documentNumbers.includes(existing.baselineMpsNumber) || refreshedScopes.has(keyFor(existing))) continue;
    await tx.planningBaselineLock.update({
      where: { id: existing.id },
      data: {
        forecastQtyLocked: 0,
        poQtyLocked: 0,
        efdQtyLocked: 0,
        sourceFingerprint: fingerprint,
        sourceSnapshot: {
          mpsNumber: existing.baselineMpsNumber,
          sources: [],
          recalculatedAt: appliedAt.toISOString(),
          recalculatedBy: actor || "system",
        },
      },
    });
    updatedCount += 1;
  }

  return { rows, fingerprint, createdCount, updatedCount, appliedAt };
}

async function attachBaselineMrp(tx, { baselineMpsNumber, baselineMrpNumber, actor }) {
  const result = await tx.planningBaselineLock.updateMany({
    where: { baselineMpsNumber, status: "ACTIVE", baselineMrpNumber: null },
    data: { baselineMrpNumber },
  });
  await tx.mRPRun.updateMany({
    where: { runNumber: baselineMrpNumber, mpsNumber: baselineMpsNumber, isDeleted: false },
    data: { planKind: "BASELINE", lockedAt: new Date(), lockedBy: actor || "system" },
  });
  return { attachedCount: result.count };
}

module.exports = {
  buildBaselineRows,
  fingerprintBaselineRows,
  previewBaselineLocks,
  lockBaselineForMps,
  refreshBaselineLocksForMps,
  attachBaselineMrp,
};
