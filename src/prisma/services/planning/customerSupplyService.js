"use strict";
const { randomUUID, createHash } = require("node:crypto");
const { businessNow } = require("../../utils/businessClock");
const { queueDirtyPartCodes } = require("../../utils/mrpDirtyQueue");
const include = { shipments: { orderBy: { createdAt: "asc" }, include: { receipts: { orderBy: { createdAt: "asc" }, include: { issues: true } } } } };
const n = (v) => Number(v) || 0;
const round = (v) => Math.round(v * 1e6) / 1e6;
const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode, code: "CUSTOMER_SUPPLY_INVALID" }); };
function positive(v, label = "Qty") { const q = Number(v); if (!Number.isFinite(q) || round(q) <= 0) fail(`${label} harus lebih dari 0 (maks. 6 desimal).`); return round(q); }
function date(v, label) { if (!v || !Number.isFinite(new Date(v).getTime())) fail(`${label} wajib berupa tanggal valid.`); return new Date(v); }
function text(v, label) { const s = String(v || "").trim(); if (!s || s.length > 250) fail(`${label} wajib diisi (maks. 250 karakter).`); return s; }
const number = (prefix) => `${prefix}-${businessNow().toISOString().slice(0, 10).replace(/-/g, "")}-${randomUUID().slice(0, 8).toUpperCase()}`;
const poolKey = (row) => `CUSTOMER:${row.supplyCustomerCode || row.customerCode || "UNASSIGNED"}|${row.materialCode || row.partCode}|${String(row.uomCode || "").toLowerCase()}`;
const weekKey = (value) => { const d = date(value, "Tanggal kebutuhan"); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7); return d.toISOString().slice(0, 10); };
function planningUom(part, bom) {
  const bases = part?.partBases || [];
  const base = bases.find((b) => String(b.baseOn).toLowerCase() === "actual") || bases[0];
  return part?.itemType === "RAW" && part?.rawType === "MATERIAL" && (String(bom?.uomCode).toLowerCase() === "kg" || n(bom?.grossWeight) > 0 || n(base?.grossWeight) > 0) ? "kg" : bom?.uomCode;
}
const history = (request, action, actor, data = {}) => [...(Array.isArray(request.history) ? request.history : []), { action, actor, at: new Date().toISOString(), ...data }];
function summarize(request) {
  const shipments = request.shipments || [];
  const receipts = shipments.flatMap((s) => s.receipts || []);
  return { ...request, confirmedQty: round(shipments.filter((s) => s.status === "CONFIRMED").reduce((a, s) => a + n(s.qty), 0)), receivedQty: round(receipts.reduce((a, r) => a + n(r.receivedQty), 0)), availableQty: round(receipts.reduce((a, r) => a + Math.max(n(r.acceptedQty) - n(r.issuedQty), 0), 0)), pendingQcQty: round(receipts.filter((r) => r.qcStatus === "PENDING").reduce((a, r) => a + n(r.receivedQty), 0)) };
}
async function lockRequest(tx, id) {
  await tx.$queryRaw`SELECT id FROM tbl_customer_supply_request WHERE id = ${id} FOR UPDATE`;
  const request = await tx.customerSupplyRequest.findUnique({ where: { id }, include });
  if (!request) fail("Permintaan suplai tidak ditemukan.", 404);
  if (request.status === "CANCELLED") fail("Permintaan sudah dibatalkan.", 409);
  return request;
}
async function changed(tx, request, actor, action, data = {}) {
  await tx.customerSupplyRequest.update({ where: { id: request.id }, data: { history: history(request, action, actor, data) } });
  await queueDirtyPartCodes(tx, [request.partCode], { reason: "SUPPLY", sourceNumber: request.requestNumber, notes: `Suplai customer ${action}; evaluasi ulang MPS/MRP. Tidak mengubah approval otomatis.` });
}
async function list(db, query = {}) {
  const page = Math.max(1, Number(query.page) || 1), limit = Math.min(500, Math.max(1, Number(query.limit) || 100));
  const where = { ...(query.customerCode ? { customerCode: String(query.customerCode) } : {}), ...(query.sourceRunNumber ? { sourceRunNumber: String(query.sourceRunNumber) } : {}), ...(query.q ? { OR: ["requestNumber", "partCode", "materialCode", "customerCode"].map((key) => ({ [key]: { contains: String(query.q), mode: "insensitive" } })) } : {}) };
  const [items, total] = await Promise.all([db.customerSupplyRequest.findMany({ where, include, orderBy: { createdAt: "desc" }, skip: (page - 1) * limit, take: limit }), db.customerSupplyRequest.count({ where })]);
  return { items: items.map(summarize), total, page, limit };
}
async function options(db) {
  const [materials, warehouses, uoms, mrpRuns] = await Promise.all([
    db.mBOMDetail.findMany({ where: { isDeleted: false, materialSupplyType: "CUSTOMER_SUPPLIED", supplyCustomerId: { not: null } }, select: { part: { include: { material: true, partBases: true } }, supplyCustomer: { select: { customerCode: true, customerName: true } }, uomCode: true, grossWeight: true } }),
    db.warehouse.findMany({ where: { isDeleted: false, isActive: true }, select: { warehouseCode: true, warehouseName: true } }),
    db.uom.findMany({ select: { uomCode: true } }),
    db.mRPRun.findMany({ where: { isDeleted: false }, select: { runNumber: true, planningMonth: true, status: true, scenarioStatus: true, mps: { select: { periodStart: true } } }, orderBy: [{ createdAt: "desc" }, { runNumber: "desc" }] }),
  ]);
  return { materials: [...new Map(materials.filter((r) => r.part && r.supplyCustomer).map((r) => [`${r.part.partCode}|${r.supplyCustomer.customerCode}`, { partCode: r.part.partCode, partName: r.part.partName, materialCode: r.part.material?.materialCode, customerCode: r.supplyCustomer.customerCode, customerName: r.supplyCustomer.customerName, uomCode: planningUom(r.part, r) }])).values()], warehouses, uoms, mrpRuns: mrpRuns.map(({ mps, ...run }) => ({ ...run, planningMonth: run.planningMonth || mps?.periodStart || null })) };
}
async function create(tx, input, actor) {
  const partCode = text(input.partCode, "Material/part"), customerCode = text(input.customerCode, "Customer");
  const [part, customer, bom] = await Promise.all([
    tx.part.findFirst({ where: { partCode, isDeleted: false }, include: { material: true, partBases: true } }),
    tx.customer.findFirst({ where: { customerCode, isDeleted: false } }),
    tx.mBOMDetail.findFirst({ where: { isDeleted: false, materialSupplyType: "CUSTOMER_SUPPLIED", part: { partCode }, supplyCustomer: { customerCode } } }),
  ]);
  if (!part || !customer || !bom) fail("Part dan pemilik customer harus sesuai material suplai customer pada BOM.");
  const uomCode = text(input.uomCode, "Satuan");
  const expectedUom = planningUom(part, bom);
  if (expectedUom && uomCode.toLowerCase() !== expectedUom.toLowerCase()) fail(`Gunakan satuan planning ${expectedUom}; konversi satuan kiriman belum didukung.`);
  if (!(await tx.uom.findFirst({ where: { uomCode } }))) fail("Satuan tidak terdaftar.");
  if (input.idempotencyKey) {
    input._sourceKey = `MANUAL:${text(input.idempotencyKey, "Kunci permintaan")}`;
    const existing = await tx.customerSupplyRequest.findUnique({ where: { sourceKey: input._sourceKey }, include });
    if (existing) {
      if (existing.partCode !== partCode || existing.customerCode !== customerCode || existing.qtyRequested !== Number(input.qtyRequested)) fail("Kunci permintaan sudah dipakai untuk data lain.", 409);
      return existing;
    }
  }
  return tx.customerSupplyRequest.create({ data: { requestNumber: number("CSR"), partCode, customerCode, materialCode: part.material?.materialCode || null, uomCode, qtyRequested: positive(input.qtyRequested), requiredDate: date(input.requiredDate, "Tanggal kebutuhan"), notes: String(input.notes || "").slice(0, 2000), createdBy: actor, sourceKey: input._sourceKey || null, sourceRunNumber: input._sourceRunNumber || null, sourceRequirementIds: input._requirementIds || [], history: [{ action: "REQUESTED", actor, at: new Date().toISOString() }] }, include });
}
async function mrpNeeds(db, runNumber) {
  const run = await db.mRPRun.findFirst({ where: { runNumber: text(runNumber, "MRP run"), isDeleted: false } });
  if (!run) fail("MRP run tidak ditemukan.", 404);
  const rows = await db.mRPRequirement.findMany({ where: { runNumber, materialSupplyType: "CUSTOMER_SUPPLIED", isDeleted: false }, include: { part: { include: { partBases: true, material: true } }, mbomDetail: true }, orderBy: { requiredDate: "asc" } });
  const requests = await db.customerSupplyRequest.findMany({ where: { customerCode: { in: [...new Set(rows.map((r) => r.supplyCustomerCode).filter(Boolean))] }, status: { not: "CANCELLED" } }, include });
  return { runNumber, items: rows.map((r) => {
    const row = { ...r, uomCode: planningUom(r.part, r.mbomDetail), materialCode: r.part?.material?.materialCode };
    const existing = requests.find((q) => (q.sourceRequirementIds || []).includes(r.id)
      || (q.sourceRunNumber !== runNumber && poolKey(q) === poolKey(row)
        && weekKey(q.requiredDate) === weekKey(row.materialRequiredDate || row.requiredDate)
        && summarize(q).receivedQty < q.qtyRequested));
    return { ...row, requestedIn: existing?.requestNumber || null };
  }) };
}
async function createFromMrp(tx, input, actor) {
  const ids = [...new Set(Array.isArray(input.requirementIds) ? input.requirementIds : [])];
  if (!ids.length || ids.length > 500) fail("Pilih 1–500 kebutuhan material.");
  // Serialize duplicate requests from double-clicks and concurrent operators.
  const runNumber = text(input.runNumber, "MRP run");
  await tx.$queryRaw`SELECT id FROM tbl_mrp_run WHERE run_number = ${runNumber} FOR UPDATE`;
  const needs = await mrpNeeds(tx, runNumber);
  const rows = needs.items.filter((r) => ids.includes(r.id));
  if (rows.length !== ids.length || rows.some((r) => r.requestedIn)) fail("Kebutuhan tidak valid atau sudah memiliki permintaan suplai.", 409);
  const groups = new Map();
  for (const row of rows) {
    const qty = n(row.firmNetRequirement ?? row.netRequirement);
    if (qty <= 0 || !row.supplyCustomerCode) fail("Pilih kebutuhan net positif dengan customer pengirim.");
    const need = date(row.materialRequiredDate || row.requiredDate, "Tanggal kebutuhan");
    const week = new Date(need); week.setUTCHours(0, 0, 0, 0); week.setUTCDate(week.getUTCDate() - (week.getUTCDay() + 6) % 7);
    const key = `${row.supplyCustomerCode}|${row.partCode}|${row.uomCode}|${week.toISOString()}`;
    if (!groups.has(key)) groups.set(key, { customerCode: row.supplyCustomerCode, partCode: row.partCode, uomCode: row.uomCode, requiredDate: need, qtyRequested: 0, ids: [] });
    const group = groups.get(key); group.qtyRequested += qty; group.ids.push(row.id); if (need < group.requiredDate) group.requiredDate = need;
  }
  const items = [];
  for (const group of groups.values()) items.push(await create(tx, { ...group, _sourceRunNumber: runNumber, _requirementIds: group.ids, _sourceKey: createHash("sha256").update(`${runNumber}|${group.ids.sort().join("|")}`).digest("hex") }, actor));
  return { items, count: items.length };
}
async function addShipment(tx, id, input, actor) {
  const request = await lockRequest(tx, id);
  const qty = positive(input.qty), eta = date(input.eta, "ETA"), readyDate = date(input.readyDate, "Tanggal siap setelah QC");
  if (readyDate < eta) fail("Tanggal siap tidak boleh sebelum ETA.");
  const rejected = request.shipments.flatMap((s) => s.receipts).reduce((sum, r) => sum + r.rejectedQty, 0);
  if (request.shipments.filter((s) => s.status !== "CANCELLED").reduce((sum, s) => sum + s.qty, 0) - rejected + qty > request.qtyRequested + 0.000001) fail("Total jadwal kiriman melebihi permintaan (pengganti qty reject diperbolehkan).");
  const shipment = await tx.customerSupplyShipment.create({ data: { requestId: id, qty, eta, readyDate } });
  await changed(tx, request, actor, "SHIPMENT_PLANNED", { shipmentId: shipment.id, qty, eta: eta.toISOString() });
  return shipment;
}
async function confirmShipment(tx, id, shipmentId, input, actor) {
  const request = await lockRequest(tx, id), shipment = request.shipments.find((s) => s.id === shipmentId);
  if (!shipment || shipment.status === "CANCELLED") fail("Kiriman tidak tersedia.", 404);
  if (shipment.status === "CONFIRMED") return shipment;
  const confirmationReference = text(input.confirmationReference, "Referensi konfirmasi customer");
  const result = await tx.customerSupplyShipment.update({ where: { id: shipmentId }, data: { status: "CONFIRMED", confirmationReference, confirmedAt: new Date(), confirmedBy: actor } });
  await changed(tx, request, actor, "SHIPMENT_CONFIRMED", { shipmentId, confirmationReference });
  return result;
}
async function cancelShipment(tx, id, shipmentId, input, actor) {
  const request = await lockRequest(tx, id), shipment = request.shipments.find((s) => s.id === shipmentId);
  if (!shipment) fail("Kiriman tidak tersedia.", 404);
  if (shipment.receipts.length) fail("Kiriman sudah diterima; histori tidak boleh dibatalkan.", 409);
  const reason = text(input.reason, "Alasan pembatalan");
  const result = await tx.customerSupplyShipment.update({ where: { id: shipmentId }, data: { status: "CANCELLED" } });
  await changed(tx, request, actor, "SHIPMENT_CANCELLED", { shipmentId, reason });
  return result;
}
async function rescheduleShipment(tx, id, shipmentId, input, actor) {
  const request = await lockRequest(tx, id), shipment = request.shipments.find((s) => s.id === shipmentId);
  if (!shipment || shipment.status === "CANCELLED" || shipment.receipts.reduce((sum, r) => sum + r.receivedQty, 0) >= shipment.qty) fail("Tidak ada sisa kiriman yang dapat dijadwalkan ulang.", 409);
  const eta = date(input.eta, "ETA revisi"), readyDate = date(input.readyDate, "Tanggal siap setelah QC");
  if (readyDate < eta) fail("Tanggal siap tidak boleh sebelum ETA.");
  const reason = text(input.reason, "Alasan perubahan ETA");
  const result = await tx.customerSupplyShipment.update({ where: { id: shipmentId }, data: { eta, readyDate, status: "PLANNED", confirmationReference: null, confirmedAt: null, confirmedBy: null } });
  await changed(tx, request, actor, "SHIPMENT_RESCHEDULED_NEEDS_CONFIRMATION", { shipmentId, reason, oldEta: shipment.eta.toISOString(), oldReadyDate: shipment.readyDate.toISOString(), oldConfirmation: shipment.confirmationReference, eta: eta.toISOString(), readyDate: readyDate.toISOString() });
  return result;
}
async function receive(tx, id, shipmentId, input, actor) {
  const request = await lockRequest(tx, id), shipment = request.shipments.find((s) => s.id === shipmentId);
  if (!shipment || shipment.status !== "CONFIRMED") fail("Konfirmasi kiriman sebelum penerimaan.", 409);
  const idempotencyKey = text(input.idempotencyKey, "Kunci penerimaan");
  const prior = await tx.customerSupplyReceipt.findUnique({ where: { idempotencyKey } });
  if (prior) { if (prior.shipmentId !== shipmentId || prior.receivedQty !== Number(input.receivedQty)) fail("Kunci penerimaan telah dipakai untuk data lain.", 409); return prior; }
  const receivedQty = positive(input.receivedQty), receivedDate = date(input.receivedDate, "Tanggal terima");
  if (receivedDate > new Date(businessNow().toISOString().slice(0, 10) + "T23:59:59.999Z")) fail("Penerimaan aktual tidak boleh bertanggal masa depan.");
  if (shipment.receipts.reduce((sum, r) => sum + r.receivedQty, 0) + receivedQty > shipment.qty + 0.000001) fail("Qty terima melebihi sisa kiriman.");
  const warehouseCode = text(input.warehouseCode, "Gudang");
  if (!(await tx.warehouse.findFirst({ where: { warehouseCode, isDeleted: false, isActive: true } }))) fail("Gudang tidak aktif.");
  const result = await tx.customerSupplyReceipt.create({ data: { receiptNumber: number("CSR-IN"), shipmentId, idempotencyKey, receivedQty, receivedDate, warehouseCode, lotNumber: text(input.lotNumber, "Lot"), deliveryNoteNumber: text(input.deliveryNoteNumber, "Surat jalan"), receivedBy: actor } });
  await changed(tx, request, actor, "RECEIVED_QC_HOLD", { receiptId: result.id, receivedQty });
  return result;
}
async function inspectReceipt(tx, id, receiptId, input, actor) {
  const request = await lockRequest(tx, id), receipt = request.shipments.flatMap((s) => s.receipts).find((r) => r.id === receiptId);
  if (!receipt) fail("Penerimaan tidak ditemukan.", 404);
  const acceptedQty = Number(input.acceptedQty), rejectedQty = Number(input.rejectedQty);
  if (![acceptedQty, rejectedQty].every((q) => Number.isFinite(q) && q >= 0) || Math.abs(acceptedQty + rejectedQty - receipt.receivedQty) > 0.000001) fail("Qty lolos + reject harus sama dengan qty diterima.");
  if (receipt.qcStatus !== "PENDING") { if (receipt.acceptedQty === acceptedQty && receipt.rejectedQty === rejectedQty) return receipt; fail("Hasil QC sudah diposting.", 409); }
  const result = await tx.customerSupplyReceipt.update({ where: { id: receiptId }, data: { acceptedQty, rejectedQty, qcStatus: "COMPLETED", releasedAt: new Date(Math.max(businessNow().getTime(), receipt.receivedDate.getTime())), inspectedBy: actor, qcReference: text(input.qcReference, "Referensi inspeksi") } });
  await changed(tx, request, actor, "QC_COMPLETED", { receiptId, acceptedQty, rejectedQty });
  return result;
}
async function issue(tx, id, receiptId, input, actor) {
  const request = await lockRequest(tx, id), receipt = request.shipments.flatMap((s) => s.receipts).find((r) => r.id === receiptId);
  if (!receipt || receipt.qcStatus !== "COMPLETED") fail("Stok belum lolos QC.", 409);
  const idempotencyKey = text(input.idempotencyKey, "Kunci pengeluaran"), qty = positive(input.qty);
  const prior = await tx.customerSupplyIssue.findUnique({ where: { idempotencyKey } });
  if (prior) { if (prior.receiptId !== receiptId || prior.qty !== qty) fail("Kunci pengeluaran sudah dipakai.", 409); return prior; }
  if (qty > receipt.acceptedQty - receipt.issuedQty + 0.000001) fail("Qty keluar melebihi stok milik customer yang tersedia.");
  const result = await tx.customerSupplyIssue.create({ data: { receiptId, idempotencyKey, qty, reference: text(input.reference, "Referensi pengeluaran produksi"), performedBy: actor } });
  await tx.customerSupplyReceipt.update({ where: { id: receiptId }, data: { issuedQty: { increment: qty } } });
  await changed(tx, request, actor, "ISSUED", { receiptId, qty, reference: result.reference });
  return result;
}
async function cancelRequest(tx, id, input, actor) {
  const request = await lockRequest(tx, id);
  if (request.shipments.some((s) => s.receipts.length)) fail("Permintaan sudah memiliki penerimaan; histori tidak boleh dibatalkan.", 409);
  const reason = text(input.reason, "Alasan pembatalan permintaan");
  await tx.customerSupplyShipment.updateMany({ where: { requestId: id }, data: { status: "CANCELLED" } });
  await tx.customerSupplyRequest.update({ where: { id }, data: { status: "CANCELLED", sourceKey: null } });
  await changed(tx, request, actor, "REQUEST_CANCELLED", { reason, previousSourceKey: request.sourceKey });
  return { id, status: "CANCELLED" };
}

