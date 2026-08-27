"use strict";

const crypto = require("crypto");
const { aggregateYearlyDemand } = require("./yearlyDemandService");
const { buildPhaseLeadTimes, leadTimeSummary } = require("./monthlyDemandLeadTimeService");

const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const roundQty = (value) => Math.round((number(value) + Number.EPSILON) * 1000000) / 1000000;
const text = (value) => String(value ?? "").trim();
const unique = (values) => [...new Set(values.filter(Boolean))];
const iso = (value) => value ? new Date(value).toISOString() : null;
const monthKey = (value) => iso(value)?.slice(0, 7) || null;
const statusError = (message, statusCode = 400, code = null) => Object.assign(new Error(message), { statusCode, code });

function parsePeriod(value) {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(text(value));
  if (!match) throw statusError("Periode wajib menggunakan format YYYY-MM.", 400, "INVALID_PERIOD");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const start = new Date(Date.UTC(year, month - 1, 1));
  const endExclusive = new Date(Date.UTC(year, month, 1));
  const end = new Date(endExclusive.getTime() - 1);
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const yearEnd = new Date(Date.UTC(year + 1, 0, 1));
  const defaultCutoff = new Date(start.getTime() - 1);
  return { key: match[0], year, month, start, end, endExclusive, yearStart, yearEnd, defaultCutoff };
}

function maxDate(values, fallback = new Date(0)) {
  return values.filter(Boolean).map((value) => new Date(value)).filter((value) => !Number.isNaN(value.getTime())).reduce((max, value) => value > max ? value : max, fallback);
}

