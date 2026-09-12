"use strict";
const d = require("./ppicWorkspaceDomain");
const permissions = require("../ai/permissionEvaluator");
const etaStore = require("../purchasing/etaConfirmationStore");
const period = require("./periodClosingService");
const LIMIT = 5000;
const PAGES = { "subcontract-control": "E06", "delivery-fulfillment": "E07", "exceptions-recovery": "E08", "change-control": "E09", "reconciliation-closure": "E10" };
const SOURCE_PERMISSIONS = {
  E06: [["vendorProcessOrders", "production", "vendor-process-orders"]],
  E07: [["salesOrder", "outgoing", "delivery-schedules"], ["forecast", "sales", "forecasts"]],
  E08: [], E09: [["dailyProductionSchedules", "production", "daily-production-schedules"]],
  E10: [["productionLogs", "production", "production-logs"], ["stockOpname", "inventory", "stock-opname"], ["vendorProcessOrders", "production", "vendor-process-orders"], ["salesOrder", "sales", "sales-order"]],
};
const day = v => d.iso(v)?.slice(0, 10) || null;
const nowDay = now => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
const eventDay = value => d.iso(value) ? nowDay(new Date(value)) : null;
const link = (label, route) => ({ label, route });
const round = n => Math.round(n * 1e6) / 1e6;
const qty = v => { const n = d.numeric(v); return n !== null && n >= 0 ? n : null; };
const metric = (id, label, value, unit = "dokumen") => ({ id, label, value, unit });
// Missing UOM is not a shared unit and therefore never forms an additive pool.
const unitTotals = (rows, field = "qty") => d.totalsByUom(rows.filter(r => r.uom && qty(r[field]) !== null), field);
function assertSource(user, rule) {
  const [resourceCode, moduleCode, pageCode] = rule, requirement = { resourceCode, action: "read" }, context = { moduleCode, pageCode };
  if (!permissions.userHasPermission(user, requirement, context)) throw d.fail(`Akses read ${resourceCode} diperlukan.`, "FOLLOWUP_FORBIDDEN", 403);
  const roles = permissions.activeRoleAssignments(user);
  if (!user.isSuperAdmin && roles.length && !roles.some(a => (a.role.permissions || []).some(p => permissions.rolePermissionMatches(p, requirement, context) && d.globalScope(p.dataScope)))) throw d.fail(`Pemetaan scope ${resourceCode} belum tersedia untuk agregasi seluruh ERP.`, "PLANT_SCOPE_UNAVAILABLE", 403);
}
function normalize(page, query = {}, now = new Date()) {
  const pageId = PAGES[page];
  if (!pageId) throw d.fail("Halaman tindak lanjut tidak ditemukan.", "FOLLOWUP_NOT_FOUND", 404);
  for (const key of ["month", "date", "customer", "resource", "plant", "status", "q", "shift"]) if (query[key] != null && typeof query[key] !== "string") throw d.fail(`Filter ${key} harus teks.`);
  const date = query.date || (query.month ? `${d.monthKey(query.month)}-01` : nowDay(now));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || day(date) !== date) throw d.fail("Tanggal harus YYYY-MM-DD yang valid.", "INVALID_DATE");
  const month = d.monthKey(query.month || date.slice(0, 7));
  if (month !== date.slice(0, 7)) throw d.fail("Bulan dan tanggal filter harus berada pada periode yang sama.");
  const filters = { customer: query.customer || "ALL", resource: query.resource || "ALL", status: query.status || "ALL", q: (query.q || "").trim(), shift: query.shift || "ALL" };
  if (filters.q.length > 200 || filters.status.length > 80 || filters.customer.length > 100) throw d.fail("Filter terlalu panjang.");
  if (filters.resource !== "ALL" || filters.shift !== "ALL" || (pageId !== "E07" && filters.customer !== "ALL")) throw d.fail("Sumber halaman ini belum memiliki pemetaan resource/shift/customer yang lengkap. Gunakan Semua; pencarian teks tersedia.", "FOLLOWUP_FILTER_UNAVAILABLE");
  const bounds = period.periodBounds(month);
  // ERP planning dates use canonical date-only UTC; event timestamps are real instants in Jakarta.
  return { pageId, month, date, filters, ...bounds, eventStart: new Date(bounds.start.getTime() - 7 * 3600000), eventEndExclusive: new Date(bounds.endExclusive.getTime() - 7 * 3600000) };
}
function assertAccess(user, page, query = {}) { d.assertAccess(user, query); for (const rule of SOURCE_PERMISSIONS[PAGES[page]] || []) assertSource(user, rule); }
function base(spec, now) {
  return { schemaVersion: 1, pageId: spec.pageId, month: spec.month, date: spec.date, timezone: "Asia/Jakarta", generatedAt: now.toISOString(), scope: { plant: "ERP_GLOBAL", label: "Seluruh ERP", basis: "CURRENT_SOURCE_POSITION", historicalAsOf: false }, filters: spec.filters, summary: [], items: [], related: [], checks: [], sources: [], limitations: ["Tanggal/bulan memilih cakupan dokumen; posisi dan status adalah data saat ini, bukan rekonstruksi saldo historis."], actionRoutes: [], capabilities: { read: true, refresh: true, mutate: false, close: false, reopen: false, publish: false, actionMode: "GUARDED_OWNER_WORKFLOW" } };
}
function source(out, id, label, rows, reason = null) {
  const truncated = rows.length > LIMIT;
  const dates = rows.flatMap(r => [d.iso(r.updatedAt), d.iso(r.createdAt)]).filter(Boolean).sort();
  out.sources.push({ id, label, count: Math.min(rows.length, LIMIT), truncated, completeness: truncated ? "INCOMPLETE" : "COMPLETE", status: rows.length ? "AVAILABLE" : "EMPTY", latestSourceUpdateAt: dates.at(-1) || null, certifiedCutoffAt: null, reason });
  if (truncated) { out.checks.push({ id: `${id}_truncated`, label: label, status: "UNKNOWN", mandatory: true, reason: `Lebih dari ${LIMIT} baris. Persempit periode; total bukan sertifikasi keseluruhan sumber.` }); out.limitations.push(`${label}: tampilan dibatasi ${LIMIT} baris.`); }
  return rows.slice(0, LIMIT);
}
function filtered(rows, spec) {
  const q = spec.filters.q.toLowerCase(), status = spec.filters.status;
  return rows.filter(r => (status === "ALL" || r.status === status) && (!q || [r.id, r.orderNumber, r.vendorCode, r.vendorName, r.partCode, r.partName, r.processCode, r.customerCode, r.sourceNumber, r.scheduleNumber, r.title, r.revisionNumber, r.documentNumber, r.label].filter(Boolean).join(" ").toLowerCase().includes(q)));
}
function vendorSource(r) {
  // Exact fingerprint fields used by Purchasing ETA Monitor; order deadline is not a commitment.
  return { id: `VO:${r.id}`, sourceVersion: r.updatedAt, partnerCode: r.vendorCode, code: r.outputPartCode, process: r.processCode, needDate: r.dueDate, targetArrivalDate: r.dueDate, eta: null, sendDate: r.sentAt, qty: r.qtyPlanned, uom: r.uomCode, confirmed: false, source: r.orderNumber };
}
function vendorPosition(r, confirmation) {
  const sent = qty(r.qtySent), received = qty(r.qtyReceived), accepted = qty(r.qtyAccepted), rejected = qty(r.qtyReject);
  const sane = [sent, received, accepted, rejected].every(v => v !== null) && received <= sent + 1e-6 && accepted + rejected <= received + 1e-6;
  const decorated = etaStore.decorate(vendorSource(r), confirmation);
  return { id: r.id, orderNumber: r.orderNumber, vendorCode: r.vendorCode, vendorName: r.vendorName, partCode: r.outputPartCode, partName: r.outputPartName, processCode: r.processCode, uom: r.uomCode || null, status: r.status, operationId: null, operationMappingStatus: "UNKNOWN", plannedQty: qty(r.qtyPlanned), sentQty: sent, receivedQty: received, acceptedQty: accepted, rejectedQty: rejected, reworkQty: qty(r.qtyRework), scrapQty: qty(r.qtyScrap), pendingQcQty: sane ? round(received - accepted - rejected) : null, notReturnedQty: sane ? round(sent - received) : null, positionBasis: "CUMULATIVE_VENDOR_ORDER", integrityStatus: sane ? "OK" : "BLOCKER", dueDate: day(r.dueDate), sentAt: d.iso(r.sentAt), receivedAt: d.iso(r.receivedAt), updatedAt: d.iso(r.updatedAt), eta: decorated.confirmed ? decorated.eta : null, confirmationStatus: decorated.confirmed ? "CONFIRMED" : decorated.confirmationRecord ? "STALE" : "UNKNOWN", confirmation: decorated.confirmationRecord ? { ...decorated.confirmationRecord, at: d.iso(decorated.confirmationRecord.at) } : null, sourceFingerprint: decorated.sourceFingerprint, actionRoutes: [link("Buka order vendor", `/modules/production/vendor-process-orders/${encodeURIComponent(r.orderNumber)}`)] };
}
async function vendorRows(tx, spec) {
  return tx.vendorProcessOrder.findMany({ where: { isDeleted: false, OR: [{ dueDate: { gte: spec.start, lt: spec.endExclusive } }, { sentAt: { gte: spec.eventStart, lt: spec.eventEndExclusive } }, { receivedAt: { gte: spec.eventStart, lt: spec.eventEndExclusive } }, { status: { notIn: ["Closed", "Cancelled", "Completed"] }, orderDate: { lt: spec.endExclusive } }] }, orderBy: [{ dueDate: "asc" }, { id: "asc" }], take: LIMIT + 1 });
}
async function subcontract(tx, spec, out) {
  const rows = source(out, "vendor_orders", "Order proses vendor", await vendorRows(tx, spec)), records = await etaStore.latest(tx, rows.map(r => `VO:${r.id}`));
  out.items = filtered(rows.map(r => vendorPosition(r, records.get(`VO:${r.id}`))), spec);
  out.summary = [metric("orders", "Order vendor", out.items.length), metric("unconfirmed", "Komitmen belum valid", out.items.filter(r => r.confirmationStatus !== "CONFIRMED").length), metric("pending_qc", "Order menunggu QC", out.items.filter(r => r.pendingQcQty > 0).length), metric("inconsistent", "Posisi tidak konsisten", out.items.filter(r => r.integrityStatus === "BLOCKER").length)];
  out.byUom = { sent: unitTotals(out.items, "sentQty"), received: unitTotals(out.items, "receivedQty"), accepted: unitTotals(out.items, "acceptedQty") };
  out.checks.push({ id: "operation_mapping", label: "Pegging vendor ke operation/delivery", status: "UNKNOWN", mandatory: true, reason: "VendorProcessOrder belum terhubung ke operation immutable dan alokasi delivery workspace." });
  out.limitations.push("Qty diterima/lolos QC adalah posisi kumulatif per order. Rework/scrap tidak ditambahkan lagi ke reject.", "Konfirmasi yang fingerprint sumbernya berubah ditandai STALE dan tidak digunakan sebagai ETA valid.");
  out.actionRoutes = [link("Kelola proses vendor", "/modules/production/vendor-process-orders"), link("Konfirmasi ETA melalui Purchasing", `/modules/purchasing/eta-monitor?month=${spec.month}`)];
}
function demandItems(rows, spec) {
  const result = new Map();
  for (const row of rows) for (const split of row.effectiveDeliverySplits || []) {
    if (day(split.targetDate)?.slice(0, 7) !== spec.month || (spec.filters.customer !== "ALL" && row.customerCode !== spec.filters.customer)) continue;
    const sale = (row.actualSalesOrders || []).find(s => s.deliveryTargetId === split.deliveryTargetId && s.sourceNumber === split.sourceNumber);
    const id = [split.sourceType, split.deliveryTargetId || row.id, day(split.targetDate), row.partCode, row.uomCode || "UNKNOWN"].join(":");
    const amount = qty(split.qty), previous = result.get(id);
    if (previous) { previous.committedQty = previous.committedQty === null || amount === null ? null : round(previous.committedQty + amount); continue; }
    result.set(id, { id, deliveryId: split.deliveryTargetId || null, customerCode: row.customerCode || null, partCode: row.partCode, partName: row.partName || null, uom: row.uomCode || null, sourceType: split.sourceType, sourceNumber: split.sourceNumber, sourceLineId: sale?.sourceLineId || (split.sourceType === "FORECAST" ? row.sourceLineId : null), dueDate: day(split.targetDate), dueTime: null, committedQty: amount, shippedQty: null, allocatedGoodQty: null, outstandingQty: null, status: "UNKNOWN", reason: "Belum ada alokasi pengiriman/FG eksplisit per DemandDeliveryTarget. Posisi SO line tidak dibagi FIFO sebagai bukti fulfillment.", actionRoutes: [link("Buka demand", `/modules/planning-ppic/demand-planning?month=${spec.month}`)] });
  }
  return [...result.values()];
}
async function shipmentRows(tx, spec) {
  return tx.deliveryScheduleDetail.findMany({ where: { isDeleted: false, soDetail: { isDeleted: false }, schedule: { isDeleted: false, ...(spec.filters.customer !== "ALL" ? { soHeader: { customerCode: spec.filters.customer } } : {}), OR: [{ plannedDate: { gte: spec.start, lt: spec.endExclusive } }, { shippedAt: { gte: spec.eventStart, lt: spec.eventEndExclusive } }, { deliveredAt: { gte: spec.eventStart, lt: spec.eventEndExclusive } }] } }, include: { soDetail: { select: { partCode: true, partName: true, uomCode: true } }, schedule: { select: { soNumber: true, scheduleNumber: true, status: true, plannedDate: true, shippedAt: true, deliveredAt: true, actualDate: true, podUrl: true, receivedBy: true, receivedSignature: true, updatedAt: true, soHeader: { select: { customerCode: true } } } } }, orderBy: [{ scheduleNumber: "asc" }, { lineNumber: "asc" }, { id: "asc" }], take: LIMIT + 1 });
}
function shipmentPosition(r) {
  const s = r.schedule, planned = qty(r.qty), delivered = qty(r.qtyDelivered), sane = planned !== null && delivered !== null && delivered <= planned + 1e-6;
  return { id: r.id, scheduleNumber: s.scheduleNumber, soNumber: s.soNumber, soDetailId: r.soDetailId, customerCode: s.soHeader?.customerCode || null, partCode: r.soDetail?.partCode || null, partName: r.soDetail?.partName || null, uom: r.soDetail?.uomCode || null, plannedDate: day(s.plannedDate), status: s.status, plannedQty: planned, deliveredPositionQty: delivered, lineRemainingQty: sane ? round(planned - delivered) : null, integrityStatus: sane ? "OK" : "BLOCKER", shippedAt: d.iso(s.shippedAt), receivedAt: d.iso(s.deliveredAt), recordedActualDate: day(s.actualDate), podUrl: s.podUrl || null, podEvidenceStatus: s.deliveredAt && (s.podUrl || s.receivedSignature) ? "RECORDED_UNVERIFIED" : "UNKNOWN", receivedBy: s.receivedBy || null, customerAcceptedQty: null, customerOtif: null, operationId: null, positionBasis: "DELIVERY_SCHEDULE_DETAIL_CUMULATIVE", updatedAt: d.iso(r.updatedAt), actionRoutes: [link("Buka pengiriman", `/modules/outgoing/delivery-schedules/${encodeURIComponent(s.scheduleNumber)}`)] };
}
async function delivery(tx, spec, out, deps) {
  // Consume forecast against SO across the entire demand horizon before filtering the display month.
  const demand = await deps.buildDemandRows(tx, spec.filters.customer !== "ALL" ? { customerCode: spec.filters.customer } : {});
  out.items = filtered(source(out, "effective_demand", "Effective demand delivery", demandItems(demand, spec)), spec);
  out.related = filtered(source(out, "shipments", "Baris jadwal pengiriman", await shipmentRows(tx, spec)).map(shipmentPosition), spec);
  out.summary = [metric("deliveries", "Delivery demand", out.items.length, "delivery"), metric("shipment_lines", "Baris pengiriman", out.related.length, "baris"), metric("customer_otif", "Customer OTIF", null, "%"), metric("allocation", "Fulfillment teralokasi", null, "delivery")];
  out.byUom = { committed: unitTotals(out.items, "committedQty"), shipmentPosition: unitTotals(out.related.filter(r => !["Cancelled", "Canceled"].includes(r.status)), "deliveredPositionQty") };
  out.checks.push({ id: "shipment_allocation", label: "Alokasi shipment ke delivery", status: "UNKNOWN", mandatory: true, reason: "DeliveryScheduleDetail mengacu ke SO line; belum ada quantity allocation ke setiap DemandDeliveryTarget." }, { id: "customer_otif", label: "Penerimaan customer", status: "UNKNOWN", mandatory: true, reason: "Qty diterima customer dan verifikasi POD per delivery belum tersedia. Tanggal target hanya memiliki presisi hari." });
  out.limitations.push("Nilai qtyDelivered adalah posisi baris jadwal pengiriman; bukan otomatis qty diterima customer.");
  out.actionRoutes = [link("Kelola pengiriman", "/modules/outgoing/delivery-schedules"), link("Atur delivery demand", `/modules/planning-ppic/demand-planning?month=${spec.month}`)];
}
async function exceptions(tx, spec, out) {
  const rows = source(out, "demand_exceptions", "Demand exception", await tx.demandException.findMany({ where: { isDeleted: false, periodYear: Number(spec.month.slice(0, 4)), periodMonth: Number(spec.month.slice(5)) }, include: { actions: { orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: LIMIT + 1 } }, orderBy: [{ priority: "asc" }, { detectedAt: "asc" }, { id: "asc" }], take: LIMIT + 1 }));
  out.items = filtered(rows.map(r => ({ id: r.id, exceptionNumber: r.exceptionNumber, documentNumber: r.exceptionNumber, type: "DEMAND_EXCEPTION", title: r.title, description: r.description, exceptionType: r.exceptionType, severity: r.severity, priority: r.priority, status: r.status, owner: r.ownerName || r.ownerUsername || null, ownerUserId: r.ownerUserId || null, customerCode: r.customerCode, partCode: r.partCode, uom: r.uomCode || null, qty: qty(r.demandQty), dueDate: day(r.targetDeliveryDate), targetResolutionDate: day(r.targetResolutionDate), sourceType: r.sourceType, sourceNumber: r.sourceNumber, sourceDeliveryTargetId: r.sourceDeliveryTargetId, sourceFingerprint: r.sourceFingerprint, sourceActive: r.sourceActive, detectedAt: d.iso(r.detectedAt), resolvedAt: d.iso(r.resolvedAt), resolutionSummary: r.resolutionSummary, evidence: r.resolutionEvidence, operationId: null, history: r.actions.slice(0, LIMIT).map(a => ({ id: a.id, action: a.action, fromStatus: a.fromStatus, toStatus: a.toStatus, note: a.note, actor: a.actor, at: d.iso(a.createdAt) })), historyTruncated: r.actions.length > LIMIT, updatedAt: d.iso(r.updatedAt), actionRoutes: [link("Kelola exception", `/modules/planning-ppic/demand-planning/exception-workbench?month=${spec.month}&q=${encodeURIComponent(r.exceptionNumber)}`)] })), spec);
  const recovery = source(out, "recovery_requests", "Permintaan recovery MPS", await tx.mpsRecoveryRequest.findMany({ where: { planningMonth: spec.month }, orderBy: [{ updatedAt: "desc" }, { id: "asc" }], take: LIMIT + 1 }));
  out.related = filtered(recovery.map(r => ({ id: r.id, type: "MPS_RECOVERY_REQUEST", title: r.title, status: r.feedbackStatus, mpsNumber: r.mpsNumber, mpsRevision: r.mpsRevision, lineId: r.lineId, checkpointCode: r.checkpointCode, partCode: r.partCode, department: r.departmentName, owner: r.departmentName, targetResolutionDate: day(r.targetDate), notes: r.notes, feedbackNotes: r.feedbackNotes, evidence: r.evidenceReference, operationId: null, sourceSnapshotAt: null, sourceValidity: "UNKNOWN", sourceValidityReason: "Request menyimpan snapshot MPS; belum dilakukan rekalkulasi kelayakan atau pencocokan fingerprint terbaru.", updatedAt: d.iso(r.updatedAt), actionRoutes: [link("Tindak lanjut recovery", `/modules/planning-ppic/mps/recovery-kanban?month=${spec.month}`)] })), spec);
  out.summary = [metric("open", "Exception aktif", out.items.filter(r => !["CLOSED", "RESOLVED"].includes(r.status)).length), metric("unassigned", "Belum ada owner", out.items.filter(r => !r.owner && !["CLOSED", "RESOLVED"].includes(r.status)).length), metric("recovery", "Permintaan recovery", out.related.length), metric("impact", "Dampak operation tervalidasi", null, "operation")];
  out.checks.push({ id: "recovery_impact", label: "Validasi perubahan operation", status: "UNKNOWN", mandatory: true, reason: "Recovery belum dipetakan ke immutable baseline operation; penyelesaian case tidak otomatis mengubah baseline." });
  out.actionRoutes = [link("Exception workbench", `/modules/planning-ppic/demand-planning/exception-workbench?month=${spec.month}`), link("Recovery kanban", `/modules/planning-ppic/mps/recovery-kanban?month=${spec.month}`)];
}
function schedule(r) { return { id: r.id, scheduleNumber: r.scheduleNumber, sourceAllocationId: r.productionPlanAllocationId, woId: r.woId, woNumber: r.woNumber, partCode: r.partCode, processId: r.processId, machineId: r.machineId, date: day(r.scheduleDate), shift: r.shift, plannedStartTime: r.plannedStartTime, plannedEndTime: r.plannedEndTime, plannedQty: qty(r.plannedQty), uom: r.uomCode || null, status: r.status, workspaceOperationId: null }; }
async function changes(tx, spec, out) {
  const rows = source(out, "daily_revisions", "Daily plan revisions", await tx.dailyPlanRevision.findMany({ where: { isDeleted: false, planDate: { gte: spec.start, lt: spec.endExclusive } }, include: { schedules: { where: { isDeleted: false }, orderBy: [{ sequence: "asc" }, { id: "asc" }], take: LIMIT + 1 } }, orderBy: [{ planDate: "desc" }, { version: "desc" }, { id: "asc" }], take: LIMIT + 1 }));
  out.items = filtered(rows.map(r => ({ id: r.id, revisionNumber: r.revisionNumber, planDate: day(r.planDate), version: r.version, status: r.status, supersedesId: r.supersedesId, sourcePlanNumber: r.sourcePlanNumber, preparedBy: r.preparedBy, releasedBy: r.releasedBy, releasedAt: d.iso(r.releasedAt), revisionReason: r.revisionReason, validationSummary: r.validationSummary, scheduleCount: r.schedules.length > LIMIT ? null : r.schedules.length, schedules: r.schedules.slice(0, LIMIT).map(schedule), schedulesTruncated: r.schedules.length > LIMIT, byUom: unitTotals(r.schedules.slice(0, LIMIT).map(s => ({ uom: s.uomCode, qty: s.plannedQty }))), comparisonStatus: "UNKNOWN", comparisonReason: "Revision harian memiliki identitas schedule sendiri. Tidak ada pemetaan satu-ke-satu yang membuktikan delta operation terhadap baseline workspace.", updatedAt: d.iso(r.updatedAt), actionRoutes: [link("Kelola daily plan", `/modules/planning-ppic/daily-production-plans?date=${day(r.planDate)}`)] })), spec);
  const baselines = await tx.$queryRaw`SELECT id,request_id,month,scenario_id,scenario_revision,bundle_hash,published_by,to_char(published_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS published_at_utc FROM tbl_ppic_released_baseline WHERE month=${spec.month}`;
  out.related = baselines.map(r => ({ id: r.id, type: "IMMUTABLE_RELEASED_BASELINE", requestId: r.request_id, month: r.month, scenarioId: r.scenario_id, scenarioRevision: r.scenario_revision, bundleHash: r.bundle_hash, publishedBy: r.published_by, publishedAt: d.iso(r.published_at_utc), status: "RELEASED", immutable: true, actionRoutes: [link("Lihat paket release", `/modules/planning-ppic/labs/release-baseline?month=${spec.month}&release=${encodeURIComponent(r.request_id)}`)] }));
  out.sources.push({ id: "released_baseline", label: "Baseline workspace immutable", count: baselines.length, completeness: "COMPLETE", status: baselines.length ? "AVAILABLE" : "EMPTY", latestSourceUpdateAt: out.related[0]?.publishedAt || null, certifiedCutoffAt: null });
  out.summary = [metric("revisions", "Revisi daily plan", out.items.length), metric("drafts", "Draft / siap review", out.items.filter(r => ["Draft", "Ready"].includes(r.status)).length), metric("released", "Revisi released", out.items.filter(r => ["Released", "Partially Released"].includes(r.status)).length), metric("baselines", "Baseline immutable", out.related.length)];
  out.checks.push({ id: "baseline_operation_mapping", label: "Validasi delta baseline", status: "UNKNOWN", mandatory: true, reason: "Paket baseline tetap immutable. Publish delta lintas daily plan ke current approved workspace belum tersedia." });
  out.actionRoutes = [link("Revisi dan validasi daily plan", `/modules/planning-ppic/daily-production-plans?date=${spec.date}`), link("Lihat review release", `/modules/planning-ppic/labs/release-baseline?month=${spec.month}`)];
}
function stockVariance(r) {
  const actual = qty(r.actualQty), system = qty(r.systemQty);
  return actual === null || system === null ? null : round(actual - system);
}
async function reconciliation(tx, spec, out) {
  const [state, logsRaw, stockRaw, vendorsRaw, shipmentsRaw] = await Promise.all([
    period.getPeriodState(tx, spec.month),
    tx.productionLog.findMany({ where: { isDeleted: false, logDate: { gte: spec.eventStart, lt: spec.eventEndExclusive }, status: { not: "Approved" } }, select: { id: true, logNumber: true, logDate: true, status: true, machineCode: true, shift: true, woId: true, updatedAt: true }, orderBy: [{ logDate: "asc" }, { id: "asc" }], take: LIMIT + 1 }),
    tx.stockOpnameDetail.findMany({ where: { isDeleted: false, header: { isDeleted: false, stoDate: { gte: spec.eventStart, lt: spec.eventEndExclusive } } }, include: { header: { select: { stoNo: true, status: true, stoDate: true, adjustedAt: true, snapshotAt: true } } }, orderBy: [{ stoHeaderId: "asc" }, { id: "asc" }], take: LIMIT + 1 }), vendorRows(tx, spec), shipmentRows(tx, spec),
  ]);
  const logs = source(out, "unapproved_logs", "Log produksi belum approved", logsRaw), stocks = source(out, "stock_counts", "Baris stock opname", stockRaw), vendors = source(out, "vendor_positions", "Posisi order vendor", vendorsRaw).map(r => vendorPosition(r)), shipments = source(out, "shipment_positions", "Posisi pengiriman", shipmentsRaw).map(shipmentPosition);
  out.items = [
    ...logs.map(r => ({ id: `log:${r.id}`, sourceId: r.id, type: "PRODUCTION_LOG", documentNumber: r.logNumber, label: "Actual belum approved", status: "BLOCKER", documentStatus: r.status, date: eventDay(r.logDate), qty: null, uom: null, reason: "Log belum Approved, sehingga belum menjadi actual resmi.", actionRoutes: [link("Periksa log produksi", `/modules/production/production-logs/${encodeURIComponent(r.logNumber)}`)] })),
    ...stocks.filter(r => stockVariance(r) === null || stockVariance(r) !== 0 || !["ADJUSTED", "CLOSED"].includes(r.header.status)).map(r => ({ id: `sto:${r.id}`, sourceId: r.id, type: "STOCK_COUNT", documentNumber: r.header.stoNo, label: "Rekonsiliasi stock opname", status: stockVariance(r) === null ? "UNKNOWN" : stockVariance(r) !== 0 && !r.adjustmentNumber ? "BLOCKER" : ["ADJUSTED", "CLOSED"].includes(r.header.status) ? "OK" : "CONDITIONAL", documentStatus: r.header.status, partCode: r.partCode || r.materialCode, date: eventDay(r.header.stoDate), systemQty: qty(r.systemQty), actualQty: qty(r.actualQty), varianceQty: stockVariance(r), uom: r.uomCode || null, reason: stockVariance(r) === null ? "Belum ada hitungan aktual; default variance=0 bukan bukti cocok." : "Periksa approval dan posting adjustment pada dokumen sumber.", adjustmentNumber: r.adjustmentNumber, actionRoutes: [link("Periksa stock opname", `/modules/inventory/stock-opname/${encodeURIComponent(r.header.stoNo)}`)] })),
    ...vendors.filter(r => !["Closed", "Cancelled"].includes(r.status) && (r.pendingQcQty !== 0 || r.notReturnedQty !== 0)).map(r => ({ id: `vendor:${r.id}`, sourceId: r.id, type: "VENDOR_POSITION", documentNumber: r.orderNumber, label: "Vendor belum matching", status: r.integrityStatus === "BLOCKER" ? "BLOCKER" : "CONDITIONAL", documentStatus: r.status, partCode: r.partCode, uom: r.uom, pendingQcQty: r.pendingQcQty, notReturnedQty: r.notReturnedQty, reason: "Posisi belum selesai; keputusan carryover memerlukan dokumen dan approval tersendiri.", actionRoutes: r.actionRoutes })),
    ...shipments.filter(r => !["Cancelled", "Canceled"].includes(r.status) && (r.lineRemainingQty !== 0 || r.podEvidenceStatus === "UNKNOWN")).map(r => ({ id: `ship:${r.id}`, sourceId: r.id, type: "SHIPMENT_POSITION", documentNumber: r.scheduleNumber, label: "Pengiriman belum matching", status: r.integrityStatus === "BLOCKER" ? "BLOCKER" : "UNKNOWN", documentStatus: r.status, partCode: r.partCode, uom: r.uom, plannedQty: r.plannedQty, deliveredPositionQty: r.deliveredPositionQty, lineRemainingQty: r.lineRemainingQty, reason: "Alokasi penerimaan customer per demand belum terverifikasi.", actionRoutes: r.actionRoutes })),
  ];
  const all = out.items;
  out.items = filtered(all, spec);
  out.planningPeriodState = { month: state.month, status: state.status, closedAt: state.closedAt, closedBy: state.closedBy, reopenedAt: state.reopenedAt, reopenedBy: state.reopenedBy, reason: state.reason, scope: "LEGACY_PLANNING_LIFECYCLE" };
  out.checks.push({ id: "approved_actuals", label: "Actual telah disetujui", status: logs.length ? "BLOCKER" : "UNKNOWN", mandatory: true, reason: logs.length ? `${logs.length} log belum approved dalam cakupan bulan.` : "Tidak ditemukan log pending; kelengkapan semua actual pada cutoff belum tersertifikasi." }, ...[ ["wip_reconciliation", "Rekonsiliasi WIP dan lot"], ["customer_receipts", "Matching penerimaan customer"], ["carryover_approval", "Persetujuan carryover"], ["source_cutoff", "Kelengkapan sumber pada cutoff"] ].map(([id, label]) => ({ id, label, status: "UNKNOWN", mandatory: true, reason: "Belum ada kontrak sertifikasi dan approval lintas sumber untuk penutupan execution workspace." })));
  out.summary = [metric("unapproved", "Actual belum approved", logs.length), metric("stock", "Baris stock perlu review", all.filter(r => r.type === "STOCK_COUNT" && r.status !== "OK").length, "baris"), metric("issues", "Temuan rekonsiliasi", out.items.length, "temuan"), metric("closure", "Execution closure", null, "UNKNOWN")];
  out.limitations.push("Status periode existing berlaku untuk lifecycle planning. CLOSED pada sumber tersebut tidak membuktikan rekonsiliasi actual, WIP, vendor, shipment, dan carryover selesai.", "Tidak ada tindakan close/reopen execution baru sebelum mandatory evidence tersedia.");
  out.actionRoutes = [link("Periksa actual produksi", "/modules/production/production-logs"), link("Periksa stock opname", "/modules/inventory/stock-opname"), link("Periksa vendor", "/modules/production/vendor-process-orders"), link("Periksa pengiriman", "/modules/outgoing/delivery-schedules")];
}
const LOADERS = { E06: subcontract, E07: delivery, E08: exceptions, E09: changes, E10: reconciliation };
async function snapshot(prisma, page, query, user, deps = {}) {
  const now = deps.now || new Date(), spec = normalize(page, query, now); assertAccess(user, page, query);
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    const out = base(spec, now);
    await LOADERS[spec.pageId](tx, spec, out, { buildDemandRows: deps.buildDemandRows || require("./demandPlanningService").buildDemandRows });
    out.readiness = { status: d.worst(out.checks.filter(c => c.mandatory).map(c => c.status)), canRelease: false, canClose: false, basis: "SOURCE_REVIEW_ONLY" };
    return out;
  }, { isolationLevel: "RepeatableRead", timeout: 60000, maxWait: 10000 });
}
module.exports = { snapshot, normalize, assertAccess, vendorSource, vendorPosition, demandItems, shipmentPosition, stockVariance, unitTotals, PAGES, SOURCE_PERMISSIONS };
