"use strict";

const crypto = require("crypto");
const { validateVendorBatch } = require("./vendorBatchPlanningService");
const { dependencyWindow } = require("./capacityQueueService");
const { resolveDiesAssignment } = require("./diesCapacityService");
const { syncVendorProcessDraftPrForPlan } = require("./vendorProcessPrService");
const { normalizeQuantity } = require("../../utils/uomQuantity");

const clone = (value) => JSON.parse(JSON.stringify(value));
const editorScopeForPlanStatus = (status) => ["Released", "In Progress"].includes(String(status)) ? "REPLAN" : "PLAN";
const isSessionPlanCurrent = (session, plan) => Boolean(session?.basePlanUpdatedAt && plan?.updatedAt)
  && new Date(session.basePlanUpdatedAt).getTime() === new Date(plan.updatedAt).getTime();

function distributeRemainingAllocation(candidates = [], requestedQty = 0) {
  let remaining = Number(requestedQty || 0);
  if (remaining <= 0) throw Object.assign(new Error("Qty allocation harus lebih dari nol."), { statusCode: 400 });
  const ordered = [...candidates]
    .filter((candidate) => Number(candidate.remainingQty || 0) > 0)
    .sort((left, right) => String(left.requiredDate || left.fgRequiredDate || "9999-12-31").localeCompare(String(right.requiredDate || right.fgRequiredDate || "9999-12-31"))
      || Number(left.lineNumber || 0) - Number(right.lineNumber || 0));
  const totalRemaining = ordered.reduce((sum, candidate) => sum + Number(candidate.remainingQty || 0), 0);
  if (remaining > totalRemaining + 0.000001) throw Object.assign(new Error(`Qty allocation melebihi total remaining ${totalRemaining}.`), { statusCode: 409 });
  const result = [];
  for (const candidate of ordered) {
    if (remaining <= 0.000001) break;
    const qty = Math.min(Number(candidate.remainingQty || 0), remaining);
    if (qty > 0) result.push({ lineNumber: Number(candidate.lineNumber), qty: normalizeQuantity(qty, candidate.uomCode) });
    remaining -= qty;
  }
  return result;
}

function quantityText(value) {
  return new Intl.NumberFormat("id-ID", { maximumFractionDigits: 3 }).format(Number(value || 0));
}

function validateInputAvailability({ requestedQty = 0, inputAvailableQty = null, uomCode = "", targetPartCode = null, processCode = null, targetDate = null, inputSources = [] }) {
  if (inputAvailableQty == null) return null;
  if (Number(requestedQty || 0) > Number(inputAvailableQty || 0) + 0.000001) {
    const unit = String(uomCode || "").toUpperCase();
    const target = [targetPartCode, processCode, targetDate ? String(targetDate).slice(0, 10) : null].filter(Boolean).join(" · ");
    const limitingSources = (inputSources || [])
      .filter((source) => Number(source.groupAvailableOutputQty ?? source.availableOutputQty ?? 0) + 0.000001 < Number(requestedQty || 0))
      .map((source) => {
        const identity = [source.partNumber, source.partCode, source.itemType].filter(Boolean).join(" · ");
        return `${identity || "Input tidak dikenal"}: Stock WH ${quantityText(source.stockWhQty)} ${unit} + receipt s/d target ${quantityText(source.receiptQty)} ${unit} - sudah dialokasikan ${quantityText(source.allocatedQty)} ${unit} = available ${quantityText(source.availableOutputQty)} ${unit}`;
      });
    const message = [
      `Stock input level sebelumnya hanya tersedia ${quantityText(inputAvailableQty)} ${unit}.`,
      target ? `Target: ${target}; diminta ${quantityText(requestedQty)} ${unit}.` : `Diminta ${quantityText(requestedQty)} ${unit}.`,
      limitingSources.length ? `Sumber pembatas: ${limitingSources.join("; ")}.` : null,
    ].filter(Boolean).join(" ");
    return {
      code: "MATERIAL_SHORTAGE_WARNING",
      severity: "WARNING",
      blocking: false,
      message,
      requestedQty: Number(requestedQty || 0),
      inputAvailableQty: Number(inputAvailableQty || 0),
      shortageQty: Math.max(Number(requestedQty || 0) - Number(inputAvailableQty || 0), 0),
      uomCode: unit,
      targetPartCode,
      processCode,
      targetDate: targetDate ? String(targetDate).slice(0, 10) : null,
      inputSources,
    };
  }
  return null;
}

function validateCutPasteTargetAvailability(options = {}) {
  const materialShortage = validateInputAvailability(options);
  if (materialShortage) {
    throw Object.assign(new Error(`Cut & Paste ditolak. ${materialShortage.message}`), {
      statusCode: 409,
      code: "CUT_PASTE_TARGET_STOCK_INSUFFICIENT",
      details: materialShortage,
    });
  }
  return true;
}