function sourceFingerprint(forecasts, sales) {
  const rows = [...forecasts.map((row) => ({
    type: "FORECAST", id: row.id, source: row.sourceNumber, line: row.sourceLineId, phase: row.phaseNumber,
    customer: row.customerCode, part: row.partCode, date: iso(row.targetDate), qty: roundQty(row.qty),
    headerStatus: row.forecastDetail?.forecast?.status, current: row.forecastDetail?.forecast?.isCurrentVersion, updatedAt: iso(row.updatedAt),
  })), ...sales.map((row) => ({
    type: "SALES_ORDER", id: row.id, source: row.sourceNumber, line: row.sourceLineId, phase: row.phaseNumber,
    customer: row.customerCode, part: row.partCode, date: iso(row.targetDate), qty: roundQty(row.qty),
    headerStatus: row.soDetail?.soHeader?.status, detailStatus: row.soDetail?.status, updatedAt: iso(row.updatedAt),
  }))].sort((left, right) => `${left.type}|${left.id}`.localeCompare(`${right.type}|${right.id}`));
  return crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

function compactTarget(row, headerStatus) {
  return {
    id: row.id,
    sourceType: row.sourceType,
    sourceNumber: row.sourceNumber,
    sourceLineId: row.sourceLineId,
    phaseNumber: row.phaseNumber,
    customerCode: row.customerCode || null,
    partCode: row.partCode,
    targetDate: iso(row.targetDate),
    qty: roundQty(row.qty),
    uomCode: row.uomCode || null,
    consumesForecastTargetId: row.consumesForecastTargetId || null,
    headerStatus: headerStatus || null,
    updatedAt: iso(row.updatedAt),
  };
}

function dailyDemandMetrics(sourceTrace = {}, periodValue) {
  const period = typeof periodValue === "string" ? parsePeriod(periodValue) : periodValue;
  const trace = sourceTrace && typeof sourceTrace === "object" ? sourceTrace : {};
  const daily = {};
  for (let cursor = new Date(period.start); cursor < period.endExclusive; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    daily[cursor.toISOString().slice(0, 10)] = { fcc: 0, po: 0, eff: 0 };
  }
  const add = (rows, dateField, metric) => {
    for (const row of Array.isArray(rows) ? rows : []) {
      const key = iso(row?.[dateField])?.slice(0, 10);
      if (!key || !daily[key]) continue;
      daily[key][metric] = roundQty(daily[key][metric] + number(row.qty));
    }
  };
  add(trace.fccTargets, "targetDate", "fcc");
  add(trace.poTargets, "targetDate", "po");
  add(trace.effectiveDeliveryPhases, "targetDeliveryDate", "eff");
  return daily;
}

function readinessFor(item, part, selectedForecasts, phasePlanning) {
  const issues = [];
  if (!part) issues.push({ code: "PART_MASTER_MISSING", severity: "BLOCKER", message: "Part belum terhubung ke Part Master." });
  if (!item.uomCode) issues.push({ code: "UOM_MISSING", severity: "BLOCKER", message: "UOM demand belum tersedia." });
  if (part?.canManufacture && String(part.itemType || "").toUpperCase() === "FG" && !(part.mbomHeaders || []).length) {
    issues.push({ code: "ACTIVE_MBOM_MISSING", severity: "BLOCKER", message: "FG belum memiliki MBOM yang efektif pada periode ini." });
  }
  if (selectedForecasts.some((row) => row.forecastDetail?.forecast?.status === "Draft")) {
    issues.push({ code: "FCC_DRAFT", severity: "WARNING", message: "FCC masih Draft; snapshot approval akan menjadi kontrol komitmennya." });
  }
  if (number(item.unplannedPoQty) > 0) issues.push({ code: "UNPLANNED_PO", severity: "WARNING", message: `Ada PO firm ${roundQty(item.unplannedPoQty)} yang tidak memiliki FCC pasangan.` });
  if (!item.customerCodes.length) issues.push({ code: "CUSTOMER_MISSING", severity: "WARNING", message: "Customer belum teridentifikasi pada sumber demand." });
  if (number(phasePlanning?.incompleteCount) > 0) {
    issues.push({ code: "LEAD_TIME_MASTER_INCOMPLETE", severity: "BLOCKER", message: `${phasePlanning.incompleteCount} fase belum dapat dihitung karena MBOM, routing, vendor, atau supplier belum lengkap.` });
  }
  if (number(phasePlanning?.lateCount) > 0) {
    issues.push({ code: "DELIVERY_PHASE_LATE", severity: "BLOCKER", message: `${phasePlanning.lateCount} fase tidak feasible terhadap tanggal delivery berdasarkan lead time dan supply saat ini.` });
  }
  if (number(phasePlanning?.previousMonthPhaseCount) > 0) {
    issues.push({ code: "START_PREVIOUS_MONTH", severity: "WARNING", message: `${phasePlanning.previousMonthPhaseCount} fase / ${roundQty(phasePlanning.previousMonthQty)} qty harus mulai produksi pada bulan sebelumnya.` });
  }
  if (number(phasePlanning?.atRiskCount) > 0) {
    issues.push({ code: "LEAD_TIME_AT_RISK", severity: "WARNING", message: `${phasePlanning.atRiskCount} fase membutuhkan perhatian material atau percepatan procurement.` });
  }
  const readinessStatus = issues.some((issue) => issue.severity === "BLOCKER") ? "BLOCKED" : issues.length ? "WARNING" : "READY";
  return { readinessStatus, readinessIssues: issues };
}

async function buildLiveMonthlyDemand(prisma, periodValue) {
  const period = parsePeriod(periodValue);
  const targetWhere = { isDeleted: false, status: "ACTIVE", targetDate: { gte: period.yearStart, lt: period.yearEnd } };
  const [rawForecasts, rawSales] = await Promise.all([
    prisma.demandDeliveryTarget.findMany({
      where: { ...targetWhere, sourceType: "FORECAST" },
      include: { forecastDetail: { include: { forecast: true } } },
      orderBy: [{ targetDate: "asc" }, { sourceNumber: "asc" }, { phaseNumber: "asc" }],
    }),
    prisma.demandDeliveryTarget.findMany({
      where: { ...targetWhere, sourceType: "SALES_ORDER" },
      include: { soDetail: { include: { soHeader: true } } },
      orderBy: [{ targetDate: "asc" }, { sourceNumber: "asc" }, { phaseNumber: "asc" }],
    }),
  ]);
  const forecasts = rawForecasts.filter((row) => row.forecastDetail && !row.forecastDetail.isDeleted && row.forecastDetail.forecast && !row.forecastDetail.forecast.isDeleted && row.forecastDetail.forecast.isCurrentVersion && row.forecastDetail.forecast.status !== "Obsolete");
  const sales = rawSales.filter((row) => row.soDetail && !row.soDetail.isDeleted && row.soDetail.status !== "Cancelled" && row.soDetail.soHeader && !row.soDetail.soHeader.isDeleted && !["Draft", "Cancelled", "Superseded"].includes(row.soDetail.soHeader.status));
  const partCodes = unique([...forecasts, ...sales].map((row) => row.partCode));
  const parts = partCodes.length ? await prisma.part.findMany({
    where: { partCode: { in: partCodes }, isDeleted: false },
    select: {
      partCode: true, partNumber: true, partName: true, planningPolicy: true, baseUomCode: true, salesUomCode: true,
      itemType: true, canManufacture: true,
      mbomHeaders: {
        where: {
          isDeleted: false,
          AND: [
            { OR: [{ effectiveDate: null }, { effectiveDate: { lte: period.end } }] },
            { OR: [{ expiryDate: null }, { expiryDate: { gte: period.start } }] },
          ],
        },
        orderBy: [{ revision: "desc" }, { updatedAt: "desc" }],
        select: { id: true, noReg: true, revision: true, effectiveDate: true, expiryDate: true },
      },
    },
  }) : [];
  const partByCode = new Map(parts.map((part) => [part.partCode, part]));
  const yearlyRows = aggregateYearlyDemand({ year: period.year, forecastTargets: forecasts, salesOrderTargets: sales, parts });
  const phaseLeadTimes = await buildPhaseLeadTimes(prisma, { forecasts, sales, parts, period });
  const phasesByPart = new Map();
  for (const phase of phaseLeadTimes) {
    const bucket = phasesByPart.get(phase.partCode) || [];
    bucket.push(phase);
    phasesByPart.set(phase.partCode, bucket);
  }
  const items = yearlyRows.filter((row) => number(row.months[period.key]?.fcc) > 0 || number(row.months[period.key]?.po) > 0 || number(row.months[period.key]?.eff) > 0).map((row) => {
    const metric = row.months[period.key];
    const selectedForecasts = forecasts.filter((target) => target.partCode === row.partCode && monthKey(target.targetDate) === period.key);
    const selectedSales = sales.filter((target) => target.partCode === row.partCode && monthKey(target.targetDate) === period.key);
    const relevant = [...selectedForecasts, ...selectedSales];
    const sourceUpdatedAt = maxDate(relevant.map((target) => target.updatedAt), new Date(0));
    const deliveryPhases = phasesByPart.get(row.partCode) || [];
    const phasePlanning = leadTimeSummary(deliveryPhases);
    const readiness = readinessFor({ ...row, unplannedPoQty: metric.unplannedPo }, partByCode.get(row.partCode), selectedForecasts, phasePlanning);
    return {
      partCode: row.partCode,
      partNumber: row.partNumber,
      partName: row.partName,
      customerCodes: row.customerCodes,
      uomCode: row.uomCode,
      planningPolicy: row.planningPolicy,
      fccQty: roundQty(metric.fcc),
      poFirmQty: roundQty(metric.po),
      consumedFccQty: roundQty(metric.consumedFcc),
      poEffectiveQty: roundQty(metric.poEffective),
      unplannedPoQty: roundQty(metric.unplannedPo),
      effQty: roundQty(metric.eff),
      deliveryPhaseCount: relevant.length,
      effectivePhaseCount: deliveryPhases.length,
      phasePlanning,
      ...readiness,
      sourceUpdatedAt: sourceUpdatedAt.getTime() ? sourceUpdatedAt : null,
      sourceTrace: {
        period: period.key,
        formula: {
          expression: "EFF = (FCC - FCC consumed) + PO effective",
          values: {
            fccQty: roundQty(metric.fcc), consumedFccQty: roundQty(metric.consumedFcc),
            poFirmQty: roundQty(metric.po), poEffectiveQty: roundQty(metric.poEffective),
            poPullInQty: roundQty(metric.poPullIn), poPullOutQty: roundQty(metric.poPullOut),
            unplannedPoQty: roundQty(metric.unplannedPo), effQty: roundQty(metric.eff),
          },
        },
        fccTargets: selectedForecasts.map((target) => compactTarget(target, target.forecastDetail?.forecast?.status)),
        poTargets: selectedSales.map((target) => compactTarget(target, target.soDetail?.soHeader?.status)),
        leadTimePolicy: {
          expression: "Delivery - dispatch - BOM/routing lead time - material staging - procurement lead time",
          note: "Perhitungan per fase EFF menggunakan MBOM bertingkat, proses in-house/vendor, supplier, stock dan open supply.",
        },
        effectiveDeliveryPhases: deliveryPhases,
        effectiveSources: metric.lineage?.effectiveSources || { values: [], count: 0, truncated: false },
      },
    };
  }).sort((left, right) => String(left.partNumber || left.partCode).localeCompare(String(right.partNumber || right.partCode)));
  const totals = items.reduce((sum, item) => {
    for (const field of ["fccQty", "poFirmQty", "consumedFccQty", "unplannedPoQty", "effQty"]) sum[field] += number(item[field]);
    return sum;
  }, { fccQty: 0, poFirmQty: 0, consumedFccQty: 0, unplannedPoQty: 0, effQty: 0 });
  for (const key of Object.keys(totals)) totals[key] = roundQty(totals[key]);
  const relevantPartCodes = new Set(items.map((item) => item.partCode));
  const relevantForecasts = forecasts.filter((row) => relevantPartCodes.has(row.partCode));
  const relevantSales = sales.filter((row) => relevantPartCodes.has(row.partCode));
  const sourceMaximum = maxDate([...relevantForecasts, ...relevantSales].map((row) => row.updatedAt), new Date(0));
  const sourceDataAsOf = sourceMaximum.getTime() ? sourceMaximum : new Date();
  return {
    period,
    items,
    totals,
    summary: {
      partCount: items.length,
      blockedCount: items.filter((item) => item.readinessStatus === "BLOCKED").length,
      warningCount: items.filter((item) => item.readinessStatus === "WARNING").length,
      readyCount: items.filter((item) => item.readinessStatus === "READY").length,
      previousMonthStartPartCount: items.filter((item) => number(item.phasePlanning?.previousMonthPhaseCount) > 0).length,
      previousMonthQty: roundQty(items.reduce((sum, item) => sum + number(item.phasePlanning?.previousMonthQty), 0)),
      latePhaseCount: items.reduce((sum, item) => sum + number(item.phasePlanning?.lateCount), 0),
      incompletePhaseCount: items.reduce((sum, item) => sum + number(item.phasePlanning?.incompleteCount), 0),
    },
    customerOptions: unique(items.flatMap((item) => item.customerCodes)).sort(),
    sourceDataAsOf,
    sourceFingerprint: sourceFingerprint(relevantForecasts, relevantSales),
  };
}

function snapshotHeaderData(live, input, revision, actor, baseSnapshotId = null) {
  const cutoff = input.cutoffDate ? new Date(input.cutoffDate) : live.period.defaultCutoff;
  if (Number.isNaN(cutoff.getTime())) throw statusError("Cut-off date tidak valid.");
  return {
    snapshotNumber: `MDS-${live.period.year}${String(live.period.month).padStart(2, "0")}-R${String(revision).padStart(2, "0")}`,
    periodYear: live.period.year,
    periodMonth: live.period.month,
    periodStart: live.period.start,
    periodEnd: live.period.end,
    cutoffDate: cutoff,
    revision,
    status: "DRAFT",
    baseSnapshotId,
    isCurrentRevision: true,
    sourceDataAsOf: live.sourceDataAsOf,
    sourceFingerprint: live.sourceFingerprint,
    partCount: live.summary.partCount,
    blockedCount: live.summary.blockedCount,
    warningCount: live.summary.warningCount,
    totalFccQty: live.totals.fccQty,
    totalPoFirmQty: live.totals.poFirmQty,
    totalConsumedFccQty: live.totals.consumedFccQty,
    totalUnplannedPoQty: live.totals.unplannedPoQty,
    totalEffQty: live.totals.effQty,
    notes: text(input.notes) || null,
    createdBy: actor,
    updatedBy: actor,
  };
}

function snapshotDetailData(item, lineNumber, previous = null) {
  return {
    lineNumber,
    partCode: item.partCode,
    partNumber: item.partNumber || null,
    partName: item.partName || null,
    customerCodes: item.customerCodes,
    uomCode: item.uomCode || null,
    planningPolicy: item.planningPolicy || null,
    fccQty: item.fccQty,
    poFirmQty: item.poFirmQty,
    consumedFccQty: item.consumedFccQty,
    poEffectiveQty: item.poEffectiveQty,
    unplannedPoQty: item.unplannedPoQty,
    effQty: item.effQty,
    deltaFccQty: roundQty(item.fccQty - number(previous?.fccQty)),
    deltaPoFirmQty: roundQty(item.poFirmQty - number(previous?.poFirmQty)),
    deltaEffQty: roundQty(item.effQty - number(previous?.effQty)),
    deliveryPhaseCount: item.deliveryPhaseCount,
    readinessStatus: item.readinessStatus,
    readinessIssues: item.readinessIssues,
    sourceTrace: item.sourceTrace,
    sourceUpdatedAt: item.sourceUpdatedAt,
  };
}

async function createSnapshot(prisma, input, actor) {
  const live = await buildLiveMonthlyDemand(prisma, input.month);
  if (!live.items.length) throw statusError("Tidak ada FCC atau PO firm pada periode ini.", 409, "NO_MONTHLY_DEMAND");
  return prisma.$transaction(async (tx) => {
    const current = await tx.monthlyDemandSnapshot.findFirst({ where: { periodYear: live.period.year, periodMonth: live.period.month, isCurrentRevision: true, isDeleted: false } });
    if (current) throw statusError(`Snapshot aktif ${current.snapshotNumber} sudah tersedia.`, 409, "CURRENT_SNAPSHOT_EXISTS");
    const latest = await tx.monthlyDemandSnapshot.findFirst({ where: { periodYear: live.period.year, periodMonth: live.period.month, isDeleted: false }, orderBy: { revision: "desc" }, include: { details: { where: { isDeleted: false } } } });
    const revision = number(latest?.revision) + 1 || 1;
    const previousByPart = new Map((latest?.details || []).map((detail) => [detail.partCode, detail]));
    return tx.monthlyDemandSnapshot.create({
      data: {
        ...snapshotHeaderData(live, input, revision, actor, latest?.id || null),
        details: { create: live.items.map((item, index) => snapshotDetailData(item, index + 1, previousByPart.get(item.partCode))) },
        actions: { create: { action: "CREATE", fromStatus: null, toStatus: "DRAFT", reason: text(input.notes) || null, actor, metadata: { sourceFingerprint: live.sourceFingerprint } } },
      },
      include: { details: true, actions: true },
    });
  });
}

async function refreshSnapshot(prisma, snapshotId, input, actor) {
  const snapshot = await prisma.monthlyDemandSnapshot.findFirst({ where: { id: snapshotId, isDeleted: false }, include: { details: { where: { isDeleted: false } } } });
  if (!snapshot) throw statusError("Monthly Demand Snapshot tidak ditemukan.", 404);
  if (snapshot.status !== "DRAFT") throw statusError("Hanya snapshot Draft yang dapat di-refresh.", 409, "SNAPSHOT_IMMUTABLE");
  const live = await buildLiveMonthlyDemand(prisma, `${snapshot.periodYear}-${String(snapshot.periodMonth).padStart(2, "0")}`);
  const base = snapshot.baseSnapshotId ? await prisma.monthlyDemandSnapshot.findFirst({ where: { id: snapshot.baseSnapshotId, isDeleted: false }, include: { details: { where: { isDeleted: false } } } }) : null;
  const previousByPart = new Map((base?.details || []).map((detail) => [detail.partCode, detail]));
  return prisma.$transaction(async (tx) => {
    await tx.monthlyDemandSnapshotDetail.deleteMany({ where: { snapshotId: snapshot.id } });
    await tx.monthlyDemandSnapshotAction.create({ data: { snapshotId: snapshot.id, action: "REFRESH", fromStatus: "DRAFT", toStatus: "DRAFT", reason: text(input.reason) || null, actor, metadata: { previousFingerprint: snapshot.sourceFingerprint, sourceFingerprint: live.sourceFingerprint } } });
    return tx.monthlyDemandSnapshot.update({
      where: { id: snapshot.id },
      data: {
        sourceDataAsOf: live.sourceDataAsOf, sourceFingerprint: live.sourceFingerprint,
        partCount: live.summary.partCount, blockedCount: live.summary.blockedCount, warningCount: live.summary.warningCount,
        totalFccQty: live.totals.fccQty, totalPoFirmQty: live.totals.poFirmQty, totalConsumedFccQty: live.totals.consumedFccQty,
        totalUnplannedPoQty: live.totals.unplannedPoQty, totalEffQty: live.totals.effQty,
        notes: input.notes === undefined ? snapshot.notes : (text(input.notes) || null), updatedBy: actor,
        details: { create: live.items.map((item, index) => snapshotDetailData(item, index + 1, previousByPart.get(item.partCode))) },
      },
      include: { details: true, actions: { orderBy: { createdAt: "asc" } } },
    });
  });
}

async function createRevision(prisma, snapshotId, input, actor) {
  const reason = text(input.reason);
  if (reason.length < 10) throw statusError("Alasan revisi minimal 10 karakter.");
  const snapshot = await prisma.monthlyDemandSnapshot.findFirst({ where: { id: snapshotId, isDeleted: false, isCurrentRevision: true }, include: { details: { where: { isDeleted: false } } } });
  if (!snapshot) throw statusError("Snapshot aktif tidak ditemukan.", 404);
  if (snapshot.status !== "FROZEN") throw statusError("Revisi baru hanya dibuat dari snapshot Frozen.", 409);
  const month = `${snapshot.periodYear}-${String(snapshot.periodMonth).padStart(2, "0")}`;
  const live = await buildLiveMonthlyDemand(prisma, month);
  const previousByPart = new Map(snapshot.details.map((detail) => [detail.partCode, detail]));
  return prisma.$transaction(async (tx) => {
    const latest = await tx.monthlyDemandSnapshot.findFirst({ where: { periodYear: snapshot.periodYear, periodMonth: snapshot.periodMonth, isDeleted: false }, orderBy: { revision: "desc" } });
    const revision = number(latest?.revision) + 1;
    await tx.monthlyDemandSnapshot.updateMany({ where: { periodYear: snapshot.periodYear, periodMonth: snapshot.periodMonth, isCurrentRevision: true, isDeleted: false }, data: { isCurrentRevision: false, updatedBy: actor } });
    const created = await tx.monthlyDemandSnapshot.create({
      data: {
        ...snapshotHeaderData(live, { cutoffDate: input.cutoffDate || snapshot.cutoffDate, notes: input.notes ?? snapshot.notes }, revision, actor, snapshot.id),
        details: { create: live.items.map((item, index) => snapshotDetailData(item, index + 1, previousByPart.get(item.partCode))) },
        actions: { create: { action: "REVISE", fromStatus: "FROZEN", toStatus: "DRAFT", reason, actor, metadata: { baseSnapshotNumber: snapshot.snapshotNumber } } },
      },
      include: { details: true, actions: true },
    });
    await tx.monthlyDemandSnapshotAction.create({ data: { snapshotId: snapshot.id, action: "SUPERSEDED", fromStatus: "FROZEN", toStatus: "FROZEN", reason, actor, metadata: { nextSnapshotNumber: created.snapshotNumber } } });
    return created;
  });
}

async function transitionSnapshot(prisma, snapshotId, action, input, actor) {
  const snapshot = await prisma.monthlyDemandSnapshot.findFirst({ where: { id: snapshotId, isDeleted: false, isCurrentRevision: true } });
  if (!snapshot) throw statusError("Snapshot aktif tidak ditemukan.", 404);
  const transitions = {
    review: { from: "DRAFT", to: "REVIEWED", permissionName: "review" },
    approve: { from: "REVIEWED", to: "APPROVED", permissionName: "approve" },
    freeze: { from: "APPROVED", to: "FROZEN", permissionName: "freeze" },
  };
  const transition = transitions[action];
  if (!transition) throw statusError("Aksi workflow tidak dikenali.", 404);
  if (snapshot.status !== transition.from) throw statusError(`Snapshot berstatus ${snapshot.status}; aksi ${action} membutuhkan status ${transition.from}.`, 409, "INVALID_STATUS_TRANSITION");
  if (snapshot.blockedCount > 0) throw statusError(`Masih ada ${snapshot.blockedCount} part berstatus BLOCKED.`, 409, "READINESS_BLOCKED");
  const reason = text(input.reason);
  if (action === "approve" && reason.length < 5) throw statusError("Catatan approval minimal 5 karakter.");
  if (action === "freeze" && input.confirmed !== true) throw statusError("Konfirmasi Freeze wajib diberikan.");
  const month = `${snapshot.periodYear}-${String(snapshot.periodMonth).padStart(2, "0")}`;
  const live = await buildLiveMonthlyDemand(prisma, month);
  if (live.sourceFingerprint !== snapshot.sourceFingerprint) throw statusError("Sumber FCC/PO berubah setelah snapshot dibuat. Refresh Draft atau buat revisi sebelum melanjutkan.", 409, "SOURCE_CHANGED");
  const now = new Date();
  const lifecycle = action === "review"
    ? { reviewedBy: actor, reviewedAt: now }
    : action === "approve"
      ? { approvedBy: actor, approvedAt: now }
      : { frozenBy: actor, frozenAt: now };
  return prisma.$transaction(async (tx) => {
    await tx.monthlyDemandSnapshotAction.create({ data: { snapshotId: snapshot.id, action: action.toUpperCase(), fromStatus: transition.from, toStatus: transition.to, reason: reason || null, actor, metadata: { sourceFingerprint: live.sourceFingerprint } } });
    return tx.monthlyDemandSnapshot.update({ where: { id: snapshot.id }, data: { status: transition.to, updatedBy: actor, ...lifecycle }, include: { details: { where: { isDeleted: false }, orderBy: { lineNumber: "asc" } }, actions: { orderBy: { createdAt: "asc" } } } });
  });
}

function snapshotSummary(snapshot) {
  return {
    id: snapshot.id, snapshotNumber: snapshot.snapshotNumber, revision: snapshot.revision, status: snapshot.status,
    isCurrentRevision: snapshot.isCurrentRevision, cutoffDate: snapshot.cutoffDate, sourceDataAsOf: snapshot.sourceDataAsOf,
    partCount: snapshot.partCount, blockedCount: snapshot.blockedCount, warningCount: snapshot.warningCount,
    totalFccQty: snapshot.totalFccQty, totalPoFirmQty: snapshot.totalPoFirmQty, totalConsumedFccQty: snapshot.totalConsumedFccQty,
    totalUnplannedPoQty: snapshot.totalUnplannedPoQty, totalEffQty: snapshot.totalEffQty,
    createdBy: snapshot.createdBy, createdAt: snapshot.createdAt, reviewedBy: snapshot.reviewedBy, reviewedAt: snapshot.reviewedAt,
    approvedBy: snapshot.approvedBy, approvedAt: snapshot.approvedAt, frozenBy: snapshot.frozenBy, frozenAt: snapshot.frozenAt,
  };
}

async function getMonthlyReview(prisma, options = {}) {
  const live = await buildLiveMonthlyDemand(prisma, options.month);
  const snapshots = await prisma.monthlyDemandSnapshot.findMany({
    where: { periodYear: live.period.year, periodMonth: live.period.month, isDeleted: false },
    orderBy: { revision: "desc" },
  });
  const selectedId = text(options.snapshotId) || snapshots.find((snapshot) => snapshot.isCurrentRevision)?.id || snapshots[0]?.id || null;
  const selected = selectedId ? await prisma.monthlyDemandSnapshot.findFirst({
    where: { id: selectedId, periodYear: live.period.year, periodMonth: live.period.month, isDeleted: false },
    include: { details: { where: { isDeleted: false }, orderBy: { lineNumber: "asc" } }, actions: { orderBy: { createdAt: "asc" } } },
  }) : null;
  const liveByPart = new Map(live.items.map((item) => [item.partCode, item]));
  const snapshotByPart = new Map((selected?.details || []).map((item) => [item.partCode, item]));
  let items = unique([...liveByPart.keys(), ...snapshotByPart.keys()]).map((partCode) => {
    const currentSource = liveByPart.get(partCode) || null;
    const detail = snapshotByPart.get(partCode) || null;
    const basis = detail || currentSource;
    const storedPhases = Array.isArray(basis?.sourceTrace?.effectiveDeliveryPhases) ? basis.sourceTrace.effectiveDeliveryPhases : [];
    const phasePlanning = basis?.phasePlanning || leadTimeSummary(storedPhases);
    const effectivePhaseCount = number(basis?.effectivePhaseCount) || storedPhases.length;
    const sourceDeltaEffQty = roundQty(number(currentSource?.effQty) - number(detail?.effQty));
    const sourceState = !detail ? "NEW_SOURCE" : !currentSource ? "REMOVED_SOURCE" : Math.abs(sourceDeltaEffQty) > 0.000001 || number(currentSource.fccQty) !== number(detail.fccQty) || number(currentSource.poFirmQty) !== number(detail.poFirmQty) ? "CHANGED" : "UNCHANGED";
    return {
      ...(basis || {}),
      customerCodes: Array.isArray(basis?.customerCodes) ? basis.customerCodes : [],
      daily: dailyDemandMetrics(basis?.sourceTrace, live.period),
      currentSource: currentSource ? { ...currentSource, daily: dailyDemandMetrics(currentSource.sourceTrace, live.period) } : null,
      phasePlanning,
      effectivePhaseCount,
      sourceDeltaEffQty,
      sourceState,
      isSnapshotLine: Boolean(detail),
    };
  });
  const query = text(options.q).toLowerCase();
  const customerCode = text(options.customerCode);
  if (query) items = items.filter((item) => [item.partCode, item.partNumber, item.partName, ...(item.customerCodes || [])].some((value) => String(value || "").toLowerCase().includes(query)));
  if (customerCode) items = items.filter((item) => (item.customerCodes || []).includes(customerCode) || (item.currentSource?.customerCodes || []).includes(customerCode));
  items.sort((left, right) => String(left.partNumber || left.partCode).localeCompare(String(right.partNumber || right.partCode)));
  const pageSize = Math.min(Math.max(Number.parseInt(options.pageSize, 10) || 25, 10), 100);
  const total = items.length;
  const totalPages = Math.max(Math.ceil(total / pageSize), 1);
  const page = Math.min(Math.max(Number.parseInt(options.page, 10) || 1, 1), totalPages);
  const sourceChanged = Boolean(selected && selected.sourceFingerprint !== live.sourceFingerprint);
  return {
    period: { key: live.period.key, year: live.period.year, month: live.period.month, start: live.period.start, end: live.period.end, defaultCutoff: live.period.defaultCutoff },
    live: { totals: live.totals, summary: live.summary, sourceDataAsOf: live.sourceDataAsOf, sourceFingerprint: live.sourceFingerprint },
    snapshots: snapshots.map(snapshotSummary),
    selectedSnapshot: selected ? {
      ...snapshotSummary(selected),
      notes: selected.notes, baseSnapshotId: selected.baseSnapshotId, sourceFingerprint: selected.sourceFingerprint,
      sourceChanged, actions: selected.actions,
      phaseSummary: {
        previousMonthStartPartCount: selected.details.filter((detail) => leadTimeSummary(detail.sourceTrace?.effectiveDeliveryPhases || []).previousMonthPhaseCount > 0).length,
        previousMonthQty: roundQty(selected.details.reduce((sum, detail) => sum + leadTimeSummary(detail.sourceTrace?.effectiveDeliveryPhases || []).previousMonthQty, 0)),
      },
    } : null,
    items: items.slice((page - 1) * pageSize, page * pageSize),
    pagination: { page, pageSize, total, totalPages },
    filters: { customerCode: customerCode || null, customerOptions: live.customerOptions },
    formula: { expression: "EFF = (FCC - FCC consumed) + PO effective", policy: "Explicit pegging lalu FIFO per customer-part; Draft SO tidak dihitung sebagai PO firm." },
    workflow: {
      statuses: ["DRAFT", "REVIEWED", "APPROVED", "FROZEN"],
      sourceChanged,
      canCreate: !snapshots.some((snapshot) => snapshot.isCurrentRevision),
      nextAction: !selected ? "CREATE" : selected.status === "DRAFT" ? "REVIEW" : selected.status === "REVIEWED" ? "APPROVE" : selected.status === "APPROVED" ? "FREEZE" : selected.isCurrentRevision ? "REVISE" : null,
    },
  };
}

module.exports = {
  parsePeriod,
  dailyDemandMetrics,
  buildLiveMonthlyDemand,
  getMonthlyReview,
  createSnapshot,
  refreshSnapshot,
  createRevision,
  transitionSnapshot,
};
