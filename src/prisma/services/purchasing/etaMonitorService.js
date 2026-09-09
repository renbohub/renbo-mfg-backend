"use strict";
const { businessNow } = require("../../utils/businessClock");
const n = (v) => Number(v) || 0;
const day = (v) => v && Number.isFinite(new Date(v).getTime()) ? new Date(v).toISOString().slice(0, 10) : null;
const enc = encodeURIComponent;
const partSelect = { partCode: true, partNumber: true, partName: true, itemType: true, rawType: true, hasDrawing: true };
const closed = ["Cancelled", "Canceled", "Rejected", "CANCELLED"];
const supplierConfirmed = new Set(["Available", "Partially Available", "Alternative Quantity Offered", "Alternative Delivery Date", "Confirmed"]);
function category(part, materialCode) {
  if (materialCode || (part?.itemType === "RAW" && part?.rawType === "MATERIAL")) return "MATERIAL";
  if (part?.rawType === "PURCHASE_PART") return part.hasDrawing ? "PURCHASE_PART" : "UNIVERSAL_PART";
  return "OTHER";
}
function finish(row, now = businessNow()) {
  const needed = day(row.needDate), target = day(row.targetArrivalDate), eta = day(row.eta), ready = day(row.readyDate);
  const received = row.receivedQty == null ? null : n(row.receivedQty);
  const remaining = received == null ? null : Math.max(0, n(row.qty) - received);
  const timing = received != null && remaining <= .000001 && n(row.qty) > 0 ? "RECEIVED"
    : !eta ? "MISSING" : ((needed && ready && ready > needed) || (target && eta > target) || (!target && needed && !row.requiresQc && eta > needed) || eta < day(now)) ? "LATE"
      : !needed || (row.requiresQc && !ready && !target) ? "UNKNOWN" : "ON_TRACK";
  return { ...row, canConfirm: row.canConfirm !== false && timing !== "RECEIVED", needDate: needed, targetArrivalDate: target, customerDeliveryDate: day(row.customerDeliveryDate), purchaseMaxDate: day(row.purchaseMaxDate), eta, readyDate: ready, receivedQty: received, remainingQty: remaining, timing, confirmation: row.etaBasis === "BOM" ? "BOM" : eta ? (row.confirmed ? "CONFIRMED" : "PLANNED") : "MISSING" };
}
function period(month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month || "")) throw Object.assign(new Error("Periode harus YYYY-MM."), { status: 400 });
  const start = new Date(`${month}-01T00:00:00Z`);
  return { gte: start, lt: new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1)) };
}
async function partsFor(db, codes) {
  const rows = await db.part.findMany({ where: { partCode: { in: [...new Set(codes.filter(Boolean))] } }, select: partSelect });
  return new Map(rows.map((r) => [r.partCode, r]));
}
function checkLimit(rows) {
  if (rows.length > 5000) throw Object.assign(new Error("Lebih dari 5.000 dokumen sumber pada periode ini. Persempit data sumber sebelum memuat ETA."), { status: 422 });
  return rows;
}
async function supplierSuggestions(db, range, readSuggestion = require("../../controllers/purchasing/PurchaseSuggestionController").readSuggestion) {
  const rows = checkLimit(await db.purchaseSuggestionItem.findMany({
    // Filter only AFTER resolving the dates: a corrected deadline can cross months.
    where: { isDeleted: false, status: { notIn: closed }, suggestion: { isDeleted: false, status: { notIn: closed } } },
    include: { supplierAllocations: { where: { isDeleted: false, status: { notIn: [...closed, "Rejected"] } } } }, orderBy: [{ materialRequiredDate: "asc" }, { id: "asc" }], take: 5001,
  }));
  const parts = await partsFor(db, rows.map((r) => r.partCode));
  const dates = new Map();
  for (const suggestionNumber of new Set(rows.map((r) => r.suggestionNumber))) {
    const suggestion = await readSuggestion(db, suggestionNumber);
    for (const item of suggestion?.items || []) dates.set(item.id, item);
  }
  return rows.flatMap((r) => {
    const calculated = dates.get(r.id);
    const base = { sourceVersion: r.updatedAt, requiredQty: r.recommendedPurchaseQty, materialCode: r.materialCode, purchasePackageUomCode: r.purchasePackageUomCode || calculated?.purchasePackageUomCode, materialWidth: r.confirmedMaterialWidth || calculated?.confirmedMaterialWidth, materialLength: r.confirmedMaterialLength || calculated?.confirmedMaterialLength, canConfirm: !r.qtyConvertedToPr, blockReason: r.qtyConvertedToPr ? "Sudah menjadi PR; lanjutkan konfirmasi pada PO terkait." : null, category: category(parts.get(r.partCode), r.materialCode), code: r.materialCode || r.partCode, name: r.materialDescription || r.partName, partNumber: r.partNumber, needDate: calculated?.calculatedProductionDueDate || r.materialRequiredDate, targetArrivalDate: calculated?.supplierRequiredArrivalDate, customerDeliveryDate: r.customerDeliveryDate, purchaseMaxDate: calculated?.calculatedPurchaseDueDate, needDateSource: "MRP Delivery Need · lead time supplier", requiresQc: true, uom: r.uomCode, stock: r.availableStock, source: r.suggestionNumber, documentStatus: r.status, href: `/modules/purchasing/purchase-suggestions/${enc(r.suggestionNumber)}`, action: "Konfirmasi / Detail", stage: "Purchase Suggestion" };
    const allocations = r.supplierAllocations || [];
    if (!allocations.length) return [{ ...base, id: `PS:${r.id}`, partnerCode: calculated?.effectiveSupplierCode || r.alternativeSupplierCode || r.suggestedSupplierCode, partner: calculated?.effectiveSupplierName || calculated?.effectiveSupplierCode || r.suggestedSupplierName || r.suggestedSupplierCode, qty: r.confirmedQty ?? r.recommendedPurchaseQty, eta: r.confirmedDeliveryDate, leadTime: r.confirmedLeadTimeDays ?? r.purchasingLeadTimeDays, confirmed: supplierConfirmed.has(r.confirmationStatus) }];
    const result = allocations.map((a) => ({ ...base, id: `PSA:${a.id}`, sourceVersion: a.updatedAt, requiredQty: a.offeredQty || a.confirmedQty, canConfirm: false, blockReason: "Pembagian supplier dikelola pada Purchase Suggestion agar alokasi qty tetap konsisten.", partnerCode: a.supplierCode, partner: a.supplierName || a.supplierCode, qty: a.confirmedQty > 0 ? a.confirmedQty : a.offeredQty, eta: a.deliveryDate, leadTime: a.leadTimeDays ?? r.purchasingLeadTimeDays, confirmed: Boolean(a.confirmedAt) && ["Confirmed", "Converted to PR"].includes(a.status) }));
    const remainder = n(r.recommendedPurchaseQty) - result.reduce((sum, a) => sum + n(a.qty), 0);
    if (remainder > .000001) result.push({ ...base, id: `PS:${r.id}:UNASSIGNED`, partner: null, qty: remainder, eta: null, confirmed: false });
    return result;
  });
}
const earliest = (values) => values.filter((v) => day(v)).sort((a, b) => new Date(a) - new Date(b))[0] || null;
function purchaseOrderDates(row, suggestionItems) {
  const sources = (row.prDetail?.sources || []).filter((s) => !s.isDeleted && s.metadata?.allocationType !== "MOQ_PULL_FORWARD");
  const items = sources.map((s) => suggestionItems.get(s.metadata?.purchaseSuggestionItemId));
  const needDate = earliest(sources.map((s, i) => items[i]?.calculatedProductionDueDate || s.requiredDate)) || row.prDetail?.pr?.requiredDate;
  return { needDate, targetArrivalDate: items.length && items.every((i) => i?.supplierRequiredArrivalDate) ? earliest(items.map((i) => i.supplierRequiredArrivalDate)) : null, customerDeliveryDate: earliest(items.map((i) => i?.customerDeliveryDate)), needDateSource: sources.length ? "Kebutuhan per item PR / Purchase Suggestion" : "Tanggal header PR · sumber item belum tersedia", requiresQc: true };
}
async function purchaseOrders(db, range) {
  const rows = checkLimit(await db.purchaseOrderDetail.findMany({ where: { isDeleted: false, po: { isDeleted: false, status: { notIn: closed } } }, include: { po: true, prDetail: { include: { pr: true, sources: { where: { isDeleted: false } } } } }, orderBy: [{ deliveryDate: "asc" }, { id: "asc" }], take: 5001 }));
  const parts = await partsFor(db, rows.map((r) => r.partCode));
  const suggestionItems = new Map();
  for (const number of new Set(rows.flatMap((r) => (r.prDetail?.sources || []).map((s) => s.metadata?.purchaseSuggestionNumber)).filter(Boolean))) {
    const suggestion = await require("../../controllers/purchasing/PurchaseSuggestionController").readSuggestion(db, number);
    for (const item of suggestion?.items || []) suggestionItems.set(item.id, item);
  }
  return rows.map((r) => ({ id: `PO:${r.id}`, sourceVersion: `${r.updatedAt.toISOString()}|${r.po.updatedAt.toISOString()}`, partnerCode: r.po.supplierCode || r.po.vendorCode, category: r.po.poType === "Out Process" ? "VENDOR" : category(parts.get(r.partCode), r.materialCode), code: r.materialCode || r.partCode, name: r.materialName || r.partName || r.description, partNumber: r.partNumber, partner: r.po.supplierName || r.po.vendorName || r.po.supplierCode || r.po.vendorCode, ...purchaseOrderDates(r, suggestionItems), eta: r.deliveryDate || r.po.deliveryDate, qty: r.qty, receivedQty: r.qtyReceived, uom: r.uomCode, confirmed: false, source: r.poNumber, documentStatus: r.po.status, stage: "Purchase Order · tanggal dokumen", href: `/modules/purchasing/purchase-order/${enc(r.poNumber)}`, action: "Buka PO" }));
}
async function vendorPlans(db, range) {
  const rows = checkLimit(await db.productionPlanAllocation.findMany({ where: { isDeleted: false, routingMode: "VENDOR", planningMode: "PRODUCTION", status: { notIn: closed }, plan: { isDeleted: false, status: { notIn: closed } }, OR: [{ vendorReturnDate: range }, { fgRequiredDate: range }, { scheduleDate: range }] }, include: { plan: { select: { planNumber: true, periodStart: true } }, vendor: { select: { vendorCode: true, vendorName: true } }, mbomProcess: { include: { process: true, mbomDetail: { include: { part: { select: partSelect } } } } } }, orderBy: [{ vendorReturnDate: "asc" }, { id: "asc" }], take: 5001 }));
  const successors = rows.length ? checkLimit(await db.productionPlanAllocation.findMany({
    where: { planId: { in: [...new Set(rows.map((r) => r.planId))] }, isDeleted: false, planningMode: "PRODUCTION", status: { notIn: closed } },
    include: { plan: { select: { planNumber: true } }, mbomProcess: { include: { process: true } } }, take: 5001,
  })) : [];
  const { resolveVendorReturnDeadline } = require("../planning/capacityPlanningService");
  return rows.map((r) => { const part = r.mbomProcess?.mbomDetail?.part; const deadline = resolveVendorReturnDeadline(r, successors); const planMonth = day(r.plan.periodStart || r.scheduleDate)?.slice(0, 7); return { id: `VP:${r.id}`, sourceVersion: r.updatedAt, partnerCode: r.vendor?.vendorCode, category: "VENDOR", code: part?.partCode, name: part?.partName, partNumber: part?.partNumber, process: r.mbomProcess?.process?.processCode, partner: r.vendor?.vendorName || r.vendor?.vendorCode, needDate: deadline?.deadline, targetArrivalDate: deadline?.deadline, needDateSource: deadline?.source === "SUCCESSOR_START" ? `Mulai proses berikutnya · ${deadline.successorProcessCode || "produksi"}` : "Batas selesai routing / FG", customerDeliveryDate: r.customerTargetDate, eta: r.vendorReturnDate, sendDate: r.vendorSendDate, leadTime: r.vendorLeadTimeDays, qty: r.expectedReturnQty ?? r.plannedQty, uom: r.uomCode, confirmed: false, source: r.plan.planNumber, documentStatus: r.status, stage: "Rencana vendor · belum konfirmasi", href: `/modules/planning-ppic/monthly-production-plans?planNumber=${enc(r.plan.planNumber)}${planMonth ? `&month=${enc(planMonth)}` : ""}`, action: "Buka Monthly Plan" }; });
}
async function vendorOrders(db, range) {
  const rows = checkLimit(await db.vendorProcessOrder.findMany({ where: { isDeleted: false, status: { notIn: closed }, OR: [{ dueDate: range }, { receivedAt: range }] }, orderBy: [{ dueDate: "asc" }, { id: "asc" }], take: 5001 }));
  // The order has only a return target, not a separate supplier commitment.
  // Do not compare this date against itself and declare it on track.
  return rows.map((r) => ({ id: `VO:${r.id}`, sourceVersion: r.updatedAt, partnerCode: r.vendorCode, category: "VENDOR", code: r.outputPartCode, name: r.outputPartName, partNumber: r.outputPartNumber, process: r.processCode, partner: r.vendorName || r.vendorCode, needDate: r.dueDate, targetArrivalDate: r.dueDate, needDateSource: "Target kembali pada order vendor", eta: null, sendDate: r.sentAt, qty: r.qtyPlanned, receivedQty: r.qtyReceived, uom: r.uomCode, confirmed: false, source: r.orderNumber, documentStatus: r.status, stage: "Order vendor · konfirmasi kembali", href: `/modules/production/vendor-process-orders/${enc(r.orderNumber)}`, action: "Buka order" }));
}
async function customerSupplies(db, range) {
  const rows = checkLimit(await db.customerSupplyRequest.findMany({ where: { status: { not: "CANCELLED" }, OR: [{ requiredDate: range }, { shipments: { some: { status: { not: "CANCELLED" }, eta: range } } }] }, include: { shipments: { where: { status: { not: "CANCELLED" } }, include: { receipts: true } } }, orderBy: [{ requiredDate: "asc" }, { id: "asc" }], take: 5001 }));
  const [parts, customers] = await Promise.all([partsFor(db, rows.map((r) => r.partCode)), db.customer.findMany({ where: { customerCode: { in: [...new Set(rows.map((r) => r.customerCode))] } }, select: { customerCode: true, customerName: true } })]);
  const names = new Map(customers.map((c) => [c.customerCode, c.customerName]));
  return rows.flatMap((r) => {
    const part = parts.get(r.partCode);
    const base = { requestId: r.id, partnerCode: r.customerCode, sourceVersion: r.updatedAt, category: "CUSTOMER", code: r.materialCode || r.partCode, name: part?.partName, partNumber: part?.partNumber, partner: names.get(r.customerCode) || r.customerCode, needDate: r.requiredDate, needDateSource: "Tanggal kebutuhan permintaan suplai customer", requiresQc: true, uom: r.uomCode, source: r.requestNumber, documentStatus: r.status, stage: "Suplai customer · tanpa PO", href: `/modules/purchasing/customer-supplies?q=${enc(r.requestNumber)}`, action: "Kelola kiriman" };
    const result = r.shipments.map((s) => ({ ...base, id: `CS:${s.id}`, sourceVersion: s.updatedAt, canConfirm: s.receipts.length === 0, blockReason: s.receipts.length ? "Kiriman sudah memiliki penerimaan. Kelola perubahan pada dokumen suplai customer." : null, qty: s.qty, eta: s.eta, readyDate: s.readyDate, confirmed: s.status === "CONFIRMED" && Boolean(s.confirmationReference), receivedQty: s.receipts.reduce((sum, x) => sum + n(x.receivedQty), 0), qcHold: s.receipts.filter((x) => x.qcStatus === "PENDING").reduce((sum, x) => sum + n(x.receivedQty), 0), rejectedQty: s.receipts.reduce((sum, x) => sum + n(x.rejectedQty), 0) }));
    // Rejected receipts require replacement; cancellation never erases received history.
    const covered = result.reduce((sum, x) => sum + n(x.qty) - n(x.rejectedQty), 0);
    if (n(r.qtyRequested) > covered + .000001) result.push({ ...base, id: `CR:${r.id}`, qty: n(r.qtyRequested) - covered, eta: null, receivedQty: 0, confirmed: false });
    return result;
  });
}
const loaders = { suggestions: supplierSuggestions, orders: purchaseOrders, "vendor-plans": vendorPlans, "vendor-orders": vendorOrders, customer: customerSupplies };
async function list(db, source, month, mpsNumber) {
  if (source === "mps") {
    const result = await require("../planning/mpsEtaService").list(db, month, mpsNumber);
    return { source, month, asOf: day(businessNow()), ...result, items: result.items.map((r) => finish(r)) };
  }
  if (!loaders[source]) throw Object.assign(new Error("Sumber ETA tidak tersedia."), { status: 404 });
  const rows = await loaders[source](db, period(month));
  const attached = await require("./etaConfirmationStore").attach(db, rows);
  return { source, month, asOf: day(businessNow()), items: attached.map((r) => finish(r)).filter((r) => [r.needDate, r.targetArrivalDate, r.customerDeliveryDate, r.eta].some((value) => value?.startsWith(month))).sort((a, b) => String(a.needDate || a.eta || "9999").localeCompare(String(b.needDate || b.eta || "9999")) || a.id.localeCompare(b.id)) };
}
module.exports = { list, finish, period, category, loaders, purchaseOrderDates };