function calculateTemporalInputAvailabilityDetails({ targetDate, inputs = [], stockByPart = new Map(), predecessorAllocations = [], consumerAllocations = [] }) {
  const targetKey = targetDate instanceof Date ? targetDate.toISOString().slice(0, 10) : String(targetDate || "").slice(0, 10);
  const cutoff = new Date(`${targetKey}T23:59:59.999Z`).getTime();
  const consumedOutputQty = (consumerAllocations || []).reduce((sum, allocation) => {
    const scheduleTime = new Date(allocation.scheduleDate).getTime();
    return scheduleTime <= cutoff ? sum + Number(allocation.plannedQty || 0) : sum;
  }, 0);
  const rawSources = (inputs || []).map((input) => {
    const inputKey = input.partId || input.partCode;
    const openingQty = Math.max(Number(stockByPart.get(inputKey) || stockByPart.get(input.partCode) || 0), 0);
    const receiptQty = (predecessorAllocations || []).reduce((sum, allocation) => {
      if ((allocation.partId || allocation.partCode) !== inputKey && allocation.partCode !== input.partCode) return sum;
      const receiptDate = String(allocation.routingMode || "INHOUSE").toUpperCase() === "VENDOR"
        ? allocation.vendorReturnDate
        : allocation.scheduleDate;
      if (!receiptDate || new Date(receiptDate).getTime() > cutoff) return sum;
      return sum + Number(allocation.expectedReturnQty ?? allocation.plannedQty ?? 0);
    }, 0);
    const qtyPerOutput = Math.max(Number(input.qtyPerOutput || 0), 0);
    if (qtyPerOutput <= 0) return null;
    return {
      partId: input.partId || null,
      partNumber: input.partNumber || null,
      partCode: input.partCode || null,
      partName: input.partName || null,
      itemType: input.itemType || null,
      sourceRole: input.sourceRole || "DIRECT_INPUT",
      inputGroupKey: input.inputGroupKey || input.partCode || inputKey,
      qtyPerOutput,
      stockWhQty: openingQty,
      receiptQty,
      grossOutputQty: (openingQty + receiptQty) / qtyPerOutput,
    };
  }).filter(Boolean);
  const groups = new Map();
  for (const source of rawSources) {
    const current = groups.get(source.inputGroupKey) || [];
    current.push(source);
    groups.set(source.inputGroupKey, current);
  }
  const sources = [];
  const inputGroups = [];
  for (const [inputGroupKey, groupSources] of groups.entries()) {
    let remainingConsumedQty = consumedOutputQty;
    const grossOutputQty = groupSources.reduce((sum, source) => sum + source.grossOutputQty, 0);
    const groupAvailableOutputQty = Math.max(grossOutputQty - consumedOutputQty, 0);
    for (const source of groupSources) {
      const allocatedOutputQty = Math.min(source.grossOutputQty, Math.max(remainingConsumedQty, 0));
      remainingConsumedQty -= allocatedOutputQty;
      sources.push({
        ...source,
        allocatedQty: allocatedOutputQty * source.qtyPerOutput,
        availableOutputQty: Math.max(source.grossOutputQty - allocatedOutputQty, 0),
        groupAvailableOutputQty,
      });
    }
    inputGroups.push({
      inputGroupKey,
      availableOutputQty: groupAvailableOutputQty,
    });
  }
  return {
    availableQty: inputGroups.length ? Math.min(...inputGroups.map((group) => group.availableOutputQty)) : null,
    sources,
    inputGroups,
  };
}

function calculateTemporalInputAvailability(options) {
  return calculateTemporalInputAvailabilityDetails(options).availableQty;
}

async function routeInputAvailability(tx, route, targetDate) {
  const directInputs = (route?.mbomDetail?.children || [])
    .filter((child) => child.part?.id && child.part?.partCode && Number(child.qty || 0) > 0)
    .map((child) => ({
      partId: child.part.id,
      partNumber: child.part.partNumber,
      partCode: child.part.partCode,
      partName: child.part.partName,
      itemType: child.part.itemType,
      sourceRole: "DIRECT_INPUT",
      inputGroupKey: child.part.partCode,
      qtyPerOutput: Number(child.qty || 0),
    }));
  if (!directInputs.length) return null;
  const fgPartIds = [...new Set(directInputs
    .filter((input) => String(input.itemType || "").toUpperCase() === "FG")
    .map((input) => input.partId))];
  const fgHeaders = fgPartIds.length ? await tx.mBOMHeader.findMany({
    where: { partId: { in: fgPartIds }, isDeleted: false },
    orderBy: [{ partId: "asc" }, { revision: "desc" }, { updatedAt: "desc" }],
    select: {
      partId: true,
      revision: true,
      updatedAt: true,
      details: {
        where: { isDeleted: false, parentDetailId: null },
        select: {
          qty: true,
          parentDetailId: true,
          part: { select: { id: true, partNumber: true, partCode: true, partName: true, itemType: true } },
        },
      },
    },
  }) : [];
  const latestHeaderByFgPart = new Map();
  for (const header of fgHeaders) {
    if (!latestHeaderByFgPart.has(header.partId)) latestHeaderByFgPart.set(header.partId, header);
  }
  const inputs = [...directInputs];
  for (const directInput of directInputs) {
    if (String(directInput.itemType || "").toUpperCase() !== "FG") continue;
    const header = latestHeaderByFgPart.get(directInput.partId);
    for (const detail of header?.details || []) {
      if (!detail.part?.id || !detail.part?.partCode || String(detail.part.itemType || "").toUpperCase() !== "WIP") continue;
      inputs.push({
        partId: detail.part.id,
        partNumber: detail.part.partNumber,
        partCode: detail.part.partCode,
        partName: detail.part.partName,
        itemType: detail.part.itemType,
        sourceRole: "PREVIOUS_WIP",
        inputGroupKey: directInput.inputGroupKey,
        qtyPerOutput: directInput.qtyPerOutput * Math.max(Number(detail.qty || 0), 0),
      });
    }
  }
  const validInputs = inputs.filter((input) => Number(input.qtyPerOutput || 0) > 0);
  const partCodes = [...new Set(validInputs.map((input) => input.partCode))];
  const partIds = [...new Set(validInputs.map((input) => input.partId))];
  const stockRows = await tx.stockBalance.groupBy({
    by: ["partCode"],
    where: {
      partCode: { in: partCodes },
      isDeleted: false,
      warehouse: { isDeleted: false, availableForProduction: true },
    },
    _sum: { qtyAvailable: true },
  });
  const stockByPart = new Map(stockRows.map((row) => [row.partCode, Math.max(Number(row._sum.qtyAvailable || 0), 0)]));
  const activeAllocationWhere = {
    isDeleted: false,
    status: { in: ["Draft", "Published"] },
    planningMode: "PRODUCTION",
    plan: { isDeleted: false, status: { notIn: ["Cancelled", "Closed"] } },
  };
  const [predecessorAllocations, consumerAllocations] = await Promise.all([
    tx.productionPlanAllocation.findMany({
      where: { ...activeAllocationWhere, scheduleDate: { lte: targetDate }, mbomProcess: { mbomDetail: { partId: { in: partIds } } } },
      select: { plannedQty: true, expectedReturnQty: true, scheduleDate: true, vendorReturnDate: true, routingMode: true, mbomProcess: { select: { mbomDetail: { select: { partId: true } } } } },
    }),
    tx.productionPlanAllocation.findMany({
      where: { ...activeAllocationWhere, mbomProcessId: route.id, scheduleDate: { lte: targetDate } },
      select: { plannedQty: true, scheduleDate: true },
    }),
  ]);
  return calculateTemporalInputAvailabilityDetails({
    targetDate,
    inputs: validInputs,
    stockByPart,
    predecessorAllocations: predecessorAllocations.map((allocation) => ({
      ...allocation,
      partId: allocation.mbomProcess?.mbomDetail?.partId,
    })),
    consumerAllocations,
  });
}

