const { prisma } = require("../../index");
const MPSController = require("./MPSController");
const MRPController = require("./MRPController");
const MonthlyProductionPlanController = require("./MonthlyProductionPlanController");

const text = (value) => String(value ?? "").trim() || null;
const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;

function invoke(controller, req) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (body) => { if (!settled) { settled = true; resolve({ statusCode: response.statusCode, body }); } };
    const response = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { if (this.statusCode >= 400) { const error = Object.assign(new Error(body?.message || "Planning action gagal"), { status: this.statusCode, statusCode: this.statusCode, response: body }); if (!settled) { settled = true; reject(error); } return this; } finish(body); return this; },
      send(body) { return this.json(body); },
    };
    try {
      const result = controller(req, response, (error) => { if (!settled) { settled = true; reject(error); } });
      if (result?.then) result.catch((error) => { if (!settled) { settled = true; reject(error); } });
    } catch (error) { if (!settled) { settled = true; reject(error); } }
  });
}

async function nextMrpNumber(tx = prisma) {
  const dateKey = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const prefix = `MRP-${dateKey}-`;
  const last = await tx.mRPRun.findFirst({ where: { runNumber: { startsWith: prefix } }, orderBy: { runNumber: "desc" }, select: { runNumber: true } });
  const sequence = Number(last?.runNumber?.split("-").pop() || 0) + 1;
  return `${prefix}${String(sequence).padStart(3, "0")}`;
}

