const { periodBounds, getPeriodState, savePeriodState } = require("./periodClosingService");

const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const sum = (rows, field) => rows.reduce((total, row) => total + number(typeof field === "function" ? field(row) : row[field]), 0);
const dateKey = (value) => value ? new Date(value).toISOString().slice(0, 10) : null;

function stage(code, label, state, count, message, href) {
  return { code, label, state, count, message, href };
}

async function loadMonthData(prisma, month) {
  const bounds = periodBounds(month);
  const [demandTargets, demandSnapshot] = await Promise.all([
    prisma.demandDeliveryTarget.findMany({
      where: { isDeleted: false, status: "ACTIVE", targetDate: { gte: bounds.start, lt: bounds.endExclusive } },
      select: { sourceType: true, sourceNumber: true, partCode: true, targetDate: true, qty: true },
      take: 5000,
    }),
    prisma.monthlyDemandSnapshot.findFirst({
      where: { isDeleted: false, isCurrentRevision: true, periodYear: bounds.start.getUTCFullYear(), periodMonth: bounds.start.getUTCMonth() + 1 },
      orderBy: { revision: "desc" },
    }),
  ]);
  const mps = await prisma.mPS.findMany({
    where: { isDeleted: false, periodStart: { lt: bounds.endExclusive }, periodEnd: { gte: bounds.start } },
    include: { details: { where: { isDeleted: false }, select: { id: true, partCode: true, qtyPlanned: true, fgRequiredDate: true, startDate: true, endDate: true } } },
    orderBy: { createdAt: "desc" },
  });
  const mpsNumbers = mps.map((row) => row.mpsNumber);
  const mrpRuns = mpsNumbers.length ? await prisma.mRPRun.findMany({
    where: { isDeleted: false, mpsNumber: { in: mpsNumbers }, isCurrentPlan: true },
    orderBy: [{ planRevision: "desc" }, { createdAt: "desc" }],
  }) : [];
  const runNumbers = mrpRuns.map((row) => row.runNumber);
  const plannedOrders = runNumbers.length ? await prisma.plannedOrder.findMany({
    where: { isDeleted: false, runNumber: { in: runNumbers }, status: { not: "Cancelled" } },
    select: { orderNumber: true, runNumber: true, orderType: true, partCode: true, qty: true, qtyReleased: true, uomCode: true, requiredDate: true, orderDate: true, supplierCode: true, vendorCode: true, status: true, priority: true, lotCount: true, kgPerLot: true, purchaseQtyKg: true, purchasePackageQty: true },
    orderBy: [{ orderDate: "asc" }, { requiredDate: "asc" }, { orderNumber: "asc" }],
  }) : [];
  const plans = await prisma.monthlyProductionPlan.findMany({
    where: { isDeleted: false, periodStart: { lt: bounds.endExclusive }, periodEnd: { gte: bounds.start }, status: { not: "Cancelled" } },
    include: {
      details: { where: { isDeleted: false }, orderBy: { lineNumber: "asc" } },
      manualAllocations: {
        where: { isDeleted: false, status: { not: "Cancelled" }, planningMode: "PRODUCTION" },
        include: {
          mbomProcess: { select: { sequence: true, routingMode: true, process: { select: { processCode: true, processName: true } } } },
          machine: { select: { machineCode: true, machineName: true } },
          vendor: { select: { vendorCode: true, vendorName: true } },
        },
        orderBy: [{ lineNumber: "asc" }, { scheduleDate: "asc" }],
      },
      dailyProductionSchedules: { where: { isDeleted: false, status: { not: "Cancelled" } }, select: { id: true, status: true, lateRisk: true, scheduleDate: true } },
    },
    orderBy: { periodStart: "asc" },
  });
  const pendingChanges = await prisma.planningChangeImpact.findMany({
    where: { status: "PENDING_REPLAN", changedAt: { lt: bounds.endExclusive } },
    orderBy: { changedAt: "desc" }, take: 200,
  });
  return { bounds, demandTargets, demandSnapshot, mps, mrpRuns, plannedOrders, plans, pendingChanges };
}

