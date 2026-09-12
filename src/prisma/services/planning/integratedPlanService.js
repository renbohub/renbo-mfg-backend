"use strict";
const { createHash } = require("node:crypto");
const { Prisma } = require("@prisma/client");
const { atomic } = require("./planningTransactionContext");
const { buildProductionLots, machineWindows } = require("./productionLotPlanService");
const hash = value => createHash("sha256").update(JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item)).digest("hex");
const fail = (message, code = "PLAN_CONFLICT", statusCode = 409) => Object.assign(new Error(message), { code, statusCode });

async function invoke(handler, req) {
  let result, responseCode = 200, failure;
  const res = { status(code) { responseCode = code; return this; }, set() { return this; }, json(value) { result = value; return this; } };
  await handler({ params: {}, query: {}, body: {}, ...req }, res, error => { failure = error; });
  if (failure) throw failure;
  if (responseCode >= 400) throw Object.assign(fail(result?.message || "Rencana belum dapat diproses", result?.code, responseCode), { detail: result });
  return result;
}

// A serializable transaction also detects changes after this snapshot is read.
// Only a digest leaves the server; no source-table content is returned.
async function sourceFingerprint(tx, mpsNumber, extraModels = []) {
  const names = new Set(["MPS", "MPSDetail", "MPSDemandSource", "Forecast", "ForecastDetail", "SalesOrderHeader", "SalesOrderDetail", "DemandDeliveryTarget", "DemandPlanningDecision", "StockBalance", "StockReservation", "MBOMHeader", "MBOMDetail", "MBOMProcess", "Part", "Machine", "MachineDowntime", "MachineAvailabilityEvent", "WorkingHourProfile", "WorkingHourRule", "CapacityCalendarOverride", "CapacityDayOverride", "ProductionPlanAllocation", "DailyProductionSchedule", "ManufacturingOrder", "WorkOrder", "PurchaseOrder", "PurchaseOrderDetail", "MaterialSupplySchedule", "SystemSetting"]);
  const dependencies = /^(MBOM|MPS|MRP|Forecast|SalesOrder|Demand|MonthlyDemand|PlanningBaseline|AdditionalDemand|Purchase|GoodsReceipt|MaterialSupply|MaterialDemand|Stock|CustomerSupply|VendorProcess|ProductionPlan|MonthlyProduction|DailyProduction|Capacity|WorkingHour|YearlyWorking|ShiftMaster|Dies|QdUnit|Machine|Routing|WorkCenter|ManufacturingOrder|WorkOrder|ProductionLog|Downtime|Quality|Qc|Uom|ItemUom|MaterialPlanning|DeliverySchedule|DeliveryOrder)/;
  const result = [];
  for (const model of Prisma.dmmf.datamodel.models.filter(model => names.has(model.name) || dependencies.test(model.name) || extraModels.includes(model.name))) {
    const delegate = tx[model.name[0].toLowerCase() + model.name.slice(1)];
    const fields = model.fields.filter(field => field.kind !== "object" && !["Unsupported"].includes(field.type));
    // Hash exact values, including ownership, calendars, routing and demand dates.
    const select = Object.fromEntries(fields.map(field => [field.name, true]));
    const where = model.name === "SystemSetting" ? { NOT: { settingKey: { startsWith: "PPIC_INTEGRATED:" } } } : {};
    const rows = await delegate.findMany({ where, select, orderBy: { id: "asc" } });
    result.push([model.name, rows]);
  }
  return hash([mpsNumber, require("../../utils/businessClock").businessNow().toISOString().slice(0, 10), result]);
}

function normalizeOptions(input = {}) {
  const safetyDays = input.safetyDays == null ? 2 : Number(input.safetyDays);
  if (!Number.isInteger(safetyDays) || safetyDays < 0 || safetyDays > 30) throw fail("Spare rencana harus 0–30 hari sesuai kalender rencana.", "INVALID_SAFETY_DAYS", 400);
  const machineSelections = input.machineSelections || {};
  if (typeof machineSelections !== "object" || Array.isArray(machineSelections) || Object.entries(machineSelections).some(([route, machine]) => !/^[a-zA-Z0-9-]{1,100}$/.test(route) || !/^[a-zA-Z0-9-]{1,100}$/.test(String(machine)))) throw fail("Pilihan mesin tidak valid.", "INVALID_MACHINE_SELECTION", 400);
  return { safetyDays, machineSelections: Object.fromEntries(Object.entries(machineSelections).sort(([a],[b]) => a.localeCompare(b))) };
}