async function loadSnapshot(forecastNumber = null) {
  const forecastWhere = { isDeleted: false, ...(forecastNumber ? { forecastNumber } : {}) };
  const forecasts = await prisma.forecast.findMany({
    where: forecastWhere,
    orderBy: { periodStart: "desc" },
    include: { details: { where: { isDeleted: false, part: { is: { isDeleted: false, itemType: "FG" } } }, orderBy: { lineNumber: "asc" }, include: { part: { select: { id: true, partCode: true, partName: true, itemType: true } } } } },
  });
  const forecastNumbers = forecasts.map((row) => row.forecastNumber);
  const mps = forecastNumbers.length ? await prisma.mPS.findMany({ where: { forecastNumber: { in: forecastNumbers }, isDeleted: false }, include: { details: { where: { isDeleted: false }, select: { id: true, partCode: true, forecastQty: true, bufferQty: true, effectiveDemandQty: true, qtyPlanned: true, actualSalesOrderQty: true, status: true } } }, orderBy: { periodStart: "asc" } }) : [];
  const mpsNumbers = mps.map((row) => row.mpsNumber);
  const mrpRuns = mpsNumbers.length ? await prisma.mRPRun.findMany({ where: { mpsNumber: { in: mpsNumbers }, isDeleted: false }, select: { runNumber: true, mpsNumber: true, planNumber: true, planRevision: true, status: true, totalRequirements: true, totalPlannedOrders: true, runDate: true, isCurrentPlan: true }, orderBy: { createdAt: "desc" } }) : [];
  const runNumbers = mrpRuns.map((row) => row.runNumber);
  const plannedOrders = runNumbers.length ? await prisma.plannedOrder.findMany({ where: { runNumber: { in: runNumbers }, isDeleted: false }, select: { orderNumber: true, runNumber: true, orderType: true, partCode: true, qty: true, status: true, supplierCode: true, requiredDate: true } }) : [];
  const sourceTypes = mpsNumbers.map((numberValue) => `MPS:${numberValue}`);
  const productionPlans = sourceTypes.length ? await prisma.monthlyProductionPlan.findMany({ where: { sourceType: { in: sourceTypes }, isDeleted: false }, include: { details: { where: { isDeleted: false }, select: { id: true, lineNumber: true, partCode: true, qtyPlanned: true, forecastQty: true, bufferQty: true, effectiveDemandQty: true, manufacturingOrderNumber: true, status: true } } }, orderBy: { planMonth: "asc" } }) : [];
  const planNumbers = productionPlans.map((row) => row.planNumber);
  const manufacturingOrders = planNumbers.length ? await prisma.manufacturingOrder.findMany({ where: { monthlyProductionPlanNumber: { in: planNumbers }, isDeleted: false }, select: { id: true, moNumber: true, monthlyProductionPlanNumber: true, monthlyProductionPlanLineNumber: true, partId: true, qtyPlanned: true, status: true } }) : [];
  const moIds = manufacturingOrders.map((row) => row.id);
  const productionLogs = moIds.length ? await prisma.productionLog.findMany({ where: { moId: { in: moIds }, isDeleted: false }, select: { logNumber: true, moId: true, woId: true, logDate: true, qtyPlanned: true, qtyProduced: true, qtyGood: true, qtyReject: true, status: true } }) : [];
  const plannedOrderNumbers = plannedOrders.map((row) => row.orderNumber);
  const purchaseRequests = plannedOrderNumbers.length ? await prisma.purchaseRequisition.findMany({ where: { isDeleted: false, details: { some: { isDeleted: false, plannedOrderNumber: { in: plannedOrderNumbers } } } }, select: { prNumber: true, status: true, sourceType: true, poType: true, requiredDate: true, convertedToPO: true, details: { where: { isDeleted: false, plannedOrderNumber: { in: plannedOrderNumbers } }, select: { plannedOrderNumber: true, partCode: true, materialCode: true, qty: true, uomCode: true, proposedSupplierCode: true, confirmedSupplierCode: true } } } }) : [];

  const byForecast = forecasts.map((forecast) => {
    const forecastMps = mps.filter((row) => row.forecastNumber === forecast.forecastNumber);
    const numbers = new Set(forecastMps.map((row) => row.mpsNumber));
    const forecastMrp = mrpRuns.filter((row) => numbers.has(row.mpsNumber));
    const forecastRuns = new Set(forecastMrp.map((row) => row.runNumber));
    const forecastOrders = plannedOrders.filter((row) => forecastRuns.has(row.runNumber));
    const orderNumbers = new Set(forecastOrders.map((row) => row.orderNumber));
    const forecastPr = purchaseRequests.filter((row) => row.details.some((detail) => orderNumbers.has(detail.plannedOrderNumber)));
    const prOrderNumbers = new Set(forecastPr.flatMap((pr) => pr.details.map((detail) => detail.plannedOrderNumber).filter(Boolean)));
    const forecastPlans = productionPlans.filter((row) => numbers.has(String(row.sourceType || "").slice(4)));
    const planSet = new Set(forecastPlans.map((row) => row.planNumber));
    const forecastMos = manufacturingOrders.filter((row) => planSet.has(row.monthlyProductionPlanNumber));
    const moSet = new Set(forecastMos.map((row) => row.id));
    const forecastLogs = productionLogs.filter((row) => moSet.has(row.moId));
    const nextActions = [];
    if (!forecastMps.length) nextActions.push("CREATE_MPS");
    forecastMps.filter((row) => !["Confirmed", "Released", "Completed"].includes(row.status)).forEach((row) => nextActions.push(`CONFIRM_MPS:${row.mpsNumber}`));
    forecastMps.filter((row) => ["Confirmed", "Released"].includes(row.status) && !forecastMrp.some((run) => run.mpsNumber === row.mpsNumber && run.status === "Completed" && run.isCurrentPlan)).forEach((row) => nextActions.push(`RUN_MRP:${row.mpsNumber}`));
    forecastMrp.filter((run) => run.status === "Completed" && !forecastPlans.some((plan) => plan.sourceType === `MPS:${run.mpsNumber}`)).forEach((run) => nextActions.push(`CREATE_PRODUCTION_PLAN:${run.mpsNumber}`));
    forecastOrders.filter((order) => order.orderType === "Purchase" && order.status === "Planned" && !prOrderNumbers.has(order.orderNumber)).forEach((order) => nextActions.push(`CREATE_PR:${order.runNumber}`));
    if (forecastMos.length && !forecastLogs.length) nextActions.push("CREATE_PRODUCTION_LOG_AFTER_MO_WO");
    return {
      forecastNumber: forecast.forecastNumber, status: forecast.status, itemScope: "FG ONLY",
      details: forecast.details.map((row) => ({ partCode: row.partCode, partName: row.part?.partName || null, itemType: row.part?.itemType || "FG", forecastMonth: row.M1Forecast || row.M2Forecast || row.M3Forecast, qty: number(row.M1Qty || row.M2Qty || row.M3Qty) })),
      mps: forecastMps.map((row) => ({ mpsNumber: row.mpsNumber, status: row.status, periodStart: row.periodStart, periodEnd: row.periodEnd, detailCount: row.details.length, forecastQty: row.details.reduce((sum, detail) => sum + number(detail.forecastQty), 0), bufferQty: row.details.reduce((sum, detail) => sum + number(detail.bufferQty), 0), effectiveDemandQty: row.details.reduce((sum, detail) => sum + number(detail.effectiveDemandQty), 0), qtyPlanned: row.details.reduce((sum, detail) => sum + number(detail.qtyPlanned), 0) })),
      mrp: forecastMrp, productionPlans: forecastPlans, plannedOrders: forecastOrders, purchaseRequests: forecastPr, manufacturingOrders: forecastMos, productionLogs: forecastLogs, nextActions,
    };
  });
  return { items: byForecast, total: byForecast.length, generatedAt: new Date().toISOString() };
}