function buildBlockers(data) {
  const blockers = [];
  if (new Date() < data.bounds.end) blockers.push({ code: "PERIOD_END_NOT_REACHED", reference: data.bounds.month, message: `Period closing baru dapat dilakukan setelah ${dateKey(data.bounds.end)}.` });
  if (data.demandTargets.length && !data.demandSnapshot) blockers.push({ code: "MONTHLY_DEMAND_NOT_REVIEWED", reference: data.bounds.month, message: `${data.demandTargets.length} delivery phase belum memiliki Monthly Demand Snapshot.` });
  if (data.demandSnapshot && !["APPROVED", "FROZEN"].includes(String(data.demandSnapshot.status).toUpperCase())) blockers.push({ code: "MONTHLY_DEMAND_NOT_FROZEN", reference: data.demandSnapshot.snapshotNumber, message: `Monthly Demand Snapshot masih ${data.demandSnapshot.status}.` });
  if (data.demandTargets.length && !data.mps.length) blockers.push({ code: "MPS_MISSING", reference: data.bounds.month, message: `${data.demandTargets.length} delivery phase aktif belum memiliki MPS resmi.` });
  const activeMps = data.mps.filter((row) => !["Cancelled"].includes(row.status));
  activeMps.filter((row) => !["Confirmed", "Released", "Completed"].includes(row.status)).forEach((row) => blockers.push({ code: "MPS_NOT_CONFIRMED", reference: row.mpsNumber, message: `MPS masih ${row.status}.` }));
  activeMps.filter((row) => !data.mrpRuns.some((run) => run.mpsNumber === row.mpsNumber && run.status === "Completed")).forEach((row) => blockers.push({ code: "MRP_NOT_COMPLETED", reference: row.mpsNumber, message: "MRP current belum Completed." }));
  data.plannedOrders.filter((row) => number(row.qtyReleased) + 0.000001 < number(row.qty) && !["Covered", "Released"].includes(row.status)).forEach((row) => blockers.push({ code: "PLANNED_ORDER_OPEN", reference: row.orderNumber, message: `${row.orderType} baru release ${number(row.qtyReleased)} dari ${number(row.qty)} ${row.uomCode || ""}.` }));
  data.plans.filter((row) => row.replanRequired).forEach((row) => blockers.push({ code: "MPP_REPLAN_REQUIRED", reference: row.planNumber, message: row.replanReason || "MPP perlu dihitung ulang." }));
  data.plans.filter((row) => !["Released", "Closed"].includes(row.status)).forEach((row) => blockers.push({ code: "MPP_NOT_RELEASED", reference: row.planNumber, message: `MPP masih ${row.status}.` }));
  data.plans.flatMap((plan) => plan.manualAllocations.map((row) => ({ plan, row }))).filter(({ row }) => row.capacityLate).forEach(({ plan, row }) => blockers.push({ code: "CAPACITY_LATE", reference: `${plan.planNumber}#${row.lineNumber}`, message: row.lateConstraintCode || "Allocation melewati latest finish." }));
  data.pendingChanges.forEach((row) => blockers.push({ code: "PENDING_REPLAN", reference: row.sourceNumber, message: `${row.changeType} belum diselesaikan.` }));
  return blockers;
}