function validateChangeForScope(scope, change) {
  if (scope === "GLOBAL" && change.type !== "MACHINE_DAY") {
    throw Object.assign(new Error("Global calendar hanya boleh mengubah kapasitas mesin."), { statusCode: 400, code: "GLOBAL_SCOPE_CHANGE_INVALID" });
  }
  return true;
}

function createSessionState({ planId, planStatus, baseVersion, allocations = [], queue = [] }) {
  return {
    id: crypto.randomUUID(), planId, planStatus, baseVersion,
    status: "OPEN", allocations: clone(allocations), queue: clone(queue), changes: [],
  };
}

function stageChange(session, change) {
  if (!session || session.status !== "OPEN") throw new Error("Session editor tidak aktif.");
  return { ...clone(session), changes: [...clone(session.changes), { id: crypto.randomUUID(), ...clone(change) }] };
}

function previewAllocations(session) {
  const rows = clone(session.allocations || []);
  for (const change of session.changes || []) {
    if (change.type === "ALLOCATE_REMAINING") {
      const grouped = Array.isArray(change.allocations) && change.allocations.length;
      const allocations = grouped ? change.allocations : [{ lineNumber: change.lineNumber, qty: change.qty }];
      for (const allocation of allocations) rows.push({
        id: grouped ? `${change.id}-${allocation.lineNumber}` : change.id,
        planNumber: change.planNumber || null,
        lineNumber: allocation.lineNumber,
        mbomProcessId: change.mbomProcessId,
        partCode: change.partCode || null,
        processCode: change.processCode || null,
        plannedQty: Number(allocation.qty || 0),
        scheduleDate: change.targetDate,
        routingMode: change.routingMode || "INHOUSE",
        machineId: change.targetMachineId || null,
        vendorId: change.vendorId || null,
        shift: change.routingMode === "VENDOR" ? "VENDOR" : String(change.shift || "1"),
        staged: true,
      });
      continue;
    }
    if (change.type !== "MOVE_ALLOCATION") continue;
    const index = rows.findIndex((row) => row.id === change.allocationId);
    if (index < 0) throw new Error("Allocation sumber tidak ditemukan.");
    const source = rows[index];
    const qty = Number(change.qty || 0);
    if (qty <= 0 || qty > Number(source.plannedQty || 0)) throw new Error("Qty pindah tidak valid.");
    const moved = {
      ...source,
      id: `staged-${change.id}`,
      plannedQty: qty,
      scheduleDate: change.targetDate || source.scheduleDate,
      machineId: change.targetMachineId || source.machineId,
      vendorId: change.targetVendorId || source.vendorId,
      staged: true,
      sourceAllocationId: source.id,
    };
    if (qty === Number(source.plannedQty)) rows.splice(index, 1, moved);
    else {
      rows[index].plannedQty = Number(source.plannedQty) - qty;
      rows.splice(index + 1, 0, moved);
    }
  }
  return rows;
}

function cancelSession(session) {
  return { ...clone(session), status: "CANCELLED", changes: [], allocations: clone(session.allocations), queue: clone(session.queue || []) };
}

function validateCommit(session, { currentVersion }) {
  if (session.status !== "OPEN") throw new Error("Session editor tidak aktif.");
  if (String(currentVersion) !== String(session.baseVersion)) throw new Error("Monthly Plan sudah berubah. Muat ulang editor sebelum menyimpan.");
  for (const change of session.changes || []) {
    if (!change.force) continue;
    if (!String(change.reason || "").trim()) throw new Error("Force Move wajib alasan.");
    if (change.approvalStatus !== "APPROVED") throw new Error("Force Move wajib approval sebelum commit.");
  }
  return true;
}