exports.status = async (req, res, next) => {
  try { res.json(await loadSnapshot(text(req.query.forecastNumber))); } catch (error) { next(error); }
};

exports.sync = async (req, res, next) => {
  const forecastNumber = text(req.params.forecastNumber);
  const execute = req.body?.execute === true;
  if (!execute) {
    try { return res.json({ dryRun: true, message: "Dry-run: kirim execute=true untuk membuat/sinkronisasi dokumen yang belum ada. Approval tetap wajib.", ...(await loadSnapshot(forecastNumber)) }); } catch (error) { return next(error); }
  }
  try {
    const before = await loadSnapshot(forecastNumber);
    const target = before.items[0];
    if (!target) return res.status(404).json({ message: "Forecast tidak ditemukan" });
    const actions = [];
    if (!target.mps.length) {
      try { const created = await invoke(MPSController.createFromForecast, { body: { forecastNumber }, user: req.user }); actions.push({ action: "CREATE_MPS", result: created.body }); } catch (error) { actions.push({ action: "CREATE_MPS", status: "BLOCKED", message: error.message }); }
    }
    const afterMps = await loadSnapshot(forecastNumber);
    for (const mps of afterMps.items[0]?.mps || []) {
      if (!["Confirmed", "Released"].includes(mps.status)) { actions.push({ action: "RUN_MRP", mpsNumber: mps.mpsNumber, status: "BLOCKED", message: `MPS masih ${mps.status}; konfirmasi/approval diperlukan.` }); continue; }
      let run = afterMps.items[0].mrp.find((row) => row.mpsNumber === mps.mpsNumber && row.status === "Completed" && row.isCurrentPlan);
      if (!run) {
        const runNumber = await nextMrpNumber();
        try { const result = await invoke(MRPController.runMRP, { body: { runNumber, mpsNumber: mps.mpsNumber }, user: req.user }); actions.push({ action: "RUN_MRP", mpsNumber: mps.mpsNumber, result: result.body }); run = { runNumber, mpsNumber: mps.mpsNumber, status: "Completed", isCurrentPlan: true }; } catch (error) { actions.push({ action: "RUN_MRP", mpsNumber: mps.mpsNumber, status: "BLOCKED", message: error.message }); continue; }
      }
      const current = await loadSnapshot(forecastNumber);
      const item = current.items[0];
      if (!item.productionPlans.some((plan) => plan.sourceType === `MPS:${mps.mpsNumber}`)) {
        try { const result = await invoke(MonthlyProductionPlanController.createFromMps, { body: { mpsNumber: mps.mpsNumber, productionPercent: req.body?.productionPercent ?? 100 }, user: req.user }); actions.push({ action: "CREATE_PRODUCTION_PLAN", mpsNumber: mps.mpsNumber, result: result.body }); } catch (error) { actions.push({ action: "CREATE_PRODUCTION_PLAN", mpsNumber: mps.mpsNumber, status: "BLOCKED", message: error.message }); }
      }
      try { const result = await invoke(MRPController.createPurchaseRequestOutput, { params: { runNumber: run.runNumber }, body: {}, user: req.user }); actions.push({ action: "CREATE_PR", mpsNumber: mps.mpsNumber, result: result.body }); } catch (error) { actions.push({ action: "CREATE_PR", mpsNumber: mps.mpsNumber, status: "BLOCKED", message: error.message }); }
    }
    const finalState = await loadSnapshot(forecastNumber);
    actions.push({ action: "CREATE_PRODUCTION_LOG_AFTER_MO_WO", status: "MANUAL", message: "Production log tidak dibuat otomatis; MO, WO, shift, operator, qty good/reject dan approval harus diisi di Production module." });
    res.json({ execute: true, actions, ...finalState });
  } catch (error) { next(error); }
};

exports.loadSnapshot = loadSnapshot;