function present(data, periodState) {
  const completedRuns = data.mrpRuns.filter((row) => row.status === "Completed");
  const allocations = data.plans.flatMap((plan) => plan.manualAllocations.map((row) => ({ ...row, planNumber: plan.planNumber })));
  const vendorAllocations = allocations.filter((row) => String(row.routingMode).toUpperCase() === "VENDOR");
  const blockers = buildBlockers(data);
  const officialRun = completedRuns[0] || data.mrpRuns[0] || null;
  const today = new Date();
  const officialMrpDate = new Date(data.bounds.start.getTime() - 24 * 60 * 60 * 1000);
  const isMonthEndReached = today >= officialMrpDate;
  const plannedRows = data.plannedOrders.map((row) => ({
    ...row,
    releaseGap: Math.max(number(row.qty) - number(row.qtyReleased), 0),
    timing: new Date(row.orderDate) < today && number(row.qtyReleased) + 0.000001 < number(row.qty) ? "LATE_RELEASE" : "ON_TIME",
    formula: "release gap = planned qty − released qty",
  }));
  const scheduleRows = allocations.map((row) => ({
    id: row.id, planNumber: row.planNumber, lineNumber: row.lineNumber,
    processCode: row.mbomProcess?.process?.processCode || null,
    processName: row.mbomProcess?.process?.processName || null,
    sequence: row.mbomProcess?.sequence || 0,
    routingMode: row.routingMode,
    resourceCode: String(row.routingMode).toUpperCase() === "VENDOR" ? row.vendor?.vendorCode : row.machine?.machineCode,
    resourceName: String(row.routingMode).toUpperCase() === "VENDOR" ? row.vendor?.vendorName : row.machine?.machineName,
    scheduleDate: row.scheduleDate, vendorSendDate: row.vendorSendDate, vendorReturnDate: row.vendorReturnDate,
    latestStartDate: row.latestStartDate, latestFinishDate: row.latestFinishDate,
    customerTargetDate: row.customerTargetDate, fgRequiredDate: row.fgRequiredDate,
    plannedQty: row.plannedQty, uomCode: row.uomCode, status: row.status,
    capacityLate: row.capacityLate, lateConstraintCode: row.lateConstraintCode,
    backwardFormula: String(row.routingMode).toUpperCase() === "VENDOR"
      ? "vendor send = successor start − vendor lead time; vendor return ≤ successor start"
      : "latest start = latest finish − setup/run time on working calendar",
  }));
  const stages = [
    stage("MPS", "Confirmed MPS", data.mps.every((row) => ["Confirmed", "Released", "Completed"].includes(row.status)) && data.mps.length ? "READY" : "ACTION", data.mps.length, data.mps.length ? "FG netting dan phased delivery menjadi demand resmi." : "Belum ada MPS untuk periode ini.", "/modules/planning-ppic/mps/workbench"),
    stage("CAPACITY", "Capacity & Backward", allocations.length && !allocations.some((row) => row.capacityLate) ? "READY" : "ACTION", allocations.length, `${vendorAllocations.length} operation vendor teralokasi.`, "/modules/planning-ppic/capacity-planning"),
    stage("MRP", "Month-End MRP", completedRuns.length ? "READY" : "ACTION", completedRuns.length, isMonthEndReached ? "Official run dapat difinalkan." : `Official freeze pada ${dateKey(officialMrpDate)} untuk demand ${data.bounds.month}; review boleh dilakukan sekarang.`, officialRun ? `/modules/planning-ppic/mrp/${encodeURIComponent(officialRun.runNumber)}` : `/modules/planning-ppic/control-tower?tab=mrp&month=${data.bounds.month}`),
    stage("PLANNED_ORDER", "Planned Order", plannedRows.length && !plannedRows.some((row) => row.releaseGap > 0) ? "READY" : "ACTION", plannedRows.length, `${plannedRows.filter((row) => row.releaseGap > 0).length} order masih perlu release/cover.`, `/modules/planning-ppic/control-tower?tab=orders&month=${data.bounds.month}`),
    stage("MPP", "Monthly Production Plan", data.plans.length && data.plans.every((row) => ["Released", "Closed"].includes(row.status) && !row.replanRequired) ? "READY" : "ACTION", data.plans.length, `${sum(data.plans, (row) => row.details.length)} line dan ${allocations.length} operation.`, `/modules/planning-ppic/control-tower?tab=mpp&month=${data.bounds.month}`),
    stage("CLOSE", "Period Closing", periodState.status === "CLOSED" ? "CLOSED" : blockers.length ? "BLOCKED" : "READY", blockers.length, periodState.status === "CLOSED" ? `Closed oleh ${periodState.closedBy || "PPIC"}.` : blockers.length ? `${blockers.length} blocker harus diselesaikan.` : "Semua gate siap ditutup.", "#period-closing"),
  ];
  return {
    month: data.bounds.month, period: { start: data.bounds.start, end: data.bounds.end }, periodState,
    summary: { demandPhases: data.demandTargets.length, effectiveDemandQty: sum(data.demandTargets, "qty"), mps: data.mps.length, completedMrp: completedRuns.length, plannedOrders: plannedRows.length, openPlannedOrders: plannedRows.filter((row) => row.releaseGap > 0).length, plans: data.plans.length, allocations: allocations.length, vendorAllocations: vendorAllocations.length, lateAllocations: allocations.filter((row) => row.capacityLate).length, blockers: blockers.length },
    stages, blockers: blockers.slice(0, 500), mps: data.mps, mrpRuns: data.mrpRuns, plannedOrders: plannedRows,
    plans: data.plans.map((row) => ({ planNumber: row.planNumber, status: row.status, periodStart: row.periodStart, periodEnd: row.periodEnd, sourceType: row.sourceType, replanRequired: row.replanRequired, replanReason: row.replanReason, detailCount: row.details.length, plannedQty: sum(row.details, "qtyPlanned"), releasedQty: sum(row.details, "qtyReleased"), allocationCount: row.manualAllocations.length, dailyPlanCount: row.dailyProductionSchedules.length })),
    scheduleRows,
    formulas: [
      { output: "FG latest finish", formula: "customer target date − FG safety days", source: "Demand delivery target / MPS demand source" },
      { output: "Operation latest start", formula: "successor latest start − process duration − inter-process delay", source: "MBOM routing + capacity calendar" },
      { output: "Vendor window", formula: "vendor return ≤ successor start; vendor send = return − vendor lead time", source: "MBOM vendor operation + vendor lead time" },
      { output: "MRP order date", formula: "material required date − supplier lead time", source: "BOM explosion + supplier/part master" },
      { output: "Planned order release gap", formula: "planned qty − released/covered qty", source: "Current MRP planned order" },
    ],
  };
}