async function openPersistentSession(client, { planNumber, actor, scope = "PLAN" }) {
  const plan = await client.monthlyProductionPlan.findFirst({ where: { planNumber, isDeleted: false } });
  if (!plan) throw Object.assign(new Error("Monthly Production Plan tidak ditemukan."), { statusCode: 404 });
  const effectiveScope = editorScopeForPlanStatus(plan.status) === "REPLAN" ? "REPLAN" : (scope === "GLOBAL" ? "GLOBAL" : "PLAN");
  const existing = await client.capacityEditSession.findFirst({ where: { planId: plan.id, scope: effectiveScope, status: "OPEN", createdBy: actor } });
  if (existing && isSessionPlanCurrent(existing, plan)) return existing;
  if (existing) {
    await client.capacityEditSession.update({
      where: { id: existing.id },
      data: { status: "CANCELLED", cancelledBy: actor, cancelledAt: new Date() },
    });
  }
  const allocations = await client.productionPlanAllocation.findMany({ where: { planId: plan.id, isDeleted: false, status: { not: "Cancelled" } } });
  return client.capacityEditSession.create({ data: {
    planId: plan.id, scope: effectiveScope, status: "OPEN", basePlanUpdatedAt: plan.updatedAt,
    snapshot: { allocations }, createdBy: actor,
  } });
}

async function stagePersistentChange(client, { sessionId, change, actor }) {
  const session = await client.capacityEditSession.findFirst({ where: { id: sessionId, status: "OPEN" }, include: { plan: { select: { updatedAt: true } } } });
  if (!session) throw Object.assign(new Error("Session editor tidak aktif."), { statusCode: 409 });
  if (!isSessionPlanCurrent(session, session.plan)) throw Object.assign(new Error("Monthly Plan sudah berubah. Buka ulang Mode Editor agar memakai versi terbaru."), { statusCode: 409 });
  validateChangeForScope(session.scope, change);
  const { replaceChangeId, ...stagedValue } = change;
  if (replaceChangeId) {
    const existingChange = await client.capacityEditChange.findFirst({ where: { id: replaceChangeId, sessionId } });
    if (!existingChange) throw Object.assign(new Error("Draft allocation yang akan dikoreksi tidak ditemukan."), { statusCode: 404, code: "STAGED_CHANGE_NOT_FOUND" });
    return client.capacityEditChange.update({
      where: { id: existingChange.id },
      data: {
        changeType: stagedValue.type,
        entityType: stagedValue.entityType || "ALLOCATION",
        entityId: stagedValue.allocationId || stagedValue.machineId || null,
        afterValue: stagedValue,
        forceRequired: Boolean(stagedValue.force),
        forceReason: stagedValue.reason || null,
        approvalStatus: stagedValue.force ? "PENDING" : "NOT_REQUIRED",
        approvedBy: null,
        approvedAt: null,
        createdBy: actor,
      },
    });
  }
  const latestChange = await client.capacityEditChange.findFirst({
    where: { sessionId },
    orderBy: { sequence: "desc" },
    select: { sequence: true },
  });
  const sequence = Number(latestChange?.sequence || 0) + 1;
  return client.capacityEditChange.create({ data: {
    sessionId, sequence, changeType: stagedValue.type, entityType: stagedValue.entityType || "ALLOCATION",
    entityId: stagedValue.allocationId || stagedValue.machineId || null, beforeValue: stagedValue.beforeValue || undefined,
    afterValue: stagedValue, forceRequired: Boolean(stagedValue.force), forceReason: stagedValue.reason || null,
    approvalStatus: stagedValue.force ? "PENDING" : "NOT_REQUIRED", createdBy: actor,
  } });
}

async function stageRecommendationChanges(client, { sessionId, changes = [], actor }) {
  const staged = [];
  for (const change of changes) {
    validateChangeForScope("PLAN", change);
    staged.push(await stagePersistentChange(client, {
      sessionId,
      change: { ...change, recommendationSource: true },
      actor,
    }));
  }
  return staged;
}

function activeRecommendationStatus(summary = {}) {
  if (Number(summary.materialQueueQty || 0) > 0) return "MATERIAL_QUEUE";
  if (Number(summary.overloadCellCount || 0) > 0) return "READY_WITH_OVERLOAD";
  return "READY";
}

function recommendationReferences(changes = []) {
  const grouped = new Map();
  for (const change of changes) {
    const value = change?.afterValue || change || {};
    if (!value.recommendationScenarioId || !value.recommendationItemId) continue;
    if (!grouped.has(value.recommendationScenarioId)) grouped.set(value.recommendationScenarioId, new Set());
    grouped.get(value.recommendationScenarioId).add(value.recommendationItemId);
  }
  return grouped;
}

async function restoreRecommendationChanges(client, changes = []) {
  for (const [scenarioId, itemIds] of recommendationReferences(changes)) {
    const ids = [...itemIds];
    await client.monthlyPlanRecommendationItem.updateMany({
      where: { scenarioId, id: { in: ids } },
      data: { applyStatus: "PENDING" },
    });
    const scenario = await client.monthlyPlanRecommendationScenario.findUnique({ where: { id: scenarioId } });
    if (!scenario || ["DISCARDED", "FAILED"].includes(scenario.status)) continue;
    await client.monthlyPlanRecommendationScenario.update({
      where: { id: scenarioId },
      data: {
        status: activeRecommendationStatus(scenario.summary || {}),
        appliedBy: null,
        appliedAt: null,
      },
    });
  }
}

async function cancelPersistentSession(client, { sessionId, actor }) {
  return client.$transaction(async (tx) => {
    const session = await tx.capacityEditSession.findFirst({
      where: { id: sessionId, status: "OPEN" },
      include: { changes: { orderBy: { sequence: "asc" } } },
    });
    if (!session) throw Object.assign(new Error("Session editor tidak aktif."), { statusCode: 409 });
    await restoreRecommendationChanges(tx, session.changes || []);
    return tx.capacityEditSession.update({ where: { id: sessionId }, data: { status: "CANCELLED", cancelledBy: actor, cancelledAt: new Date() } });
  });
}