// Receipt stock and outstanding confirmed shipments are disjoint supplies.
// Owner + material + UOM form the shared allocation pool, never company stock.
function supplyEventsFor(component, requests = []) {
  const events = [];
  for (const req of requests.filter((r) => r.status !== "CANCELLED" && poolKey(r) === poolKey(component))) {
    for (const shipment of req.shipments || []) {
      if (shipment.status === "CONFIRMED") {
        const outstanding = Math.max(0, shipment.qty - (shipment.receipts || []).reduce((a, r) => a + r.receivedQty, 0));
        if (outstanding > 0) events.push({ id: shipment.id, sourceType: "CUSTOMER_SHIPMENT", sourceNumber: req.requestNumber, qty: outstanding, availableDate: shipment.readyDate, eta: shipment.eta, confidence: "FIRM", status: "CONFIRMED", supplyCustomerCode: req.customerCode });
      }
      for (const receipt of shipment.receipts || []) {
        const qty = Math.max(0, receipt.acceptedQty - receipt.issuedQty);
        if (receipt.qcStatus === "COMPLETED" && receipt.releasedAt && qty > 0) events.push({ id: receipt.id, sourceType: "CUSTOMER_STOCK", sourceNumber: receipt.receiptNumber, qty, availableDate: receipt.releasedAt, confidence: "FIRM", status: "QC_ACCEPTED", supplyCustomerCode: req.customerCode });
      }
    }
  }
  return events;
}
async function loadSupplyRequests(db, components = []) {
  const owners = [...new Set(components.map((r) => r.supplyCustomerCode || r.customerCode).filter(Boolean))];
  if (!owners.length) return [];
  return db.customerSupplyRequest.findMany({ where: { customerCode: { in: owners }, status: { not: "CANCELLED" } }, include });
}
module.exports = { list, options, create, mrpNeeds, createFromMrp, addShipment, confirmShipment, cancelShipment, rescheduleShipment, cancelRequest, receive, inspectReceipt, issue, summarize, poolKey, supplyEventsFor, loadSupplyRequests };
