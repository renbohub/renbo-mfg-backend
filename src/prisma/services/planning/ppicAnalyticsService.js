"use strict";
const d = require("./ppicWorkspaceDomain");
const a = require("../../../../../library/ppic-workspace/analytics");
const { businessNow } = require("../../utils/businessClock");
const { activeRoleAssignments, rolePermissionMatches, userHasPermission } = require("../ai/permissionEvaluator");
const permissions = {
  production: [["productionLogs", "production", "production-logs"], ["workOrders", "production", "work-orders"], ["dailyProductionSchedules", "production", "daily-production-schedules"]],
  delivery: [["salesOrder", "outgoing", "delivery-schedules"]],
  inventory: [["stockBalances", "inventory", "stock-balances"]],
  subcontract: [["vendorProcessOrders", "production", "vendor-process-orders"]],
  forecast: [["forecast", "sales", "forecasts"]],
  cost: [["workOrders", "production", "work-orders"]],
};
const sections = { A01: ["production", "delivery"], A02: ["delivery"], A03: ["production"], A04: ["production"], A05: ["inventory"], A06: ["subcontract"], A07: ["production"], A08: ["forecast"], A10: ["production"], A11: ["cost"] };
const paths = { production: "/modules/production/production-logs", delivery: "/modules/outgoing/delivery-schedules", inventory: "/modules/inventory/stock-balances", subcontract: "/modules/production/vendor-process-orders", forecast: "/modules/sales/forecasts", cost: "/modules/production/work-orders" };
function assertAnalyticsAccess(user, query) {
  d.assertAccess(user, query);
  const page = query.page || "A01";
  if (!sections[page]) throw d.fail("Halaman analytics tidak ditemukan.", "INVALID_ANALYTICS_PAGE");
  for (const [resourceCode, moduleCode, pageCode] of sections[page].flatMap(key => permissions[key])) {
    const rule = { resourceCode, action: "read" }, context = { moduleCode, pageCode };
    if (!userHasPermission(user, rule, context)) throw d.fail(`Akses read ${resourceCode} diperlukan untuk sumber analytics.`, "ANALYTICS_FORBIDDEN", 403);
    const roles = activeRoleAssignments(user);
    if (!user.isSuperAdmin && roles.length && !roles.some(role => (role.role.permissions || []).some(permission => rolePermissionMatches(permission, rule, context) && d.globalScope(permission.dataScope)))) throw d.fail("Pemetaan scope sumber analytics belum tersedia. Data lintas scope tidak ditampilkan.", "PLANT_SCOPE_UNAVAILABLE", 403);
  }
  return page;
}
function periodFor(query, now = businessNow()) {
  const today = a.localDay(now), month = d.monthKey(query.month || today.slice(0, 7));
  const startDate = `${month}-01`, following = new Date(`${startDate}T00:00:00Z`); following.setUTCMonth(following.getUTCMonth() + 1);
  const lastDay = a.day(+following - 86400000), yesterday = a.day(+new Date(`${today}T00:00:00Z`) - 86400000);
  const requested = d.text(query.cutoff), cutoff = requested || (lastDay < yesterday ? lastDay : yesterday);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoff) || a.day(cutoff) !== cutoff || requested && (cutoff < startDate || cutoff > lastDay || cutoff > today)) throw d.fail("Cutoff harus tanggal valid dalam periode, paling lambat tanggal bisnis hari ini.", "INVALID_ANALYTICS_CUTOFF");
  const end = new Date(`${cutoff}T00:00:00+07:00`); end.setUTCDate(end.getUTCDate() + 1);
  return { month, startDate, cutoff, completedCutoff: cutoff < today ? cutoff : yesterday, startAt: new Date(`${startDate}T00:00:00+07:00`).toISOString(), endAt: new Date(Math.min(+end, +now)).toISOString(), timezone: "Asia/Jakarta", noElapsedPeriod: cutoff < startDate, completeness: "PROVISIONAL", reason: "Cutoff membatasi observasi; hari yang masih berjalan belum eligible OTS. Penutupan lifecycle planning tidak membuktikan rekonsiliasi actual, QC, movement dan shipment." };
}
function filterRows(rows, query, fields) {
  const q = d.text(query.q).toLowerCase();
  return q ? rows.filter(row => fields.some(key => String(row[key] || "").toLowerCase().includes(q))) : rows;
}
function unsupportedFilters(page, query) {
  const allowed = new Set(["page", "month", "cutoff", "basis", "plant", "customer", "resource", "q"]);
  for (const [key, value] of Object.entries(query)) {
    if (!allowed.has(key) && value != null && value !== "" && value !== "ALL") throw d.fail(`Filter ${key} belum didukung analytics.`, "UNSUPPORTED_ANALYTICS_FILTER");
    if (allowed.has(key) && value != null && typeof value !== "string") throw d.fail(`Filter ${key} harus teks tunggal.`, "INVALID_ANALYTICS_FILTER");
  }
  if (d.text(query.customer) && query.customer !== "ALL" && !["A01", "A02", "A03", "A04", "A07", "A08", "A10"].includes(page)) throw d.fail("Sumber halaman ini tidak memiliki kepemilikan customer. Hapus filter customer.", "UNSUPPORTED_ANALYTICS_FILTER");
  if (d.text(query.resource) && query.resource !== "ALL" && !["A03", "A04", "A07", "A10", "A11"].includes(page)) throw d.fail("Sumber halaman ini tidak memiliki pemetaan resource yang lengkap. Hapus filter resource.", "UNSUPPORTED_ANALYTICS_FILTER");
}
async function snapshot(prisma, query = {}, user) {
  unsupportedFilters(query.page || "A01", query);
  const page = assertAnalyticsAccess(user, query), period = periodFor(query), basis = query.basis || "CURRENT";
  if (!["CURRENT", "BASELINE"].includes(basis)) throw d.fail("Pembanding harus CURRENT atau BASELINE.", "INVALID_ANALYTICS_BASIS");
  unsupportedFilters(page, query);
  if ([query.customer, query.resource, query.q].some(value => value != null && String(value).length > 120)) throw d.fail("Filter terlalu panjang.");
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    const eventRange = { gte: new Date(period.startAt), lt: new Date(period.endAt) };
    const datesEnd = new Date(`${period.cutoff}T00:00:00Z`); datesEnd.setUTCDate(datesEnd.getUTCDate() + 1);
    const dateRange = { gte: new Date(`${period.startDate}T00:00:00Z`), lt: datesEnd };
    const customer = query.customer && query.customer !== "ALL" ? query.customer : null, resource = query.resource && query.resource !== "ALL" ? query.resource : null;
    const wants = key => sections[page].includes(key), data = {}, sources = [], metrics = [], raw = [];
    const [customers, machines] = await Promise.all([
      wants("delivery") || wants("production") || wants("forecast") ? tx.customer.findMany({ where: { isDeleted: false }, select: { customerCode: true, customerName: true } }) : [],
      wants("production") || wants("cost") ? tx.machine.findMany({ where: { isDeleted: false }, select: { id: true, machineCode: true, machineName: true } }) : [],
    ]);
    if (customer && !customers.some(row => row.customerCode === customer)) throw d.fail("Customer tidak ditemukan.", "INVALID_FILTER");
    if (resource && !machines.some(row => row.id === resource)) throw d.fail("Resource tidak ditemukan.", "INVALID_FILTER");
    const register = (id, rows, reason, extra = {}) => { raw.push(...rows); sources.push({ id, count: rows.length, asOf: rows.map(row => a.iso(row.updatedAt)).filter(Boolean).sort().at(-1) || null, route: paths[id], status: "AVAILABLE", reason, ...extra }); };
    if (wants("delivery")) {
      const rows = period.noElapsedPeriod ? [] : await tx.deliverySchedule.findMany({ where: { isDeleted: false, status: { not: "Cancelled" }, plannedDate: dateRange, ...(customer ? { soHeader: { customerCode: customer } } : {}) }, include: { soHeader: { select: { customerCode: true, customerName: true } }, details: { where: { isDeleted: false }, include: { soDetail: { select: { partCode: true, partName: true, uomCode: true } } } } }, orderBy: [{ plannedDate: "asc" }, { id: "asc" }] });
      const filtered = filterRows(rows, query, ["scheduleNumber", "soNumber"]); data.service = a.service(filtered, period); metrics.push(...data.service.metrics);
      register("delivery", rows, "Grain jadwal outgoing, bukan split DemandDeliveryTarget. Timestamp berangkat membuktikan OTS terhadap tanggal plannedDate saja.");
    }
    if (wants("production")) {
      const scheduleWhere = { isDeleted: false, scheduleDate: dateRange, ...(customer ? { customerCode: customer } : {}), ...(resource ? { machineId: resource } : {}) };
      const [schedules, logRows] = period.noElapsedPeriod ? [[], []] : await Promise.all([
        tx.dailyProductionSchedule.findMany({ where: scheduleWhere, orderBy: [{ scheduleDate: "asc" }, { scheduleNumber: "asc" }] }),
        tx.productionLog.findMany({ where: { isDeleted: false, OR: [{ logDate: eventRange }, { startTime: { lt: eventRange.lt }, endTime: { gt: eventRange.gte } }], ...(customer ? { dailyProductionSchedule: { customerCode: customer } } : {}), ...(resource ? { machineCode: machines.find(row => row.id === resource).machineCode } : {}) }, include: { workOrder: { select: { woNumber: true, outputPartCode: true, uomCode: true } }, dailyProductionSchedule: { select: { partCode: true, uomCode: true } }, downtimeLogs: { where: { isDeleted: false, status: { not: "Cancelled" } } }, ngReasons: { where: { isDeleted: false } } }, orderBy: [{ logDate: "asc" }, { id: "asc" }] }),
      ]);
      const visible = filterRows(schedules, query, ["scheduleNumber", "woNumber", "partCode"]);
      const q = d.text(query.q).toLowerCase();
      const logs = q ? logRows.filter(row => [row.logNumber, row.workOrder?.woNumber, row.workOrder?.outputPartCode, row.processCode].some(value => String(value || "").toLowerCase().includes(q)) || visible.some(schedule => schedule.id === row.dpsId)) : logRows;
      data.attainment = a.attainment(visible, logs, period, basis); data.production = a.production(logs, period); metrics.push(...data.attainment.metrics, ...data.production.metrics);
      register("production", logRows, "Hanya Approved masuk perhitungan, unik berdasarkan ProductionLog.id. Quantity mengikuti logDate dalam Asia/Jakarta; interval lintas batas periode disertakan hanya untuk union waktu mesin. Tidak memakai qtyProduced sebagai hasil baik.", { approved: logRows.filter(row => row.status === "Approved").length, pending: logRows.filter(row => row.status !== "Approved").length, unmatchedApproved: data.attainment.unmatchedLogIds.length });
      raw.push(...schedules);
    }
    if (wants("inventory")) {
      const rows = await tx.stockBalance.findMany({ where: { isDeleted: false }, orderBy: [{ partCode: "asc" }, { id: "asc" }] });
      data.inventory = a.inventory(filterRows(rows, query, ["partCode", "partName", "materialCode", "lotNumber", "warehouseCode"])); metrics.push(...data.inventory.metrics); register("inventory", rows, data.inventory.reason, { basis: "CURRENT_POSITION", capturedAt: new Date().toISOString() });
    }
    if (wants("subcontract")) {
      const rows = period.noElapsedPeriod ? [] : await tx.vendorProcessOrder.findMany({ where: { isDeleted: false, status: { not: "Cancelled" }, dueDate: dateRange }, orderBy: [{ vendorCode: "asc" }, { id: "asc" }] });
      data.subcontract = a.subcontract(filterRows(rows, query, ["orderNumber", "vendorCode", "vendorName", "outputPartCode", "processName"])); metrics.push(...data.subcontract.metrics); register("subcontract", rows, "Order due dalam periode; qty diterima/accepted adalah posisi kumulatif terkini, bukan actual harian atau bukti accepted sebelum cutoff.");
    }
    if (wants("forecast")) {
      const rows = await tx.forecast.findMany({ where: { isDeleted: false, ...(customer ? { customerCode: customer } : {}) }, include: { details: { where: { isDeleted: false } } }, orderBy: [{ forecastNumber: "asc" }, { revisionNumber: "asc" }] });
      data.forecast = { rows: rows.flatMap(row => row.details.flatMap(detail => [1, 2, 3].filter(index => a.day(detail[`M${index}Forecast`])?.slice(0, 7) === period.month).map(index => ({ id: `${row.id}:${detail.id}:M${index}`, forecastNumber: row.forecastNumber, customerCode: row.customerCode, partCode: detail.partCode, qty: a.num(detail[`M${index}Qty`]), uom: a.uom(detail.uomCode), bucket: row.demandBucket, version: row.version, revision: row.revisionNumber, currentVersion: row.isCurrentVersion, status: row.status, approvedAt: a.iso(row.approvedDate), sourceId: detail.id, frozenBeforePeriod: null, actualDemandQty: null, route: paths.forecast })))), reason: "Daftar versi forecast tersedia. Belum ada bukti snapshot dibekukan sebelum periode beserta definisi actual demand yang disepakati; shipment tidak menggantikan actual demand." };
      data.forecast.rows = filterRows(data.forecast.rows, query, ["forecastNumber", "partCode", "customerCode"]);
      metrics.push(a.metric("forecast_wape", "Forecast WAPE", null, null, { grain: "FG_PERIOD_UOM", definition: "Σ abs(actual demand − forecast frozen) / Σ actual demand.", source: "Forecast version + actual customer demand", comparison: "FROZEN_FORECAST", reason: data.forecast.reason })); register("forecast", rows, data.forecast.reason);
    }
    if (wants("cost")) {
      const rows = period.noElapsedPeriod ? [] : await tx.workOrder.findMany({ where: { isDeleted: false, status: { not: "Cancelled" }, plannedDate: dateRange, ...(resource ? { machineId: resource } : {}) }, orderBy: [{ woNumber: "asc" }, { id: "asc" }] });
      data.cost = { rows: filterRows(rows, query, ["woNumber", "outputPartCode", "outputPartName"]).map(row => ({ id: row.id, woNumber: row.woNumber, partCode: row.outputPartCode, processId: row.processId, plannedCostRecorded: a.num(row.plannedProcessCost), actualCostRecorded: a.num(row.actualProcessCost), currency: row.machineCurrency || null, rate: a.num(row.machineCostingRate), rateType: row.machineRateType, status: row.status, verifiedDeviation: null, route: paths.cost })), reason: "Biaya pada WO adalah nilai costing tercatat. Atribusi penyebab deviasi, baseline biaya disetujui dan bukti posting belum dipetakan. Nilai default nol tidak dianggap biaya terverifikasi." };
      metrics.push(a.metric("cost_deviation", "Cost of deviation terverifikasi", null, null, { unit: "currency", grain: "WO_COST_EVENT_CURRENCY", definition: "Biaya deviasi terhadap baseline disetujui, menurut kejadian dan mata uang yang sama.", source: "WorkOrder costing; ledger posting dan atribusi belum tersedia", comparison: basis, reason: data.cost.reason })); register("cost", rows, data.cost.reason);
    }
    const generatedAt = new Date().toISOString();
    return { schemaVersion: 1, page, month: period.month, period, basis, generatedAt, sourceFingerprint: d.hash({ version: 2, page, period, basis, filters: { customer, resource, q: query.q || null }, raw }), scope: { id: "ERP_GLOBAL", label: "Seluruh ERP", plantMappingAvailable: false }, sources, metrics: metrics.map(row => ({ ...row, period: { start: period.startDate, cutoff: period.cutoff }, provisional: true })), data, filters: { customers: customers.map(row => ({ value: row.customerCode, label: row.customerName })), resources: machines.map(row => ({ value: row.id, label: row.machineCode })), supportsCustomer: ["A01", "A02", "A03", "A04", "A07", "A08", "A10"].includes(page), supportsResource: ["A03", "A04", "A07", "A10", "A11"].includes(page) }, capabilities: { read: true, export: true, officialMutation: false } };
  }, { isolationLevel: "RepeatableRead", timeout: 120000 });
}
module.exports = { snapshot, assertAnalyticsAccess, periodFor, unsupportedFilters };