async function undoPersistentChange(client, sessionId) {
  return client.$transaction(async (tx) => {
    const session = await tx.capacityEditSession.findFirst({ where: { id: sessionId, status: "OPEN" } });
    if (!session) throw Object.assign(new Error("Session editor tidak aktif."), { statusCode: 409 });
    const latest = await tx.capacityEditChange.findFirst({ where: { sessionId }, orderBy: { sequence: "desc" } });
    if (!latest) return { ok: true, removed: null };
    await restoreRecommendationChanges(tx, [latest]);
    await tx.capacityEditChange.delete({ where: { id: latest.id } });
    return { ok: true, removed: latest.id };
  });
}

async function getPersistentSession(client, sessionId) {
  const session = await client.capacityEditSession.findUnique({
    where: { id: sessionId },
    include: { changes: { orderBy: { sequence: "asc" } }, queueItems: { where: { status: "OPEN" }, orderBy: { createdAt: "asc" } }, plan: { select: { planNumber: true, status: true, updatedAt: true } } },
  });
  if (!session) throw Object.assign(new Error("Session editor tidak ditemukan."), { statusCode: 404 });
  return session;
}

async function previewPersistentSession(client, sessionId) {
  const session = await getPersistentSession(client, sessionId);
  const state = createSessionState({
    planId: session.planId,
    planStatus: session.plan.status,
    baseVersion: session.basePlanUpdatedAt.toISOString(),
    allocations: session.snapshot?.allocations || [],
    queue: session.queueItems || [],
  });
  state.id = session.id;
  state.changes = session.changes.map((row) => ({ id: row.id, ...row.afterValue, reason: row.forceReason || row.afterValue?.reason, approvalStatus: row.approvalStatus }));
  return { session, allocations: previewAllocations(state), queue: session.queueItems || [] };
}

