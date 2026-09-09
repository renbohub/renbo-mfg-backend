"use strict";
const store = require("./etaConfirmationStore");
const monitor = require("./etaMonitorService");
const customerSupply = require("../planning/customerSupplyService");

async function sourceRow(db, source, id, month, mpsNumber) {
  const result = await monitor.list(db, source, month, mpsNumber);
  const row = result.items.find((r) => r.id === id);
  if (!row) store.fail("Item ETA tidak lagi tersedia pada periode ini. Refresh daftar.", 404);
  return row;
}
async function synchronize(tx, row, values, input, user) {
  const [type, id] = row.id.split(":");
  const actor = user.username || user.email || "system";
  if (type === "PS") {
    const controller = require("../../controllers/purchasing/PurchaseSuggestionController");
    const item = await tx.purchaseSuggestionItem.findFirst({ where: { id, suggestionNumber: row.source, isDeleted: false } });
    if (!item || item.qtyConvertedToPr > 0 || await tx.purchaseSuggestionSupplierAllocation.count({ where: { suggestionItemId: id, isDeleted: false } })) store.fail("Item telah dikonversi atau memiliki pembagian supplier. Refresh daftar.");
    const body = { confirmationStatus: values.qty + .000001 >= Number(row.requiredQty) ? "Available" : "Partially Available", confirmedQty: values.qty, confirmedDeliveryDate: store.day(values.eta), confirmedLeadTimeDays: input.leadTimeDays == null || String(input.leadTimeDays).trim() === "" ? row.leadTime : Number(input.leadTimeDays), alternativeSupplierCode: row.partnerCode,
      supplierRemark: `${values.confirmationReference}${values.notes ? ` · ${values.notes}` : ""}`, alternativeMaterialCode: item.alternativeMaterialCode, bypassConfirmationReason: item.bypassConfirmationReason,
      purchasePackageUomCode: input.purchasePackageUomCode || item.purchasePackageUomCode, confirmedMaterialWidth: input.materialWidth ?? item.confirmedMaterialWidth, confirmedMaterialLength: input.materialLength ?? item.confirmedMaterialLength };
    const updated = await controller.applyItemConfirmation(tx, item, body, user);
    // Supplier commitments are exact. MOQ/multiple rounding needs an explicit
    // change by the user, never a silent increase in a confirmed quantity.
    if (Math.abs(Number(updated.confirmedQty) - values.qty) > .000001) store.fail(`Qty harus sesuai MOQ / kelipatan pembelian (${updated.confirmedQty}). Sesuaikan qty berdasarkan konfirmasi supplier.`, 400);
  } else if (type === "CR") {
    const shipment = await customerSupply.addShipment(tx, id, values, actor);
    await customerSupply.confirmShipment(tx, id, shipment.id, { confirmationReference: values.confirmationReference }, actor);
    return `CS:${shipment.id}`;
  } else if (type === "CS") {
    if (Math.abs(values.qty - Number(row.qty)) > .000001) store.fail("Qty kiriman sudah ditetapkan. Ubah pembagian kiriman pada dokumen suplai customer.", 400);
    await customerSupply.rescheduleShipment(tx, row.requestId, id, { ...values, reason: values.confirmationReference }, actor);
    await customerSupply.confirmShipment(tx, row.requestId, id, { confirmationReference: values.confirmationReference }, actor);
  }
  // PO and vendor commitments are stored separately from planned dates and
  // receipts. Updating a commitment must not move the comparison deadline.
  return row.id;
}
async function confirm(tx, source, input, user = {}) {
  if (source === "mps" && (typeof input.mpsNumber !== "string" || !input.mpsNumber.trim())) store.fail("Pilih header MPS yang akan dikonfirmasi.", 400);
  const actor = user.username || user.email || "system";
  const requestHash = store.hash([source, input, actor]);
  const prior = input.requestId ? await tx.etaConfirmation.findUnique({ where: { requestId: input.requestId } }) : null;
  if (prior) {
    if (prior.sourceSnapshot?.requestHash !== requestHash) store.fail("Identitas penyimpanan sudah dipakai untuk konfirmasi berbeda.");
    return { saved: true, duplicate: true, id: prior.id, sourceKey: prior.sourceKey };
  }
  const row = await sourceRow(tx, source, input.id, input.month, input.mpsNumber);
  if (source === "mps" && row.mpsNumber !== input.mpsNumber) store.fail("Item tidak berasal dari header MPS yang dipilih.", 409, "ETA_MPS_MISMATCH");
  if ((input.confirmationId || null) !== (row.confirmationRecord?.id || null)) store.fail("Konfirmasi partner sudah diperbarui. Refresh status sebelum menyimpan kembali.", 409, "ETA_CONFIRMATION_CHANGED");
  const values = store.validate(input, row);
  if (!row.id.startsWith("MPS") && !row.id.startsWith("PS:") && values.qty > Number(row.requiredQty ?? row.qty) + .000001) store.fail("Qty konfirmasi tidak boleh melebihi qty dokumen sumber.", 400);
  const nextId = await synchronize(tx, row, values, input, user);
  const fresh = await sourceRow(tx, source, nextId, input.month, input.mpsNumber).catch((error) => {
    const etaMonth = store.day(values.eta).slice(0, 7);
    // A rescheduled customer shipment can move out of the displayed month.
    if (source === "mps" || error.statusCode !== 404 || etaMonth === input.month) throw error;
    return sourceRow(tx, source, nextId, etaMonth, input.mpsNumber);
  });
  const record = await tx.etaConfirmation.create({ data: {
    requestId: input.requestId, sourceKey: fresh.id, sourceType: source, sourceNumber: fresh.source, sourceFingerprint: fresh.sourceFingerprint,
    sourceSnapshot: JSON.parse(JSON.stringify({ requestHash, requestedSourceKey: row.id, code: fresh.code, process: fresh.process, uom: fresh.uom, qty: fresh.requiredQty ?? fresh.qty, needDate: fresh.needDate, targetArrivalDate: fresh.targetArrivalDate, sourceVersion: fresh.sourceVersion, detailId: fresh.detailId, phaseKey: fresh.phaseKey, checkpoint: fresh.checkpoint, leadTimeDays: input.leadTimeDays == null || String(input.leadTimeDays).trim() === "" ? null : Number(input.leadTimeDays), masterLeadTimeDays: fresh.leadTime ?? null })),
    mpsNumber: fresh.mpsNumber || null, mpsRevision: fresh.mpsRevision ?? null, partnerCode: fresh.partnerCode, ...values,
    confirmedBy: user.username || user.email || "system",
  } });
  const updated = await store.withLeadTime(store.decorate(fresh, record));
  return { saved: true, id: record.id, sourceKey: fresh.id, item: { ...monitor.finish(updated), readiness: store.readiness(updated) } };
}
module.exports = { confirm, sourceRow, synchronize };
