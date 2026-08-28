const { periodBounds, getPeriodState, savePeriodState } = require("./periodClosingService");
const { canonicalMrpLifecycleStatus } = require("./mrpLifecycleService");

const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const sum = (rows, field) => rows.reduce((total, row) => total + number(typeof field === "function" ? field(row) : row[field]), 0);
const dateKey = (value) => value ? new Date(value).toISOString().slice(0, 10) : null;
const isGeneratedProcess = (row) => String(row?.notes || "").includes("[MRP-PRODUCTION]");
const mrpRunMarker = (row) => String(row?.notes || "").match(/\[MRP-RUN:([^\]]+)\]/)?.[1] || null;
const sourceMpsNumber = (plan) => String(plan?.sourceType || "").startsWith("MPS:") ? String(plan.sourceType).slice(4) : null;

function mrpLifecycleStatus(row = {}) {
  const scenarioStatus = String(row.scenarioStatus || "").trim().toUpperCase();
  const runStatus = String(row.status || "").trim().toUpperCase();
  if (scenarioStatus === "SUPERSEDED" || runStatus === "SUPERSEDED") return "SUPERSEDED";
  if (row.isCurrentPlan || scenarioStatus === "APPROVED") return "APPROVED";
  if (runStatus === "FAILED") return "FAILED";
  if (scenarioStatus === "DRAFT" || runStatus === "RUNNING") return "DRAFT";
  return canonicalMrpLifecycleStatus(scenarioStatus);
}