function asDate(value, label) {
  const date = new Date(`${String(value || "").slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) throw Object.assign(new Error(`${label} tidak valid.`), { statusCode: 400 });
  return date;
}

function validateVendorDateRange(vendorSendDate, vendorReturnDate) {
  if (!vendorSendDate || !vendorReturnDate || vendorReturnDate >= vendorSendDate) return true;
  throw Object.assign(new Error(
    `Tanggal kembali vendor tidak boleh sebelum tanggal kirim. Tanggal kirim/allocation ${vendorSendDate.toISOString().slice(0, 10)}; tanggal kembali ${vendorReturnDate.toISOString().slice(0, 10)}.`,
  ), { statusCode: 400, code: "VENDOR_RETURN_BEFORE_SEND" });
}

function allocationDateText(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || "-");
  const months = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
  return `${String(date.getUTCDate()).padStart(2, "0")} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

function buildRemainingAllocationData({ plan, line, route, allocatedQty = 0, machine = null, vendor = null, value = {}, actor = null }) {
  const routingMode = String(value.routingMode || "INHOUSE").toUpperCase();
  const targetDate = asDate(value.targetDate, "Tanggal allocation");
  const qty = normalizeQuantity(Number(value.qty || 0), line?.uomCode);
  const remainingQty = Math.max(Number(line?.qtyPlanned || 0) - Number(allocatedQty || 0), 0);
  if (!line || !route) throw Object.assign(new Error("Line atau routing process tidak ditemukan."), { statusCode: 404 });
  if (route.mbomDetail?.partId && line.partId && route.mbomDetail.partId !== line.partId) throw Object.assign(new Error("Routing process tidak sesuai dengan line Production Plan."), { statusCode: 409 });
  if (qty <= 0) throw Object.assign(new Error("Qty allocation harus lebih dari nol."), { statusCode: 400 });
  if (qty > remainingQty + 0.000001) {
    const unit = String(line.uomCode || "PCS").toUpperCase();
    const processCode = value.processCode || route.process?.processCode || route.occurrenceCode || route.routingNumber || route.id;
    const message = `Qty allocation melebihi sisa. Target: ${line.partCode || line.partId || "Part tidak dikenal"} · ${processCode || "Proses tidak dikenal"} · Line ${line.lineNumber} · ${allocationDateText(targetDate)}. Diminta ${quantityText(qty)} ${unit}; kebutuhan ${quantityText(line.qtyPlanned)} ${unit}; sudah dialokasikan ${quantityText(allocatedQty)} ${unit}; sisa ${quantityText(remainingQty)} ${unit}.`;
    throw Object.assign(new Error(message), {
      statusCode: 409,
      code: "ALLOCATION_EXCEEDS_REMAINING",
      details: {
        partCode: line.partCode || null,
        processCode: processCode || null,
        lineNumber: Number(line.lineNumber),
        targetDate: targetDate.toISOString().slice(0, 10),
        requestedQty: qty,
        requiredQty: Number(line.qtyPlanned || 0),
        allocatedQty: Number(allocatedQty || 0),
        remainingQty,
        uomCode: unit,
      },
    });
  }
  if (targetDate < plan.periodStart || targetDate > plan.periodEnd) throw Object.assign(new Error("Tanggal allocation harus berada dalam periode MPP."), { statusCode: 400 });
  if (!["INHOUSE", "VENDOR"].includes(routingMode)) throw Object.assign(new Error("Routing mode allocation tidak valid."), { statusCode: 400 });

  let vendorReturnDate = null;
  if (routingMode === "INHOUSE") {
    const requiredSpecification = route.machineSpecificationCode || route.machine?.machineSpecificationCode || null;
    if (!machine || machine.status !== "Active") throw Object.assign(new Error("Mesin tidak aktif atau tidak ditemukan."), { statusCode: 409 });
    if (requiredSpecification && machine.machineSpecificationCode !== requiredSpecification) throw Object.assign(new Error("Mesin tidak memenuhi Machine Specification routing BOM."), { statusCode: 409 });
    if (!["1", "2", "3"].includes(String(value.shift || "1"))) throw Object.assign(new Error("Shift in-house tidak valid."), { statusCode: 400 });
  } else {
    vendorReturnDate = asDate(value.vendorReturnDate, "Tanggal kembali vendor");
    if (!vendor || vendor.status !== "Active") throw Object.assign(new Error("Vendor tidak aktif atau tidak ditemukan."), { statusCode: 409 });
    validateVendorDateRange(targetDate, vendorReturnDate);
  }

  const effectiveFinishDate = vendorReturnDate || targetDate;
  const fgRequiredDate = line.fgRequiredDate ? new Date(line.fgRequiredDate) : null;
  return {
    remainingQty,
    remainingAfter: normalizeQuantity(remainingQty - qty, line.uomCode),
    data: {
      planId: plan.id,
      lineNumber: Number(line.lineNumber),
      mbomProcessId: route.id,
      scheduleDate: targetDate,
      shift: routingMode === "VENDOR" ? "VENDOR" : String(value.shift || "1"),
      plannedStartTime: routingMode === "INHOUSE" ? value.plannedStartTime || null : null,
      plannedEndTime: routingMode === "INHOUSE" ? value.plannedEndTime || null : null,
      machineId: routingMode === "INHOUSE" ? machine.id : null,
      diesId: routingMode === "INHOUSE" ? value.diesId || null : null,
      routingMode,
      vendorId: routingMode === "VENDOR" ? vendor.id : null,
      vendorSendDate: routingMode === "VENDOR" ? targetDate : null,
      vendorReturnDate,
      vendorLeadTimeDays: routingMode === "VENDOR" ? Math.max(Number(vendor.leadTimeDays || 0), 0) : null,
      expectedReturnQty: routingMode === "VENDOR" ? qty : null,
      plannedQty: qty,
      uomCode: line.uomCode || null,
      status: "Draft",
      allocationSource: "MANUAL",
      planningMode: "PRODUCTION",
      demandSourceType: line.deliveryPhaseId ? "DELIVERY_PHASE" : null,
      customerCode: line.customerCode || null,
      customerTargetDate: line.customerTargetDate || null,
      fgRequiredDate: line.fgRequiredDate || null,
      priorityScore: line.priorityScore || null,
      priorityClass: line.priorityClass || null,
      latestStartDate: line.latestStartDate || null,
      latestFinishDate: line.latestFinishDate || null,
      capacityLate: Boolean(fgRequiredDate && effectiveFinishDate > fgRequiredDate),
      lateConstraintCode: fgRequiredDate && effectiveFinishDate > fgRequiredDate ? "CAPACITY_LATE" : null,
      notes: value.reason || null,
      createdBy: actor,
    },
  };
}

async function applyAllocateRemaining(tx, session, change, actor) {
  const value = change.afterValue || {};
  const requestedAllocations = Array.isArray(value.allocations) && value.allocations.length
    ? value.allocations.map((allocation) => ({ lineNumber: Number(allocation.lineNumber), qty: Number(allocation.qty || 0) }))
    : [{ lineNumber: Number(value.lineNumber), qty: Number(value.qty || 0) }];
  const lineNumbers = [...new Set(requestedAllocations.map((allocation) => allocation.lineNumber))];
  const lines = await tx.monthlyProductionPlanDetail.findMany({ where: { planId: session.planId, lineNumber: { in: lineNumbers }, isDeleted: false, status: { not: "Cancelled" } } });
  const route = await tx.mBOMProcess.findFirst({
    where: { id: value.mbomProcessId, isDeleted: false },
    include: {
      machine: { select: { machineSpecificationCode: true } },
      process: { select: { processCode: true } },
      mbomDetail: {
        select: {
          partId: true,
          children: { where: { isDeleted: false }, select: { qty: true, part: { select: { id: true, partNumber: true, partCode: true, partName: true, itemType: true } } } },
        },
      },
    },
  });
  if (lines.length !== lineNumbers.length || !route) throw Object.assign(new Error("Line atau routing process untuk remaining allocation tidak ditemukan."), { statusCode: 404 });
  const routingMode = String(value.routingMode || "INHOUSE").toUpperCase();
  const targetDate = asDate(value.targetDate, "Tanggal allocation");
  const [machine, vendor] = await Promise.all([
    routingMode === "INHOUSE" ? tx.machine.findFirst({ where: { id: value.targetMachineId, isDeleted: false }, select: { id: true, status: true, machineSpecificationCode: true } }) : null,
    routingMode === "VENDOR" ? tx.vendor.findFirst({ where: { id: value.vendorId, isDeleted: false }, select: { id: true, status: true, leadTimeDays: true } }) : null,
  ]);

  const requestedQty = requestedAllocations.reduce((sum, allocation) => sum + Number(allocation.qty || 0), 0);
  const inputAvailability = await routeInputAvailability(tx, route, targetDate);
  const materialWarning = validateInputAvailability({
    requestedQty,
    inputAvailableQty: inputAvailability?.availableQty,
    uomCode: lines[0]?.uomCode,
    targetPartCode: lines[0]?.partCode,
    processCode: value.processCode,
    targetDate,
    inputSources: inputAvailability?.sources || [],
  });

  const created = [];
  const lineByNumber = new Map(lines.map((line) => [Number(line.lineNumber), line]));
  for (const allocation of requestedAllocations) {
    const line = lineByNumber.get(allocation.lineNumber);
    const allocated = await tx.productionPlanAllocation.aggregate({ where: { planId: session.planId, lineNumber: allocation.lineNumber, mbomProcessId: route.id, isDeleted: false, status: { in: ["Draft", "Published"] }, planningMode: "PRODUCTION" }, _sum: { plannedQty: true } });
    const draft = buildRemainingAllocationData({ plan: session.plan, line, route, allocatedQty: allocated._sum.plannedQty, machine, vendor, value: { ...value, qty: allocation.qty }, actor });
    if (routingMode === "INHOUSE") {
      const selectedDies = await resolveDiesAssignment(tx, {
        route,
        machine,
        diesId: value.diesId || null,
        scheduleDate: draft.data.scheduleDate,
        plannedStartTime: draft.data.plannedStartTime,
        plannedEndTime: draft.data.plannedEndTime,
      });
      draft.data.diesId = selectedDies.dies?.id || null;
    }
    created.push(await tx.productionPlanAllocation.create({ data: draft.data }));
  }
  return { created, warnings: materialWarning ? [materialWarning] : [] };
}

async function applyMove(tx, session, change, actor) {
  const value = change.afterValue || {};
  const source = await tx.productionPlanAllocation.findFirst({ where: { id: value.allocationId, planId: session.planId, isDeleted: false, status: "Draft" } });
  if (!source) throw Object.assign(new Error("Allocation sumber sudah berubah atau bukan Draft."), { statusCode: 409 });
  const qty = Number(value.qty || 0);
  if (qty <= 0 || qty > Number(source.plannedQty)) throw Object.assign(new Error("Qty pindah melebihi allocation sumber."), { statusCode: 400 });
  const route = await tx.mBOMProcess.findUnique({
    where: { id: source.mbomProcessId },
    include: {
      process: true,
      mbomDetail: {
        include: {
          part: true,
          children: { where: { isDeleted: false }, select: { qty: true, part: { select: { id: true, partNumber: true, partCode: true, partName: true, itemType: true } } } },
        },
      },
    },
  });
  if (change.changeType === "VENDOR_BATCH") {
    const rule = source.vendorId && route?.process?.processCode ? await tx.vendorPriceListDetail.findFirst({
      where: {
        isDeleted: false,
        vendorProcess: { vendorProcessCode: route.process.processCode, isDeleted: false },
        vendorPriceList: { vendorId: source.vendorId, isActive: true, isDeleted: false },
      },
      orderBy: { updatedAt: "desc" },
    }) : null;
    validateVendorBatch({ qty, minimumOrderQty: rule?.minimumOrderQty, orderMultipleQty: rule?.orderMultipleQty, force: change.forceRequired, reason: change.forceReason, approvalStatus: change.approvalStatus });
  }
  const scheduleDate = value.targetDate ? asDate(value.targetDate, "Tanggal tujuan") : source.scheduleDate;
  const vendorSendDate = value.vendorSendDate ? asDate(value.vendorSendDate, "Tanggal kirim vendor") : source.vendorSendDate;
  const vendorReturnDate = value.vendorReturnDate ? asDate(value.vendorReturnDate, "Tanggal kembali vendor") : source.vendorReturnDate;
  if (String(value.routingMode || source.routingMode || "").toUpperCase() === "VENDOR") {
    validateVendorDateRange(vendorSendDate || scheduleDate, vendorReturnDate);
  }
  if (route) {
    const inputAvailability = await routeInputAvailability(tx, route, scheduleDate);
    if (inputAvailability?.availableQty != null) {
      const sourceAlreadyConsumed = source.scheduleDate && source.scheduleDate <= scheduleDate;
      const availableForMove = Number(inputAvailability.availableQty || 0) + (sourceAlreadyConsumed ? Number(source.plannedQty || 0) : 0);
      validateCutPasteTargetAvailability({
        requestedQty: qty,
        inputAvailableQty: availableForMove,
        uomCode: source.uomCode,
        targetPartCode: route.mbomDetail?.part?.partCode,
        processCode: route.process?.processCode,
        targetDate: scheduleDate,
        inputSources: inputAvailability.sources || [],
      });
    }
  }
  const targetData = {
    scheduleDate,
    machineId: value.targetMachineId || source.machineId,
    vendorId: value.targetVendorId || source.vendorId,
    vendorSendDate,
    vendorReturnDate,
    expectedReturnQty: value.expectedReturnQty == null ? source.expectedReturnQty : Number(value.expectedReturnQty),
    routingMode: value.routingMode || source.routingMode,
    plannedQty: qty,
    notes: [source.notes, `Capacity editor ${session.id}: ${value.reason || "reschedule"}`].filter(Boolean).join(" | "),
    createdBy: actor,
  };
  if (qty === Number(source.plannedQty)) await tx.productionPlanAllocation.update({ where: { id: source.id }, data: targetData });
  else {
    await tx.productionPlanAllocation.update({ where: { id: source.id }, data: { plannedQty: Number(source.plannedQty) - qty } });
    const { id, createdAt, updatedAt, publishedAt, publishedBy, ...copyData } = source;
    await tx.productionPlanAllocation.create({ data: { ...copyData, ...targetData, status: "Draft", publishedAt: null, publishedBy: null } });
  }
}

async function applyMachineDay(tx, session, change, actor) {
  const value = change.afterValue || {};
  const scheduleDate = asDate(value.scheduleDate, "Tanggal capacity");
  if (!value.machineId) throw Object.assign(new Error("Mesin wajib dipilih."), { statusCode: 400 });
  const capacityData = { dayStatus: value.dayStatus || "WORKING", shiftsPerDay: value.shifts?.length || null, shiftOverrides: value.shifts || undefined, reason: value.reason || "Capacity editor", changedBy: actor };
  if (session.scope === "GLOBAL") {
    await tx.capacityCalendarOverride.upsert({
      where: { machineId_scheduleDate: { machineId: value.machineId, scheduleDate } },
      create: { machineId: value.machineId, scheduleDate, ...capacityData },
      update: { ...capacityData, changedAt: new Date(), isDeleted: false },
    });
    return;
  }
  await tx.capacityDayOverride.upsert({
    where: { planId_machineId_scheduleDate: { planId: session.planId, machineId: value.machineId, scheduleDate } },
    create: { planId: session.planId, machineId: value.machineId, scheduleDate, ...capacityData },
    update: { ...capacityData, changedAt: new Date(), isDeleted: false },
  });
}

async function applyQueue(tx, session, change, actor) {
  const value = change.afterValue || {};
  const source = await tx.productionPlanAllocation.findFirst({ where: { id: value.allocationId, planId: session.planId, isDeleted: false, status: "Draft" }, include: { mbomProcess: { include: { process: true, mbomDetail: { include: { part: true } } } } } });
  if (!source) throw Object.assign(new Error("Allocation sumber untuk queue tidak ditemukan."), { statusCode: 409 });
  const qty = Number(value.qty || source.plannedQty);
  if (qty <= 0 || qty > Number(source.plannedQty)) throw Object.assign(new Error("Qty queue tidak valid."), { statusCode: 400 });
  const window = dependencyWindow({ predecessorFinishDates: [], successorStartDates: source.latestFinishDate ? [source.latestFinishDate] : [], fgRequiredDate: source.fgRequiredDate });
  const suggestions = [
    { rank: 1, date: window.latestFinishDate || source.scheduleDate.toISOString().slice(0, 10), machineId: source.machineId, reason: "Pertahankan mesin dan tempatkan sebelum proses successor/FG required." },
    { rank: 2, date: source.scheduleDate.toISOString().slice(0, 10), machineId: source.machineId, reason: "Pulihkan slot awal bila capacity tersedia kembali." },
  ];
  await tx.capacityQueueItem.create({ data: {
    planId: session.planId, sourceAllocationId: source.id, lineNumber: source.lineNumber, mbomProcessId: source.mbomProcessId,
    partCode: source.mbomProcess?.mbomDetail?.part?.partCode || null, processCode: source.mbomProcess?.process?.processCode || null,
    qty, uomCode: source.uomCode, earliestStartDate: source.scheduleDate, latestFinishDate: source.latestFinishDate,
    fgRequiredDate: source.fgRequiredDate, predecessorIds: source.predecessorAllocationIds || undefined, suggestions,
    status: "OPEN", reason: value.reason || "Dilepas dari matrix editor", createdBy: actor,
  } });
  if (qty === Number(source.plannedQty)) await tx.productionPlanAllocation.update({ where: { id: source.id }, data: { status: "Cancelled", isDeleted: true } });
  else await tx.productionPlanAllocation.update({ where: { id: source.id }, data: { plannedQty: Number(source.plannedQty) - qty } });
}

async function commitPersistentSession(client, { sessionId, actor }) {
  return client.$transaction(async (tx) => {
    const session = await tx.capacityEditSession.findUnique({ where: { id: sessionId }, include: { changes: { orderBy: { sequence: "asc" } }, plan: true } });
    if (!session || session.status !== "OPEN") throw Object.assign(new Error("Session editor tidak aktif."), { statusCode: 409 });
    if (editorScopeForPlanStatus(session.plan.status) === "REPLAN" && session.scope !== "REPLAN") throw Object.assign(new Error("Plan Released/In Progress wajib memakai Replan Revision."), { statusCode: 409, code: "REPLAN_REQUIRED" });
    validateCommit({ status: session.status, baseVersion: session.basePlanUpdatedAt.toISOString(), changes: session.changes.map((row) => ({ ...row.afterValue, force: row.forceRequired, reason: row.forceReason, approvalStatus: row.approvalStatus })) }, { currentVersion: session.plan.updatedAt.toISOString() });
    const warnings = [];
    for (const change of session.changes) {
      if (change.changeType === "MACHINE_DAY") await applyMachineDay(tx, session, change, actor);
      else if (["MOVE_ALLOCATION", "SPLIT_ALLOCATION", "VENDOR_BATCH"].includes(change.changeType)) await applyMove(tx, session, change, actor);
      else if (change.changeType === "QUEUE_ALLOCATION") await applyQueue(tx, session, change, actor);
      else if (change.changeType === "ALLOCATE_REMAINING") {
        const result = await applyAllocateRemaining(tx, session, change, actor);
        warnings.push(...(result?.warnings || []));
      }
    }
    if (session.changes.some((change) => change.changeType === "ALLOCATE_REMAINING" && String(change.afterValue?.routingMode).toUpperCase() === "VENDOR")) {
      await syncVendorProcessDraftPrForPlan(tx, session.planId, actor);
    }
    if (session.scope !== "GLOBAL") await tx.monthlyProductionPlan.update({ where: { id: session.planId }, data: { notes: session.plan.notes } });
    const committed = await tx.capacityEditSession.update({ where: { id: sessionId }, data: { status: "COMMITTED", committedBy: actor, committedAt: new Date() } });
    return { ...committed, warnings };
  });
}

module.exports = {
  createSessionState, stageChange, previewAllocations, cancelSession, validateCommit,
  editorScopeForPlanStatus, validateChangeForScope,
  buildRemainingAllocationData, distributeRemainingAllocation, validateInputAvailability, validateCutPasteTargetAvailability, calculateTemporalInputAvailability, calculateTemporalInputAvailabilityDetails, routeInputAvailability, isSessionPlanCurrent,
  openPersistentSession, stagePersistentChange, stageRecommendationChanges, cancelPersistentSession,
  undoPersistentChange, getPersistentSession, previewPersistentSession, commitPersistentSession,
};
