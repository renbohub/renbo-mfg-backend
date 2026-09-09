"use strict";
const { createHash } = require("node:crypto");
const day = (v) => v && Number.isFinite(new Date(v).getTime()) ? new Date(v).toISOString().slice(0, 10) : null;
const hash = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const fail = (message, statusCode = 409, code = "ETA_CONFIRMATION_INVALID") => { throw Object.assign(new Error(message), { statusCode, code }); };
function fingerprint(row) {
  return hash([row.id, row.source, row.mpsRevision ?? null, row.sourceVersion ?? null, row.bomId ?? null, row.code, row.partCode ?? null, row.process ?? null, row.partnerCode, row.uom, row.requiredQty ?? row.qty, day(row.needDate), day(row.targetArrivalDate), day(row.sendDate), row.leadTime ?? null]);
}
async function latest(db, keys) {
  if (!keys.length) return new Map();
  const records = await db.etaConfirmation.findMany({ where: { sourceKey: { in: [...new Set(keys)] } }, orderBy: [{ confirmedAt: "desc" }, { id: "desc" }], distinct: ["sourceKey"] });
  return new Map(records.map((r) => [r.sourceKey, r]));
}
function decorate(row, record) {
  const sourceFingerprint = fingerprint(row);
  const valid = Boolean(record && record.sourceFingerprint === sourceFingerprint && !row.stale);
  const confirmedQty = valid ? Number(record.qty) : (!record && row.confirmed ? Number(row.qty) : null);
  const savedLeadTime = record?.sourceSnapshot?.leadTimeDays;
  const hasLeadTime = savedLeadTime != null && Number.isFinite(Number(savedLeadTime)) && Number(savedLeadTime) >= 0;
  const confirmedLeadTimeDays = valid && hasLeadTime ? Number(savedLeadTime) : null;
  return { ...row, etaBasis: valid || (!record && row.confirmed) ? "MANUAL" : "PENDING", confirmed: record ? valid : Boolean(row.confirmed), sourceFingerprint, confirmedQty, confirmedLeadTimeDays, effectiveLeadTimeDays: confirmedLeadTimeDays ?? row.leadTime ?? null, ...(valid ? { eta: day(record.eta), readyDate: day(record.readyDate) } : {}),
    confirmationRecord: record ? { id: record.id, valid, qty: record.qty, leadTimeDays: hasLeadTime ? Number(savedLeadTime) : null, eta: day(record.eta), readyDate: day(record.readyDate), reference: record.confirmationReference, notes: record.notes, by: record.confirmedBy, at: record.confirmedAt } : null,
    canConfirm: row.canConfirm !== false && !row.stale && Boolean(row.partnerCode) && Number(row.requiredQty ?? row.qty) > 0 && Boolean(day(row.needDate)),
  };
}
async function withLeadTime(decorated) {
    const r = decorated;
    if (r.etaMode === "BOM") return decorated;
    // Confirmed LT changes the order deadline, never the underlying MPS need
    // date, baseline lead time, or source fingerprint.
    if (r.checkpoint === "MPS_MATERIAL" && r.category !== "CUSTOMER" && decorated.confirmedLeadTimeDays != null && day(r.needDate)) {
      const schedule = await require("../planning/procurementSchedulingService").procurementSchedule({ ...(r.procurementPolicy || {}), materialRequiredDate: r.needDate, supplierLeadTimeDays: decorated.confirmedLeadTimeDays });
      decorated.purchaseMaxDate = day(schedule.latestPoDate);
      decorated.latestPrDate = day(schedule.latestPrDate);
    }
    if (r.checkpoint === "MPS_VENDOR" && decorated.confirmedLeadTimeDays != null) {
      decorated.leadTimeCheck = await require("./etaLeadTimeService").evaluateLeadTimeWindow(r);
      decorated.earliestReturnDate = decorated.leadTimeCheck.earliestReturnDate;
      decorated.leadTimeFits = decorated.leadTimeCheck.leadTimeFits;
    }
    return decorated;
}
async function attach(db, rows) {
  const records = await latest(db, rows.map((r) => r.id));
  return Promise.all(rows.map((r) => withLeadTime(decorate(r, records.get(r.id)))));
}
function validate(input, row) {
  if (!/^[a-zA-Z0-9-]{16,80}$/.test(input.requestId || "")) fail("Identitas penyimpanan tidak valid. Buka ulang form.", 400);
  if (input.sourceFingerprint !== row.sourceFingerprint) fail("Kebutuhan berubah. Refresh ETA sebelum mengonfirmasi.", 409, "ETA_SOURCE_CHANGED");
  if (!row.canConfirm) fail(row.blockReason || "Lengkapi sumber, partner dan checksheet sebelum konfirmasi ETA.");
  const qty = Number(input.qty), eta = day(input.eta), readyDate = day(input.readyDate);
  const hasLeadTime = input.leadTimeDays != null && String(input.leadTimeDays).trim() !== "";
  if (row.id?.startsWith("PS:") && hasLeadTime && !Number.isInteger(Number(input.leadTimeDays))) fail("Lead time Purchase Suggestion harus berupa jumlah hari bulat.", 400);
  if ((row.mpsNumber && !hasLeadTime) || (hasLeadTime && (typeof input.leadTimeDays === "boolean" || !["string", "number"].includes(typeof input.leadTimeDays) || !Number.isFinite(Number(input.leadTimeDays)) || Number(input.leadTimeDays) < 0 || Number(input.leadTimeDays) > 3650))) fail("Isi lead time konfirmasi 0–3.650 hari. Nilai 0 hanya untuk suplai/proses tanpa waktu tunggu.", 400);
  if (!Number.isFinite(qty) || qty <= 0) fail("Qty konfirmasi harus lebih dari 0.", 400);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.eta || "") || eta !== input.eta) fail("Isi tanggal ETA yang valid.", 400);
  if (input.readyDate && readyDate !== input.readyDate) fail("Tanggal siap setelah QC tidak valid.", 400);
  if (row.requiresQc && !readyDate) fail("Isi tanggal siap setelah QC.", 400);
  if (readyDate && readyDate < eta) fail("Tanggal siap setelah QC tidak boleh sebelum ETA.", 400);
  if (row.sendDate && eta < day(row.sendDate)) fail("ETA kembali tidak boleh sebelum tanggal kirim ke vendor.", 400);
  const reference = String(input.reference || "").trim(), notes = String(input.notes || "").trim();
  if (!reference || reference.length > 500 || notes.length > 2000) fail("Isi referensi konfirmasi (maks. 500 karakter) dan catatan maks. 2.000 karakter.", 400);
  return { qty, eta: new Date(`${eta}T00:00:00Z`), readyDate: readyDate ? new Date(`${readyDate}T00:00:00Z`) : null, confirmationReference: reference, notes: notes || null };
}
function readiness(row) {
  if (row.stale || row.checkOnly) return { ready: false, reason: row.blockReason || "Periksa checksheet terbaru." };
  if (row.etaMode === "BOM" && row.etaBasis === "BOM") {
    if (!row.bomCalculation?.available) return { ready: false, reason: row.bomCalculation?.reason || "Perhitungan ETA By BOM belum lengkap." };
    if (row.checkpoint === "MPS_VENDOR" && row.leadTimeFits !== true) return { ready: false, reason: "Lead time BOM melewati batas proses vendor. Perlu recovery jadwal." };
    const readyDate = day(row.readyDate || (!row.requiresQc && row.eta));
    if (!readyDate || !day(row.needDate)) return { ready: false, reason: "Tanggal kesiapan By BOM belum lengkap." };
    if (readyDate > day(row.needDate) || (row.targetArrivalDate && day(row.eta) > day(row.targetArrivalDate))) return { ready: false, reason: "ETA By BOM melewati kebutuhan. Revisi jadwal atau pilih Konfirmasi ETA di MPS setelah mendapatkan komitmen percepatan." };
    return { ready: true, basis: "BOM", reason: "ETA perhitungan BOM memenuhi kebutuhan planning; belum merupakan komitmen partner." };
  }
  if (!row.confirmed) return { ready: false, reason: row.confirmationRecord ? "Sumber berubah; konfirmasi ulang." : "Menunggu konfirmasi." };
  if (row.mpsNumber && row.confirmedLeadTimeDays == null) return { ready: false, reason: "Lead time partner belum dikonfirmasi." };
  if (row.checkpoint === "MPS_VENDOR" && row.leadTimeFits !== true) return { ready: false, reason: row.leadTimeFits === false ? `Lead time vendor melewati batas proses; paling cepat kembali ${row.earliestReturnDate}. Perlu recovery jadwal.` : "Kelayakan lead time vendor belum dapat dihitung; periksa tanggal kirim dan kebutuhan." };
  if (Number(row.confirmedQty ?? row.qty) + .000001 < Number(row.requiredQty ?? row.qty)) return { ready: false, reason: "Qty konfirmasi belum menutup kebutuhan." };
  const ready = day(row.readyDate || (!row.requiresQc && row.eta));
  if (!ready || !day(row.needDate)) return { ready: false, reason: "Tanggal kesiapan belum lengkap." };
  if (ready > day(row.needDate) || (row.targetArrivalDate && day(row.eta) > day(row.targetArrivalDate))) return { ready: false, reason: "ETA melewati kebutuhan; selesaikan recovery / revisi planning." };
  return { ready: true, reason: "Qty dan ETA terkonfirmasi sesuai kebutuhan." };
}
module.exports = { hash, day, fail, fingerprint, latest, decorate, withLeadTime, attach, validate, readiness };