function mergeDisplayMrpRuns(currentPeriodRuns = [], periodHistoryRuns = [], upstreamRuns = [], executionMonth = "") {
  const byRunNumber = new Map();
  const collect = (row, executionScope, executionScopeLabel) => {
    if (!row?.runNumber || byRunNumber.has(row.runNumber)) return;
    byRunNumber.set(row.runNumber, { ...row, executionScope, executionScopeLabel });
  };
  currentPeriodRuns.forEach((row) => collect(row, "PERIOD", "MRP periode demand ini"));
  periodHistoryRuns.forEach((row) => collect(row, "PERIOD", "Working revision periode demand ini"));
  upstreamRuns.forEach((row) => collect(row, "LINKED_SOURCE", `Source MPP eksekusi ${executionMonth}`));

  const candidates = [...byRunNumber.values()].filter((row) => (
    String(row.scenarioAssumptions?.planningMode || "").trim().toUpperCase() !== "M_PLUS_ONE_PREVIEW"
  ));
  const approvedByMps = new Map();
  for (const row of candidates) {
    if (!row.mpsNumber || mrpLifecycleStatus(row) !== "APPROVED") continue;
    const previous = approvedByMps.get(row.mpsNumber);
    if (!previous || Number(row.planRevision || 0) > Number(previous.planRevision || 0)) approvedByMps.set(row.mpsNumber, row);
  }

  const activeBySource = new Map();
  for (const row of candidates) {
    if (mrpLifecycleStatus(row) === "SUPERSEDED") continue;
    const sourceKey = row.mpsNumber || row.planNumber || row.runNumber;
    const previous = activeBySource.get(sourceKey);
    const revision = Number(row.planRevision || 0);
    const previousRevision = Number(previous?.planRevision || 0);
    const timestamp = new Date(row.updatedAt || row.runDate || row.createdAt || 0).getTime();
    const previousTimestamp = new Date(previous?.updatedAt || previous?.runDate || previous?.createdAt || 0).getTime();
    if (!previous || revision > previousRevision || (revision === previousRevision && timestamp > previousTimestamp)) activeBySource.set(sourceKey, row);
  }

  return [...activeBySource.values()]
    .map((row) => {
      const approved = approvedByMps.get(row.mpsNumber) || null;
      return {
        ...row,
        presentationStatus: mrpLifecycleStatus(row),
        approvedRunNumber: approved?.runNumber || null,
        approvedPlanRevision: approved?.planRevision || null,
      };
    })
    .sort((left, right) => {
      const scopeOrder = Number(left.executionScope === "LINKED_SOURCE") - Number(right.executionScope === "LINKED_SOURCE");
      if (scopeOrder) return scopeOrder;
      return String(left.mpsNumber || left.runNumber).localeCompare(String(right.mpsNumber || right.runNumber));
    });
}

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
  const [mrpRuns, mrpHistory] = mpsNumbers.length ? await Promise.all([
    prisma.mRPRun.findMany({
      where: { isDeleted: false, mpsNumber: { in: mpsNumbers }, isCurrentPlan: true },
      orderBy: [{ planRevision: "desc" }, { createdAt: "desc" }],
    }),
    prisma.mRPRun.findMany({
      where: { isDeleted: false, mpsNumber: { in: mpsNumbers } },
      orderBy: [{ planRevision: "desc" }, { createdAt: "desc" }],
      take: 200,
    }),
  ]) : [[], []];
  const runNumbers = mrpRuns.map((row) => row.runNumber);
  const plannedOrders = runNumbers.length ? await prisma.plannedOrder.findMany({
    where: { isDeleted: false, runNumber: { in: runNumbers }, status: { not: "Cancelled" } },
    select: { orderNumber: true, runNumber: true, orderType: true, partCode: true, qty: true, qtyReleased: true, uomCode: true, requiredDate: true, orderDate: true, supplierCode: true, vendorCode: true, status: true, priority: true, lotCount: true, kgPerLot: true, purchaseQtyKg: true, purchasePackageQty: true },
    orderBy: [{ orderDate: "asc" }, { requiredDate: "asc" }, { orderNumber: "asc" }],
  }) : [];
  const plans = await prisma.monthlyProductionPlan.findMany({
    where: {
      isDeleted: false,
      periodStart: { lt: bounds.endExclusive },
      periodEnd: { gte: bounds.start },
      status: { not: "Cancelled" },
      NOT: { notes: { contains: "[SUPERSEDED-BY:" } },
    },
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
      dailyProductionSchedules: {
        where: {
          isDeleted: false,
          status: { not: "Cancelled" },
          OR: [
            { dailyPlanRevisionId: null },
            { dailyPlanRevision: { is: { isDeleted: false, status: { not: "Superseded" } } } },
          ],
        },
        select: { id: true, status: true, lateRisk: true, scheduleDate: true },
      },
    },
    orderBy: { periodStart: "asc" },
  });
  const pendingChanges = await prisma.planningChangeImpact.findMany({
    where: { status: "PENDING_REPLAN", changedAt: { lt: bounds.endExclusive } },
    orderBy: { changedAt: "desc" }, take: 200,
  });
  const planMpsNumbers = [...new Set(plans.map(sourceMpsNumber).filter(Boolean))];
  const directMpsNumberSet = new Set(mpsNumbers);
  const upstreamMpsNumbers = planMpsNumbers.filter((value) => !directMpsNumberSet.has(value));
  const upstreamMps = upstreamMpsNumbers.length ? await prisma.mPS.findMany({
    where: { isDeleted: false, mpsNumber: { in: upstreamMpsNumbers } },
    include: { details: { where: { isDeleted: false }, select: { id: true, partCode: true, qtyPlanned: true, fgRequiredDate: true, startDate: true, endDate: true } } },
    orderBy: { periodStart: "asc" },
  }) : [];
  const planCurrentMrpRuns = planMpsNumbers.length ? await prisma.mRPRun.findMany({
    where: { isDeleted: false, mpsNumber: { in: planMpsNumbers }, isCurrentPlan: true, status: "Completed" },
    orderBy: [{ planRevision: "desc" }, { createdAt: "desc" }],
  }) : [];
  const currentRunByMps = new Map();
  for (const run of planCurrentMrpRuns) if (!currentRunByMps.has(run.mpsNumber)) currentRunByMps.set(run.mpsNumber, run.runNumber);
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (const plan of plans) {
    const snapshotRuns = [...new Set(plan.details.map(mrpRunMarker).filter(Boolean))];
    const currentRun = currentRunByMps.get(sourceMpsNumber(plan)) || null;
    const sourceStale = Boolean(currentRun) && (snapshotRuns.length !== 1 || snapshotRuns[0] !== currentRun);
    const outstanding = plan.details.filter((row) => number(row.qtyPlanned) > number(row.qtyReleased) + 0.000001);
    const starts = outstanding.map((row) => row.latestStartDate && new Date(row.latestStartDate)).filter((value) => value && !Number.isNaN(value.getTime()));
    const estimatedStart = starts.length ? new Date(Math.min(...starts.map((value) => value.getTime()))) : null;
    const timingLate = ["Draft", "Confirmed"].includes(plan.status) && estimatedStart && estimatedStart < today;
    plan.sourceMrpRunNumbers = snapshotRuns;
    plan.currentSourceMrpNumber = currentRun;
    plan.sourceSnapshotStatus = sourceStale ? "STALE" : "CURRENT";
    plan.estimatedStart = estimatedStart;
    plan.timingLate = Boolean(timingLate);
    plan.replanRequired = Boolean(plan.replanRequired || sourceStale || timingLate);
    plan.replanReason = plan.replanReason
      || (sourceStale ? `Snapshot ${snapshotRuns.join(", ") || "MRP lama"} berbeda dari current ${currentRun}.` : null)
      || (timingLate ? `Estimated production start ${dateKey(estimatedStart)} sudah lewat.` : null);
  }
  const directMrpNumberSet = new Set(mrpRuns.map((row) => row.runNumber));
  const upstreamMrpRuns = planCurrentMrpRuns.filter((row) => !directMrpNumberSet.has(row.runNumber));
  return { bounds, demandTargets, demandSnapshot, mps, mrpRuns, mrpHistory, plannedOrders, plans, pendingChanges, planCurrentMrpRuns, upstreamMps, upstreamMrpRuns };
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
  const displayMps = [
    ...data.mps.map((row) => ({ ...row, executionScope: "PERIOD", executionScopeLabel: "Demand pada periode ini" })),
    ...data.upstreamMps.map((row) => ({ ...row, executionScope: "LINKED_SOURCE", executionScopeLabel: `Demand ${dateKey(row.periodStart)?.slice(0, 7) || "lintas bulan"} → eksekusi ${data.bounds.month}` })),
  ];
  const displayMrpRuns = mergeDisplayMrpRuns(data.mrpRuns, data.mrpHistory, data.upstreamMrpRuns, data.bounds.month);
  const currentCompletedRuns = [
    ...completedRuns,
    ...data.upstreamMrpRuns.filter((row) => row.status === "Completed"),
  ];
  const allocations = data.plans.flatMap((plan) => plan.manualAllocations.map((row) => ({ ...row, planNumber: plan.planNumber })));
  const vendorAllocations = allocations.filter((row) => String(row.routingMode).toUpperCase() === "VENDOR");
  const blockers = buildBlockers(data);
  const officialRun = currentCompletedRuns[0] || displayMrpRuns[0] || null;
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
    stage("MPS", "Demand Frozen MPS", displayMps.every((row) => ["Confirmed", "Released", "Completed"].includes(row.status)) && displayMps.length ? "READY" : "ACTION", displayMps.length, data.upstreamMps.length ? `${data.mps.length} periode ini + ${data.upstreamMps.length} linked source untuk Production Plan ${data.bounds.month}.` : data.mps.length ? "FG netting dan phased delivery menjadi demand resmi." : "Belum ada MPS untuk periode ini.", "/modules/planning-ppic/mps/workbench"),
    stage("CAPACITY", "Capacity & Backward", allocations.length && !allocations.some((row) => row.capacityLate) ? "READY" : "ACTION", allocations.length, `${vendorAllocations.length} operation vendor teralokasi.`, "/modules/planning-ppic/capacity-planning"),
    stage("MRP", "Current Source MRP", currentCompletedRuns.length ? "READY" : "ACTION", currentCompletedRuns.length, data.upstreamMrpRuns.length ? `${completedRuns.length} periode ini + ${data.upstreamMrpRuns.length} linked source untuk Production Plan ${data.bounds.month}.` : isMonthEndReached ? "Official run dapat difinalkan." : `Official freeze pada ${dateKey(officialMrpDate)} untuk demand ${data.bounds.month}; review boleh dilakukan sekarang.`, officialRun ? `/modules/planning-ppic/mrp/${encodeURIComponent(officialRun.runNumber)}` : `/modules/planning-ppic/control-tower?tab=mrp&month=${data.bounds.month}`),
    stage("PLANNED_ORDER", "Planned Order", plannedRows.length && !plannedRows.some((row) => row.releaseGap > 0) ? "READY" : "ACTION", plannedRows.length, `${plannedRows.filter((row) => row.releaseGap > 0).length} order masih perlu release/cover.`, `/modules/planning-ppic/control-tower?tab=orders&month=${data.bounds.month}`),
    stage("PP", "Monthly Production Plan", data.plans.length && data.plans.every((row) => ["Released", "Closed"].includes(row.status) && !row.replanRequired) ? "READY" : "ACTION", data.plans.length, `${sum(data.plans, (row) => row.details.length)} line dan ${allocations.length} operation. Bulan hanya filter kalender.`, `/modules/planning-ppic/monthly-production-plans?month=${data.bounds.month}`),
    stage("CLOSE", "Period Closing", periodState.status === "CLOSED" ? "CLOSED" : blockers.length ? "BLOCKED" : "READY", blockers.length, periodState.status === "CLOSED" ? `Closed oleh ${periodState.closedBy || "PPIC"}.` : blockers.length ? `${blockers.length} blocker harus diselesaikan.` : "Semua gate siap ditutup.", "#period-closing"),
  ];
  return {
    month: data.bounds.month, period: { start: data.bounds.start, end: data.bounds.end }, periodState,
    summary: { demandPhases: data.demandTargets.length, effectiveDemandQty: sum(data.demandTargets, "qty"), mps: displayMps.length, directMps: data.mps.length, linkedMps: data.upstreamMps.length, completedMrp: currentCompletedRuns.length, directCompletedMrp: completedRuns.length, linkedCompletedMrp: data.upstreamMrpRuns.filter((row) => row.status === "Completed").length, plannedOrders: plannedRows.length, openPlannedOrders: plannedRows.filter((row) => row.releaseGap > 0).length, plans: data.plans.length, allocations: allocations.length, vendorAllocations: vendorAllocations.length, dailyPlans: sum(data.plans, (row) => row.dailyProductionSchedules.length), releasedDailyPlans: sum(data.plans, (row) => row.dailyProductionSchedules.filter((item) => ["Released", "In Progress", "Completed"].includes(item.status)).length), lateAllocations: allocations.filter((row) => row.capacityLate).length, latePlans: data.plans.filter((row) => row.timingLate).length, blockers: blockers.length },
    stages, blockers: blockers.slice(0, 500), mps: displayMps, mrpRuns: displayMrpRuns, plannedOrders: plannedRows,
    plans: data.plans.map((row) => {
      const receiptRows = row.details.filter((detail) => !isGeneratedProcess(detail));
      return {
        planNumber: row.planNumber,
        status: row.status,
        periodStart: row.periodStart,
        periodEnd: row.periodEnd,
        sourceType: row.sourceType,
        sourceMrpRunNumbers: row.sourceMrpRunNumbers,
        currentSourceMrpNumber: row.currentSourceMrpNumber,
        sourceSnapshotStatus: row.sourceSnapshotStatus,
        estimatedStart: row.estimatedStart,
        timingLate: row.timingLate,
        replanRequired: row.replanRequired,
        replanReason: row.replanReason,
        detailCount: row.details.length,
        plannedQty: sum(receiptRows, "qtyPlanned"),
        releasedQty: sum(receiptRows, "qtyReleased"),
        allocationCount: row.manualAllocations.length,
        dailyPlanCount: row.dailyProductionSchedules.length,
        dailyPlanDraftCount: row.dailyProductionSchedules.filter((item) => item.status === "Draft").length,
        dailyPlanReleasedCount: row.dailyProductionSchedules.filter((item) => ["Released", "In Progress", "Completed"].includes(item.status)).length,
        firstDailyPlanDate: row.dailyProductionSchedules.map((item) => dateKey(item.scheduleDate)).filter(Boolean).sort()[0] || null,
      };
    }),
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

module.exports = { buildExecutionCockpit, closePeriod, reopenPeriod, mergeDisplayMrpRuns, mrpLifecycleStatus };