async function calculate(tx, { mpsNumber, user, options, preview, sandbox = false }) {
  const mpsController = require("../../controllers/planning/MPSController");
  const mrpController = require("../../controllers/planning/MRPController");
  const monthlyController = require("../../controllers/planning/MonthlyProductionPlanController");
  const { syncMonthlyMps } = require("./monthlyPlanningService");
  const { runAutomaticMpsEvaluation } = require("./mpsAutomaticEvaluationService");
  const { getMpsWorkbench } = require("./mpsWorkbenchService");
  const { recommendMonthlyCapacity } = require("./capacityRecommendationService");
  const { prisma } = require("../../index");
  const actor = user?.username || user?.email || "system";
  const requestedMonth = /^MONTH:(\d{4}-(?:0[1-9]|1[0-2]))$/.exec(mpsNumber)?.[1];
  if (!preview && requestedMonth) await require("./periodClosingService").assertPeriodOpen(tx, requestedMonth);
  let doc = requestedMonth
    ? await tx.mPS.findFirst({ where: { sourceKey: `MONTH:${requestedMonth}`, isDeleted: false, status: { not: "Superseded" } }, orderBy: { updatedAt: "desc" } })
    : await tx.mPS.findUnique({ where: { mpsNumber } });
  if (!doc && requestedMonth) {
    const initial = await syncMonthlyMps(tx, { months: [requestedMonth], planningAnchorMonth: requestedMonth, runBy: actor, initialEtaMode: "BOM" });
    doc = initial.docs[0];
    if (!doc && preview) return { month: requestedMonth, mpsNumber: null, preview: true, options, workbench: { items: [] }, plans: [], allocations: [], materials: [], lots: [], exceptions: [] };
  }
  if (!doc || doc.isDeleted) throw fail("MPS tidak ditemukan. Buat rencana sumber dari demand terlebih dahulu.", "MPS_NOT_FOUND", 404);
  if (!["Draft", "Confirmed"].includes(doc.status)) throw fail("Gunakan revisi rencana untuk MPS yang sudah berjalan.", "MPS_IN_EXECUTION");
  mpsNumber = doc.mpsNumber;
  const month = doc.periodStart.toISOString().slice(0, 7);
  if (!preview) await require("./periodClosingService").assertPeriodOpen(tx, month);
  const locked = await tx.planningBaselineLock.findFirst({ where: { status: "ACTIVE", periodMonth: doc.periodStart } });
  if (!locked) {
    const synchronized = await syncMonthlyMps(tx, { months: [month], planningAnchorMonth: month, runBy: actor, initialEtaMode: doc.etaMode || "BOM" });
    doc = synchronized.docs.find(row => row.mpsNumber === mpsNumber) || doc;
  } else if (doc.replanRequired) throw fail("Baseline telah dikunci. Selesaikan delta demand sebelum mengonfirmasi rencana.", "LOCKED_DEMAND_CHANGED");
  const evaluation = await runAutomaticMpsEvaluation(prisma, [doc], { runBy: actor });
  const workbench = await getMpsWorkbench(tx, { month, allItemsForEvaluation: true });
  if (!preview) await invoke(mpsController.confirm, { params: { mpsNumber }, user });
  const materialTiming = require("./integratedMaterialSchedule");
  const sandboxMaterialNetting = sandbox && preview ? {} : undefined;
  let mrp, plans, allocations, requirements, materialSchedule = {}, materialTimingExceptions = [], timingConverged = false;
  // Recalculate dated netting after process placement. Further placement can
  // change when a new shortage is found, so publish only a stable result.
  for (let pass = 0; pass < 4; pass++) {
    mrp = await invoke(mrpController.runMRP, { body: { mpsNumber, planningMode: "OFFICIAL", integratedMaterialSchedule: materialSchedule }, user, ppicSandbox: sandbox && preview, ppicSandboxNetting: sandboxMaterialNetting });
    if (preview) await mrpController.prepareProductionPreview(tx, mrp.runNumber);
    else await invoke(mrpController.approve, { params: { runNumber: mrp.runNumber }, user });
    const monthly = await invoke(monthlyController.createFromMps, { body: { mpsNumber, sourceMrpRunNumber: mrp.runNumber, integratedOptions: options }, user });
    plans = (monthly.items || []).map(plan => ({ planNumber: plan.planNumber, status: plan.status, preservedExecution: plan.existing && !plan.synchronized, recommendation: plan.capacityRecommendation }));
    const blocked = plans.find(plan => !plan.recommendation?.ready && !plan.preservedExecution);
    if (!preview && blocked) throw fail(blocked.recommendation?.error || "Alokasi produksi belum layak. Periksa kendala pada hasil simulasi.", "CAPACITY_CALCULATION_FAILED");
    allocations = await tx.productionPlanAllocation.findMany({ where: { plan: { planNumber: { in: plans.map(plan => plan.planNumber) } }, isDeleted: false, status: { not: "Cancelled" } }, include: { plan: { include: { details: { where: { isDeleted: false } } } }, mbomProcess: { include: { process: true } }, machine: true, vendor: true } });
    requirements = await tx.mRPRequirement.findMany({ where: { runNumber: mrp.runNumber, isDeleted: false } });
    const derived = materialTiming.deriveSchedule(requirements, allocations);
    materialTimingExceptions = derived.exceptions;
    timingConverged = !derived.exceptions.length && materialTiming.signature(derived.schedule) === materialTiming.signature(materialSchedule);
    if (timingConverged || blocked || derived.exceptions.length) break;
    materialSchedule = derived.schedule;
  }
  if (!timingConverged && !materialTimingExceptions.length) materialTimingExceptions.push({ reason: "Tanggal material dan slot produksi belum mencapai hasil yang konsisten. Simulasikan kembali setelah kendala diselesaikan." });
  if (!preview && !timingConverged) throw fail(materialTimingExceptions[0]?.reason || "Tanggal material belum konsisten dengan slot produksi.", "MATERIAL_SCHEDULE_UNRESOLVED");
  const scheduled = allocations.map(row => ({ allocationId: row.id, planNumber: row.plan.planNumber, lineNumber: row.lineNumber, machineId: row.machineId, machineCode: row.machine?.machineCode, vendorId: row.vendorId, vendorCode: row.vendor?.vendorCode,
    shift: row.shift, scheduleDate: row.scheduleDate, plannedStartTime: row.plannedStartTime, plannedEndTime: row.plannedEndTime,
    partCode: row.plan.details.find(detail => detail.lineNumber === row.lineNumber)?.partCode, processCode: row.mbomProcess?.occurrenceCode || row.mbomProcess?.process?.processCode,
    qty: Number(row.plannedQty), uomCode: row.uomCode, customerCode: row.customerCode, demandSources: [{ sourceType: row.demandSourceType, sourceNumber: row.demandSourceNumber, customerCode: row.customerCode, deliveryTargetId: row.deliveryPhaseId, qty: Number(row.plannedQty) }], predecessorAllocationIds: row.predecessorAllocationIds || [] }));
  const requirementById = new Map(requirements.map(row => [row.id, row]));
  for (const [index, row] of allocations.entries()) {
    const detail = row.plan.details.find(detail => detail.lineNumber === row.lineNumber);
    const root = requirementById.get(detail?.mrpRootRequirementId);
    const publicRow = scheduled[index];
    publicRow.fgPartCode = root?.fgPartCode || root?.partCode || detail?.partCode;
    publicRow.customerTargetDate = row.customerTargetDate;
    publicRow.fgRequiredDate = row.fgRequiredDate;
    const [sh, sm] = String(row.plannedStartTime || "00:00").split(":").map(Number);
    const [eh, em] = String(row.plannedEndTime || "00:00").split(":").map(Number);
    let minutes = (eh * 60 + em) - (sh * 60 + sm);
    if (minutes < 0) minutes += 1440;
    publicRow.minutes = minutes;
    const finish = new Date(row.vendorReturnDate || row.scheduleDate);
    if (!row.vendorReturnDate) finish.setUTCMinutes(sh * 60 + sm + minutes);
    publicRow.plannedFinishAt = finish;
  }
  const machineById = new Map(allocations.filter(row => row.machine).map(row => [row.machineId, row.machine]));
  const lotPlan = buildProductionLots(scheduled, { windowsFor: row => machineWindows(machineById.get(row.machineId), row) });
  lotPlan.exceptions.push(...materialTimingExceptions);
  const materialRows = await tx.mRPRequirement.findMany({ where: { runNumber: mrp.runNumber, isDeleted: false, orderType: "Purchase" }, include: { part: { include: { partBases: true } }, mbomDetail: { include: { supplyCustomer: true } } } });
  const materialRules = mrpController.buildMaterialPlanningRules(materialRows.map(row => ({ ...(row.mbomDetail || {}), part: row.part })));
  const plannedPurchases = await tx.plannedOrder.findMany({ where: { runNumber: mrp.runNumber, orderType: "Purchase", isDeleted: false }, select: { orderNumber: true, partCode: true, requiredDate: true, qty: true, uomCode: true, supplierCode: true } });
  const materials = materialRows.map(row => ({ id: row.id, partCode: row.partCode, grossRequirement: row.grossRequirement, netRequirement: row.netRequirement,
    onHandQty: row.onHandQty, firmSupplyQty: row.firmSupplyQty, requiredDate: row.requiredDate, materialRequiredDate: row.materialRequiredDate,
    uomCode: materialRules.planningUomByPartCode[row.partCode] || row.mbomDetail?.uomCode || row.part?.baseUomCode || row.part?.stockUomCode || "", materialSupplyType: row.materialSupplyType || row.mbomDetail?.materialSupplyType || row.part?.materialSupplyType,
    supplyCustomerCode: row.supplyCustomerCode || row.mbomDetail?.supplyCustomer?.customerCode || null, category: row.mbomDetail?.category || row.part?.itemType,
    sourceType: row.sourceType, sourceNumber: row.sourceNumber, deliveryTargetId: row.deliveryTargetId, mpsDetailId: row.mpsDetailId, supplyTimeline: row.supplyTimeline,
    fgPartCode: row.fgPartCode, leadTime: row.leadTime, latestPrDate: row.latestPrDate, orderDate: row.orderDate, procurementWindow: row.procurementWindow,
    plannedOrders: plannedPurchases.filter(order => order.partCode === row.partCode && order.requiredDate.toISOString() === row.requiredDate.toISOString()) }));
  const processIds = [...new Set(workbench.items.flatMap(item => (item.components || []).flatMap(component => (component.processes || []).map(process => process.id))))];
  const [routeRows, machines, dies] = await Promise.all([
    tx.mBOMProcess.findMany({ where: { id: { in: processIds } }, include: { mbomDetail: { include: { part: true } }, machine: true, process: true, vendor: true } }),
    tx.machine.findMany({ where: { isDeleted: false, status: "Active" } }),
    tx.dies.findMany({ where: { isDeleted: false }, include: { diesParts: true } }),
  ]);
  const resolvePolicy = require("./routingMachinePolicy").resolveRoutingMachinePolicy;
  const processes = routeRows.map(route => {
    const policy = resolvePolicy(route, machines, dies, { start: doc.periodStart, end: doc.periodEnd });
    return { id: route.id, partCode: route.mbomDetail?.part?.partCode, processCode: route.occurrenceCode || route.process?.processCode, routingMode: route.routingMode, vendorId: route.vendorId, vendorCode: route.vendor?.vendorCode, vendorName: route.vendor?.vendorName, errors: route.routingMode === "VENDOR" ? [] : policy.errors,
      machineOptions: policy.resources.map(resource => ({ ...resource, machineCode: machines.find(machine => machine.id === resource.machineId)?.machineCode })), selectedMachineId: options.machineSelections[route.id] || policy.primaryMachineId };
  });
  for (const routeId of Object.keys(options.machineSelections)) if (!processes.some(route => route.id === routeId)) throw fail("Pilihan mesin tidak lagi sesuai proses FG terbaru.", "STALE_MACHINE_SELECTION");
  const active = await tx.mPS.findUnique({ where: { mpsNumber } });
  return { ...(sandboxMaterialNetting ? { sandboxMaterialNetting } : {}), sourceMode: locked ? "LOCKED_BASELINE" : "CURRENT_DEMAND", month, mpsNumber, mpsRevision: active.revision, preview, options, workbench, evaluation, materialTimingStatus: timingConverged ? "CONSISTENT" : "UNRESOLVED", mrpRunNumber: mrp.runNumber, mrpRevision: mrp.planRevision, plans, processes, allocations: scheduled, materials, ...lotPlan };
}

