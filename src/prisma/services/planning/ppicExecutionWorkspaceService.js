"use strict";
const d = require("./ppicWorkspaceDomain");
const { activeRoleAssignments, rolePermissionMatches, userHasPermission } = require("../ai/permissionEvaluator");
const { businessNow } = require("../../utils/businessClock");
const { projectDemand } = require("./ppicWorkspaceService");
const routes = { Production: "/modules/production/daily-production-schedules", Inventory: "/modules/production/material-issues", QC: "/modules/qc/quality-inspections", PPIC: "/modules/planning-ppic/execution/dispatch-board", WIP: "/modules/production/wip", Logs: "/modules/production/production-logs" };
const sourcePermissions = [
  ["dailyProductionSchedules", "production", "daily-production-schedules"], ["productionLogs", "production", "production-logs"],
  ["workOrders", "production", "work-orders"], ["materialIssues", "production", "material-issues"],
  ["wip", "production", "wip"], ["stockBalances", "inventory", "stock-balances"],
];
function assertExecutionAccess(user, query = {}) {
  d.assertAccess(user, query);
  for (const [resourceCode, moduleCode, pageCode] of sourcePermissions) {
    const rule = { resourceCode, action: "read" }, context = { moduleCode, pageCode };
    if (!userHasPermission(user, rule, context)) throw d.fail(`Akses read ${resourceCode} diperlukan untuk sumber execution.`, "EXECUTION_FORBIDDEN", 403);
    const roles = activeRoleAssignments(user);
    if (!user.isSuperAdmin && roles.length && !roles.some(a => (a.role.permissions || []).some(p => rolePermissionMatches(p, rule, context) && d.globalScope(p.dataScope)))) throw d.fail("Scope sumber execution belum dapat dipetakan. Data lintas scope tidak ditampilkan.", "PLANT_SCOPE_UNAVAILABLE", 403);
  }
}
const day = value => d.iso(value)?.slice(0, 10) || null;
const maxDate = values => values.map(d.iso).filter(Boolean).sort().at(-1) || null;
const normalizeUom = value => value ? String(value).trim().toUpperCase() : null;
function dateKey(value) {
  const result = value || new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(businessNow());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || day(result) !== result || result < "1900-01-01" || result > "2199-12-31") throw d.fail("Tanggal harus YYYY-MM-DD yang valid.", "INVALID_EXECUTION_DATE");
  return result;
}
function plannedInterval(row) {
  const date = day(row.scheduleDate), valid = value => typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(value);
  if (!date || !valid(row.plannedStartTime) || !valid(row.plannedEndTime)) return null;
  const start = new Date(`${date}T${row.plannedStartTime.length === 5 ? row.plannedStartTime + ":00" : row.plannedStartTime}+07:00`), end = new Date(`${date}T${row.plannedEndTime.length === 5 ? row.plannedEndTime + ":00" : row.plannedEndTime}+07:00`);
  if (+start === +end) return null;
  if (end < start) end.setUTCDate(end.getUTCDate() + 1);
  return { startAt: start.toISOString(), endAt: end.toISOString(), basis: "CURRENT_DAILY_SCHEDULE", timezone: "Asia/Jakarta" };
}
function approvedActual(logs = []) {
  const approved = [...new Map(logs.filter(row => row.status === "Approved" && !row.isDeleted).map(row => [row.id, row])).values()];
  return { goodQty: approved.reduce((sum, row) => sum + Number(row.qtyGood), 0), rejectQty: approved.reduce((sum, row) => sum + Number(row.qtyReject), 0), approvedLogCount: approved.length, pendingLogCount: logs.filter(row => !row.isDeleted && row.status !== "Approved").length,
    actual: approved.length ? { startAt: approved.map(row => d.iso(row.startTime)).filter(Boolean).sort()[0] || null, endAt: approved.every(row => d.iso(row.endTime)) ? maxDate(approved.map(row => row.endTime)) : null, basis: "APPROVED_PRODUCTION_LOG" } : null };
}
const check = (code, status, reason, owner, extra = {}) => ({ code, status, reason, owner, route: routes[owner] || routes.Production, ...extra });
function projectOperation(row, context) {
  const { workOrders, parts, customers, machines, issues, events, predecessorOutput, allocationById, planTargets } = context;
  const wo = workOrders.get(row.woId), part = parts.get(row.partCode), machine = machines.get(row.machineId), customer = customers.get(row.customerCode);
  const current = plannedInterval(row), actual = approvedActual(row.productionLogs), vendor = String(row.shift).toUpperCase() === "VENDOR";
  const linkedIssues = issues.filter(issue => issue.woId === row.woId && issue.moId === row.moId && String(issue.notes || "").includes(`[DPS-CONSUME:${row.scheduleNumber}]`));
  const posted = linkedIssues.filter(issue => ["Issued", "Partially Returned", "Closed"].includes(issue.status));
  const postedDetails = posted.flatMap(issue => issue.details || []).filter(detail => !detail.isDeleted && Number(detail.qtyIssued) - Number(detail.qtyReturned) > 0);
  const openIssues = issues.filter(issue => issue.woId && issue.woId === row.woId && ["Draft", "Pending", "Released", "Preparing"].includes(issue.status));
  const readiness = [check("PLAN_TRACE", wo?.isReworkOrder ? "NA" : row.productionPlanId && row.productionPlanAllocationId && row.mbomProcessId ? "OK" : "BLOCKER", wo?.isReworkOrder ? "WO rework memakai workflow produksi rework terpisah." : row.productionPlanId && row.productionPlanAllocationId && row.mbomProcessId ? "Referensi MPP, allocation dan routing tersedia." : "Referensi MPP, allocation atau routing belum lengkap.", "PPIC")];
  if (vendor) readiness.push(check("MATERIAL_ISSUE", "NA", "Proses vendor memakai workflow pengiriman vendor.", "Inventory"));
  else if (wo?.isReworkOrder) readiness.push(check("MATERIAL_ISSUE", "UNKNOWN", "Kesiapan sumber rework harus diverifikasi oleh workflow rework.", "Inventory"));
  else readiness.push(check("MATERIAL_ISSUE", postedDetails.length && !openIssues.length && ["Material Issued", "In Production"].includes(wo?.status) ? "OK" : "BLOCKER", !wo ? "Referensi WO belum tersedia." : openIssues.length ? "Material Issue masih terbuka dan belum selesai diposting Inventory." : !postedDetails.length ? "Belum ada detail material positif yang diposting untuk jadwal ini." : !["Material Issued", "In Production"].includes(wo.status) ? `Status WO ${wo.status} belum siap start.` : "Material Issue jadwal telah diposting; WO siap menurut status sumber.", "Inventory", { references: posted.map(issue => issue.issueNumber) }));
  const allocation = allocationById.get(row.productionPlanAllocationId), predecessorIds = allocation?.predecessorAllocationIds;
  if (vendor || wo?.isReworkOrder) readiness.push(check("PREDECESSOR_GOOD", "UNKNOWN", "Kesiapan predecessor vendor / rework diverifikasi pada workflow owner.", "Production"));
  else if (!Array.isArray(predecessorIds)) readiness.push(check("PREDECESSOR_GOOD", "UNKNOWN", "Relasi predecessor allocation belum tersedia.", "Production"));
  else if (!predecessorIds.length) readiness.push(check("PREDECESSOR_GOOD", "NA", "Allocation sumber tidak memiliki predecessor.", "Production"));
  else {
    const evidence = predecessorIds.map(id => {
      const predecessor = allocationById.get(id), output = predecessorOutput.get(id), predecessorTarget = planTargets.get(`${predecessor?.planId}:${predecessor?.lineNumber}`), target = planTargets.get(`${allocation.planId}:${allocation.lineNumber}`);
      if (!predecessor || !output || (normalizeUom(predecessor.uomCode) !== normalizeUom(row.uomCode) && !(predecessorTarget > 0 && target > 0))) return { allocationId: id, status: "UNKNOWN", goodQty: output?.goodQty ?? null, reason: "Output atau konversi coverage predecessor belum tersedia." };
      const result = require("./capacityPlanningService").predecessorQuantityStatus(output.goodQty, predecessorTarget, row.plannedQty, target, predecessor.uomCode, row.uomCode);
      return { allocationId: id, status: result.short ? "BLOCKER" : "OK", goodQty: output.goodQty, uom: predecessor.uomCode, mode: result.mode, reason: result.short ? "Hasil baik Approved predecessor belum menutup kebutuhan operasi." : "Hasil baik Approved predecessor menutup kebutuhan operasi." };
    });
    readiness.push(check("PREDECESSOR_GOOD", d.worst(evidence.map(item => item.status)), evidence.find(item => item.status !== "OK")?.reason || "Semua predecessor memiliki coverage hasil baik yang cukup.", "Production", { evidence }));
  }
  const conflicts = current && row.machineId ? events.filter(event => event.machineId === row.machineId && ["BREAKDOWN", "MAINTENANCE", "SETUP_DELAY"].includes(event.eventType) && new Date(event.startedAt) < new Date(current.endAt) && (!event.endedAt || new Date(event.endedAt) > new Date(current.startAt))) : [];
  readiness.push(check("MACHINE_ASSIGNMENT", vendor ? "NA" : !machine || machine.status !== "Active" ? "BLOCKER" : conflicts.length ? "BLOCKER" : "OK", vendor ? "Proses menggunakan vendor." : !machine ? "Mesin belum terpasang atau sudah tidak tersedia." : machine.status !== "Active" ? "Mesin tidak aktif." : conflicts.length ? "Interval bertabrakan dengan gangguan atau perawatan mesin." : "Mesin aktif; tidak ada gangguan tercatat yang beririsan dengan interval diketahui.", "Production", { evidence: conflicts.map(event => ({ id: event.id, reason: event.reason, startedAt: d.iso(event.startedAt), endedAt: d.iso(event.endedAt) })) }));
  readiness.push(check("DISPATCH_CALENDAR", "UNKNOWN", "Validasi kalender, dies dan overlap final dijalankan ulang oleh workflow dispatch saat tindakan dilakukan.", "Production"));
  readiness.push(check("OPERATOR_QUALIFICATION", vendor ? "NA" : "UNKNOWN", vendor ? "Penugasan operator berada pada vendor." : row.operatorName ? `Operator ${row.operatorName} tercatat; bukti kompetensi untuk resource belum terhubung.` : "Operator dan bukti kompetensi resource belum terhubung.", "Production"));
  // Current start gates must not relabel a completed or cancelled historical operation as unready.
  if (["Completed", "Cancelled"].includes(row.status)) for (const item of readiness) { item.observedStatus = item.status; item.status = "NA"; item.reason = `Operasi ${row.status}; gate start saat ini tidak berlaku. Bukti historis tersimpan pada sumber.`; }
  const operation = { id: row.id, scheduleNumber: row.scheduleNumber, scheduleDate: day(row.scheduleDate), woId: row.woId, woNumber: row.woNumber || wo?.woNumber || null, moNumber: row.moNumber || null, partCode: row.partCode, partName: part?.partName || wo?.outputPartName || row.partCode, processCode: wo?.process?.processCode || null, processName: wo?.process?.processName || null, uom: normalizeUom(row.uomCode || wo?.uomCode), plannedQty: d.numeric(row.plannedQty), ...actual, remainingQty: Math.max(Number(row.plannedQty) - actual.goodQty, 0), grain: "OPERATION", resourceId: row.machineId, resourceCode: machine?.machineCode || null, resourceName: machine?.machineName || null, customerCode: row.customerCode || null, customerName: customer?.customerName || row.customerCode || null, shift: row.shift, status: row.status, current, baseline: null, forecast: null, baselineReason: "Pemetaan operasi baseline release immutable ke WO/DPS official belum tersedia.", forecastReason: "Forecast penyelesaian belum memiliki model dan bukti laju aktual yang terhubung.", readiness, readinessStatus: d.worst(readiness.map(item => item.status)), materialIssueStatus: readiness.find(item => item.code === "MATERIAL_ISSUE").status, predecessorStatus: readiness.find(item => item.code === "PREDECESSOR_GOOD").status, updatedAt: d.iso(row.updatedAt), actualBasis: "Hanya qtyGood dan qtyReject Production Log Approved; reject tidak ditambah ke kekurangan.", route: routes.Production, actionRoutes: [{ label: "Buka jadwal produksi", route: routes.Production }, { label: "Buka Material Issue", route: routes.Inventory }, { label: "Buka laporan produksi", route: routes.Logs }] };
  return operation;
}
function projectLot(row) {
  return { id: row.id, partCode: row.partCode, partName: row.partName, uom: normalizeUom(row.uomCode), lotNumber: row.lotNumber, warehouseCode: row.warehouseCode, rackCode: row.rackCode, stockType: row.stockType, qtyOnHand: d.numeric(row.qtyOnHand), qtyReserved: d.numeric(row.qtyReserved), qtyQC: d.numeric(row.qtyQC), qtyAvailable: d.numeric(row.qtyAvailable), qualityStatus: row.qtyQC > 0 ? "HOLD" : "UNKNOWN", qualityReason: row.qtyQC > 0 ? "Saldo masih memuat quantity dalam QC." : "Saldo tersedia di ledger; bukti release QC per lot belum terhubung pada adapter ini.", sourceOperationId: null, nextProcess: null, updatedAt: d.iso(row.updatedAt), route: routes.WIP };
}
async function snapshot(prisma, query, user) {
  assertExecutionAccess(user, query);
  const date = dateKey(query.date), month = date.slice(0, 7), shift = d.text(query.shift), resource = d.text(query.resource), customer = d.text(query.customer), search = d.text(query.q).toLowerCase();
  if ([shift, resource, customer, search].some(value => value.length > 120)) throw d.fail("Filter execution terlalu panjang.");
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    const start = new Date(`${date}T00:00:00Z`), end = new Date(start); end.setUTCDate(end.getUTCDate() + 1);
    const actualStart = new Date(`${date}T00:00:00+07:00`), actualEnd = new Date(actualStart); actualEnd.setUTCDate(actualEnd.getUTCDate() + 1);
    const [schedules, parts, customers, machines, calendar, targets] = await Promise.all([
      tx.dailyProductionSchedule.findMany({ where: { isDeleted: false, scheduleDate: { gte: start, lt: end } }, orderBy: [{ schedulePriority: "asc" }, { scheduleNumber: "asc" }], include: { productionLogs: { where: { isDeleted: false } }, productionPlanAllocation: true } }),
      tx.part.findMany({ where: { isDeleted: false }, select: { partCode: true, partName: true } }), tx.customer.findMany({ where: { isDeleted: false }, select: { customerCode: true, customerName: true } }), tx.machine.findMany({ where: { isDeleted: false } }), require("./deliveryCalendarService").deliveryCalendar(tx),
      tx.demandDeliveryTarget.findMany({ where: { isDeleted: false, status: "ACTIVE" }, select: { id: true, sourceNumber: true, sourceLineId: true, uomCode: true, updatedAt: true } }),
    ]);
    if (resource && resource !== "ALL" && !machines.some(row => row.id === resource)) throw d.fail("Resource tidak ditemukan.", "INVALID_FILTER");
    if (customer && customer !== "ALL" && !customers.some(row => row.customerCode === customer)) throw d.fail("Customer tidak ditemukan.", "INVALID_FILTER");
    const shifts = [...new Set(schedules.map(row => row.shift).filter(Boolean))];
    // Shift is an observed schedule identifier, not an assumed fixed three-shift template.
    if (shift && shift !== "ALL" && !shifts.includes(shift)) throw d.fail("Shift tidak ditemukan pada tanggal terpilih.", "INVALID_FILTER");
    const filtered = schedules.filter(row => (!shift || shift === "ALL" || row.shift === shift) && (!resource || resource === "ALL" || row.machineId === resource) && (!customer || customer === "ALL" || row.customerCode === customer));
    const woIds = [...new Set(filtered.map(row => row.woId).filter(Boolean))], machineIds = [...new Set(filtered.map(row => row.machineId).filter(Boolean))], predecessorIds = [...new Set(filtered.flatMap(row => Array.isArray(row.productionPlanAllocation?.predecessorAllocationIds) ? row.productionPlanAllocation.predecessorAllocationIds : []))];
    const [workOrders, issues, events, predecessors, predecessorSchedules] = await Promise.all([
      tx.workOrder.findMany({ where: { id: { in: woIds }, isDeleted: false }, include: { process: true } }), tx.materialIssue.findMany({ where: { woId: { in: woIds }, isDeleted: false }, include: { details: { where: { isDeleted: false } } } }),
      tx.machineAvailabilityEvent.findMany({ where: { machineId: { in: machineIds }, isDeleted: false, status: { not: "CANCELLED" }, startedAt: { lt: new Date(+actualEnd + 86400000) }, OR: [{ endedAt: null }, { endedAt: { gt: actualStart } }] } }),
      tx.productionPlanAllocation.findMany({ where: { id: { in: predecessorIds }, isDeleted: false } }), tx.dailyProductionSchedule.findMany({ where: { isDeleted: false, status: "Completed", productionPlanAllocationId: { in: predecessorIds } }, include: { productionLogs: { where: { isDeleted: false, status: "Approved" } } } }),
    ]);
    const allocationById = new Map([...predecessors, ...filtered.map(row => row.productionPlanAllocation).filter(Boolean)].map(row => [row.id, row]));
    const planIds = [...new Set([...allocationById.values()].map(row => row.planId).filter(Boolean))];
    const planDetails = await tx.monthlyProductionPlanDetail.findMany({ where: { planId: { in: planIds }, isDeleted: false }, select: { planId: true, lineNumber: true, qtyPlanned: true } });
    const predecessorOutput = new Map(predecessors.map(row => [row.id, approvedActual(predecessorSchedules.filter(schedule => schedule.productionPlanAllocationId === row.id).flatMap(schedule => schedule.productionLogs))]));
    const context = { parts: new Map(parts.map(row => [row.partCode, row])), customers: new Map(customers.map(row => [row.customerCode, row])), machines: new Map(machines.map(row => [row.id, row])), workOrders: new Map(workOrders.map(row => [row.id, row])), issues, events, predecessorOutput, allocationById, planTargets: new Map(planDetails.map(row => [`${row.planId}:${row.lineNumber}`, row.qtyPlanned])) };
    const operations = filtered.map(row => projectOperation(row, context)).filter(row => !search || [row.scheduleNumber, row.woNumber, row.partCode, row.partName, row.processName, row.resourceCode, row.customerCode].filter(Boolean).join(" ").toLowerCase().includes(search));
    const visibleParts = [...new Set(operations.map(row => row.partCode).filter(Boolean))], scopedParts = Boolean((resource && resource !== "ALL") || (customer && customer !== "ALL") || (shift && shift !== "ALL"));
    const stockWhere = { isDeleted: false, stockType: { in: ["WIP", "Semi-Finished", "Semi Finished", "SFG"] }, ...(scopedParts ? { partCode: { in: visibleParts } } : {}), ...(search ? { OR: [{ partCode: { contains: search, mode: "insensitive" } }, { partName: { contains: search, mode: "insensitive" } }, { lotNumber: { contains: search, mode: "insensitive" } }] } : {}) };
    const movementWhere = { ...stockWhere, movementDate: { gte: actualStart, lt: actualEnd } };
    const [stockRows, stockTotal, movementRows, movementTotal] = await Promise.all([tx.stockBalance.findMany({ where: stockWhere, orderBy: [{ updatedAt: "desc" }, { id: "asc" }], take: 500 }), tx.stockBalance.count({ where: stockWhere }), tx.stockMovement.findMany({ where: movementWhere, orderBy: [{ movementDate: "desc" }, { id: "asc" }], take: 500 }), tx.stockMovement.count({ where: movementWhere })]);
    const lots = stockRows.map(projectLot), movements = movementRows.map(row => ({ id: row.id, movementNumber: row.movementNumber, occurredAt: d.iso(row.movementDate), direction: row.direction || row.movementType, transactionType: row.transactionType, qty: d.numeric(row.qty), uom: normalizeUom(row.uomCode), partCode: row.partCode, partName: row.partName, lotNumber: row.lotNumber, warehouseCode: row.warehouseCode, rackCode: row.rackCode, referenceType: row.referenceType, referenceNumber: row.referenceNumber, qualityBucket: row.qualityBucket, route: "/modules/inventory/stock-movements" }));
    const dueDeliveries = projectDemand(calendar, targets, parts, customers, { items: [] }, month).filter(row => day(row.dueAt) === date && (!customer || customer === "ALL" || row.customerCode === customer) && ((!resource || resource === "ALL") && (!shift || shift === "ALL") || visibleParts.includes(row.partCode)) && (!search || [row.partCode, row.partName, row.sourceNumber, row.customerCode].filter(Boolean).join(" ").toLowerCase().includes(search)));
    const exceptions = operations.flatMap(row => row.readiness.filter(item => ["BLOCKER", "UNKNOWN", "CONDITIONAL"].includes(item.status)).map(item => ({ id: `${row.id}:${item.code}`, title: item.reason, status: item.status, owner: item.owner, operationId: row.id, scheduleNumber: row.scheduleNumber, materialCode: null, shortageQty: null, uom: row.uom, needBy: row.current?.startAt || null, eta: null, reason: item.reason, route: item.route })));
    const generatedAt = new Date().toISOString();
    const sources = [
      { id: "schedule", label: "Daily Production Schedule", status: "AVAILABLE", asOf: maxDate(schedules.map(row => row.updatedAt)), route: routes.Production },
      { id: "actual", label: "Hasil baik Approved", status: "AVAILABLE", asOf: maxDate(schedules.flatMap(row => row.productionLogs.map(log => log.updatedAt))), reason: "QtyGood dan qtyReject per operasi; quantity tidak dijumlahkan sebagai output FG lintas proses.", route: routes.Logs },
      { id: "baseline", label: "Baseline release", status: "UNKNOWN", asOf: null, reason: "Pemetaan baseline immutable ke operasi official belum tersedia.", route: "/modules/planning-ppic/labs/release-baseline" },
      { id: "forecast", label: "Forecast penyelesaian", status: "UNKNOWN", asOf: null, reason: "Forecast belum dihitung dari model eksekusi yang tervalidasi.", route: routes.Production },
      { id: "wip", label: "Stok fisik WIP dan movement", status: "AVAILABLE", asOf: maxDate(stockRows.map(row => row.updatedAt)), reason: "Saldo fisik terkini per lot/lokasi/satuan; ledger biaya WIP tidak dijumlahkan menjadi stok.", route: routes.WIP },
    ];
    return { schemaVersion: 1, date, month, timezone: "Asia/Jakarta", generatedAt, sourceStatus: "PARTIAL", sources, scope: { id: "ERP_GLOBAL", label: "Seluruh ERP", plantMappingAvailable: false }, capabilities: { read: true, dispatch: false, start: false, complete: false, transfer: false },
      filters: { plants: [{ value: "ALL", label: "Seluruh ERP" }], customers: customers.map(row => ({ value: row.customerCode, label: row.customerName })), resources: machines.map(row => ({ value: row.id, label: row.machineCode })), shifts: shifts.map(value => ({ value, label: value })) },
      summary: { operationCount: operations.length, deliveryCount: dueDeliveries.length, plannedByUom: d.totalsByUom(operations, "plannedQty"), goodByUom: d.totalsByUom(operations, "goodQty"), rejectByUom: d.totalsByUom(operations, "rejectQty"), remainingByUom: d.totalsByUom(operations, "remainingQty"), quantityGrain: "OPERATION", quantityBasis: "Total operation quantity, bukan total FG; satu part yang melewati beberapa proses tetap dihitung pada setiap operasi.", unknownReadinessCount: operations.filter(row => row.readiness.some(item => item.status === "UNKNOWN")).length, blockedCount: operations.filter(row => row.readinessStatus === "BLOCKER").length },
      dueDeliveries, operations, exceptions, wip: { lots, movements, summaryByUom: d.totalsByUom(lots, "qtyOnHand"), asOf: maxDate(stockRows.map(row => row.updatedAt)), status: stockTotal > 500 || movementTotal > 500 ? "PARTIAL" : "AVAILABLE", reason: "Tanggal memfilter movement. Saldo lot adalah posisi terkini; filter resource/customer memakai part operasi terpilih, bukan kepemilikan lot customer. QC release dan tujuan proses belum dipetakan.", currentBalance: true, totalLots: stockTotal, totalMovements: movementTotal, limit: 500, truncated: stockTotal > 500 || movementTotal > 500, summaryBasis: "LOADED_LOTS" } };
  }, { isolationLevel: "RepeatableRead", timeout: 120000 });
}
module.exports = { snapshot, assertExecutionAccess, dateKey, plannedInterval, approvedActual, projectOperation, projectLot };