async function buildExecutionCockpit(prisma, month) {
  const data = await loadMonthData(prisma, month);
  const periodState = await getPeriodState(prisma, data.bounds.month);
  return present(data, periodState);
}

async function closePeriod(prisma, month, actor, confirmation) {
  const snapshot = await buildExecutionCockpit(prisma, month);
  if (confirmation !== `CLOSE ${snapshot.month}`) throw Object.assign(new Error(`Ketik CLOSE ${snapshot.month} untuk konfirmasi.`), { statusCode: 400 });
  if (snapshot.periodState.status === "CLOSED") return snapshot.periodState;
  if (snapshot.blockers.length) throw Object.assign(new Error(`Periode belum dapat ditutup: ${snapshot.blockers.length} blocker masih aktif.`), { statusCode: 409, blockers: snapshot.blockers });
  return savePeriodState(prisma, snapshot.month, { status: "CLOSED", closedAt: new Date().toISOString(), closedBy: actor, snapshot: snapshot.summary }, actor);
}

async function reopenPeriod(prisma, month, actor, confirmation, reason) {
  const bounds = periodBounds(month);
  if (confirmation !== `REOPEN ${bounds.month}`) throw Object.assign(new Error(`Ketik REOPEN ${bounds.month} untuk konfirmasi.`), { statusCode: 400 });
  if (!String(reason || "").trim()) throw Object.assign(new Error("Alasan reopen wajib diisi."), { statusCode: 400 });
  return savePeriodState(prisma, bounds.month, { status: "OPEN", reopenedAt: new Date().toISOString(), reopenedBy: actor, reason: String(reason).trim() }, actor);
}

module.exports = { buildExecutionCockpit, closePeriod, reopenPeriod };