async function review(prisma, { mpsNumber, user, ...input }) {
  const options = normalizeOptions(input);
  return atomic(prisma, async tx => {
    const fingerprint = await sourceFingerprint(tx, mpsNumber);
    const result = await calculate(tx, { mpsNumber, user, options, preview: true });
    return { ...result, planningRevision: `PPIC-${hash([mpsNumber, fingerprint, options]).slice(0, 20).toUpperCase()}`, sourceIdentifier: mpsNumber, fingerprint, reviewedAt: new Date().toISOString() };
  }, { preview: true });
}
async function confirm(prisma, { mpsNumber, user, expectedFingerprint, operationId, ...input }) {
  if (!/^[a-zA-Z0-9-]{16,100}$/.test(String(operationId || "")) || !/^[a-f0-9]{64}$/.test(String(expectedFingerprint || ""))) throw fail("Tinjau simulasi terbaru sebelum Konfirmasi Rencana.", "REVIEW_REQUIRED", 400);
  const options = normalizeOptions(input), requestHash = hash([mpsNumber, expectedFingerprint, options]);
  return atomic(prisma, async tx => {
    const settingKey = `PPIC_INTEGRATED:${operationId}`;
    const previous = await tx.systemSetting.findUnique({ where: { settingKey } });
    if (previous) {
      const saved = JSON.parse(previous.settingValue);
      if (saved.requestHash !== requestHash) throw fail("Identitas konfirmasi telah dipakai untuk simulasi berbeda.");
      return { ...saved.result, replayed: true };
    }
    if (await sourceFingerprint(tx, mpsNumber) !== expectedFingerprint) throw fail("Demand, stok, BOM, atau jadwal berubah. Simulasikan kembali sebelum konfirmasi.", "PLAN_SOURCE_CHANGED");
    const result = { ...await calculate(tx, { mpsNumber, user, options, preview: false }), planningRevision: `PPIC-${requestHash.slice(0, 20).toUpperCase()}` };
    for (const plan of result.plans.filter(plan => !plan.preservedExecution)) {
      const current = await tx.monthlyProductionPlan.findUnique({ where: { planNumber: plan.planNumber }, select: { recommendationSummary: true } });
      await tx.monthlyProductionPlan.update({ where: { planNumber: plan.planNumber }, data: { recommendationSummary: { ...(current?.recommendationSummary || {}), integratedRevision: { planningRevision: result.planningRevision, mpsNumber: result.mpsNumber, mpsRevision: result.mpsRevision, mrpRunNumber: result.mrpRunNumber, mrpRevision: result.mrpRevision } } } });
    }
    await tx.systemSetting.create({ data: { settingKey, settingValue: JSON.stringify({ requestHash, result }), description: "Revisi konfirmasi PPIC: MPS, MRP, rencana bulanan dan lot", updatedBy: user?.username || "system" } });
    return result;
  });
}
module.exports = { review, confirm, invoke, normalizeOptions, sourceFingerprint, calculate };
