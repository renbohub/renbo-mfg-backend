"use strict";
const { VERSION } = require("./mpsProductionEvidenceService");
const finite = (v) => v != null && v !== "" && Number.isFinite(Number(v));
const fmt = (v) => new Intl.NumberFormat("id-ID", { maximumFractionDigits: 3 }).format(Number(v));

// Informational, read-only report. Never replace the validation in MRP submit.
function build({ doc, rows = [], etaItems = [], etaGate, rccp, rccpApprovalAllowed, deliveryGate, mrp, inputKey, month, planningLock }) {
  const checks = [];
  const add = (id, label, status, reason, details = [], href = null) => checks.push({ id, label, status, reason, details, href });
  const details = doc?.details || [];
  const production = details.filter((d) => Number(d.qtyPlanned) > 0);
  const fresh = Boolean(doc && !doc.replanRequired && production.every((d) => {
    const s = d.calculationTrace?.productionChecksheet;
    const phases = Object.values(s?.phases || {});
    return s?.version === VERSION && s.sourceKey === inputKey && s.mpsRevision === doc.revision && s.mbomHeaderId === d.mbomHeaderId
      && phases.length > 0 && phases.every((p) => p.complete && !p.error)
      && Math.abs(phases.reduce((sum, p) => sum + Number(p.plannedProductionQty || 0), 0) - Number(d.qtyPlanned)) < 0.0001;
  }));
  add("demand", "Demand & revisi MPS", !doc ? "UNKNOWN" : doc.replanRequired || planningLock?.hasPoDelta ? "FAIL" : details.length ? "PASS" : "FAIL",
    !doc ? "Bentuk MPS dari demand periode ini terlebih dahulu." : planningLock?.hasPoDelta ? "Ada perubahan PO setelah baseline; tinjau Delta MPS / Production Cut." : doc.replanRequired ? doc.replanReason || "Demand berubah; hitung ulang MPS." : `${details.length} FG pada ${doc.mpsNumber} · revisi ${doc.revision}.`);
  add("approval", "Approval MPS", !doc ? "UNKNOWN" : ["Confirmed", "Released"].includes(doc.status) ? "PASS" : "FAIL",
    doc ? `Status ${doc.status}. MRP resmi memerlukan Confirmed / Released.` : "MPS belum tersedia.");
  add("fg", "Saldo FG tersedia", rows.length && rows.every((r) => finite(r.availableStockQty)) ? "PASS" : "UNKNOWN",
    "Saldo tersedia dibaca dari inventory saat permintaan ini; bukan jumlah on hand seluruhnya.",
    rows.map((r) => `${r.partCode}: ${fmt(r.availableStockQty)} ${r.uomCode || ""}`));
  const bomIssues = production.flatMap((d) => {
    const h = d.mbom;
    if (!h || h.isDeleted || !h.details?.length) return [`${d.partCode}: BOM terpilih belum tersedia / kosong.`];
    return h.details.filter((c) => !c.part || !finite(c.qty) || Number(c.qty) <= 0 || !(c.uomCode || c.part?.baseUomCode))
      .map((c) => `${h.noReg} · ${c.part?.partCode || c.id}: part, qty, atau UOM belum lengkap.`);
  });
  add("bom", "Struktur BOM terpilih", !doc ? "UNKNOWN" : bomIssues.length ? "FAIL" : "PASS", "Memeriksa part, qty dan UOM pada BOM yang dipakai MPS.", bomIssues);
  const routes = production.flatMap((d) => (d.mbom?.details || []).flatMap((c) => (c.mbomProcesses || []).map((r) => ({ ...r, child: c }))));
  const routeIssues = routes.filter((r) => !r.process || !finite(r.sequence) || Number(r.sequence) <= 0
    || (String(r.routingMode).toUpperCase() !== "VENDOR" && String(r.child.category).toUpperCase() !== "VENDOR" && !(Number(r.cycleTime) > 0)))
    .map((r) => `${r.child.part?.partCode}: ${r.process?.processCode || "proses kosong"} · urutan / cycle time belum valid.`);
  for (const d of production) for (const c of d.mbom?.details || []) {
    if (String(c.category).toUpperCase() !== "PURCHASE" && c.part?.itemType !== "FG" && !c.mbomProcesses?.length) routeIssues.push(`${c.part?.partCode || c.id}: routing belum tersedia.`);
    const sequences = (c.mbomProcesses || []).map((r) => Number(r.sequence));
    if (new Set(sequences).size !== sequences.length) routeIssues.push(`${c.part?.partCode || c.id}: urutan proses duplikat.`);
  }
  add("routing", "Proses, urutan & cycle time routing", !doc ? "UNKNOWN" : routeIssues.length ? "FAIL" : production.length && !routes.length ? "UNKNOWN" : "PASS",
    `${routes.length} proses pada BOM terpilih diperiksa. Ketersediaan mesin mengikuti RCCP.`, routeIssues);
  add("evidence", "Checksheet sesuai data terbaru", !doc ? "UNKNOWN" : fresh ? "PASS" : "FAIL",
    fresh ? "Revisi, BOM, stok dan sumber pemeriksaan cocok dengan data saat ini." : "Hasil lama / belum lengkap. Klik Periksa Checksheet pada workbench.");
  const materials = fresh ? production.flatMap((d) => Object.values(d.calculationTrace?.productionChecksheet?.phases || {}).flatMap((p) => p.materialCoverage || [])) : [];
  const shortages = new Map();
  for (const r of materials) if (Number(r.shortageQty) > 0) {
    const key = `${r.materialCode || r.partCode}|${r.uomCode || ""}`;
    const old = shortages.get(key) || { code: r.materialCode || r.partCode, unit: r.uomCode || "", qty: 0 };
    old.qty += Number(r.shortageQty); shortages.set(key, old);
  }
  add("material", "Kebutuhan bersih material", !fresh || materials.some((r) => !finite(r.shortageQty)) ? "UNKNOWN" : shortages.size ? "WARNING" : "PASS",
    shortages.size ? "Kekurangan menjadi kebutuhan pengadaan MRP; kesiapan tanggal suplai diperiksa pada ETA." : fresh ? "Tidak ada kekurangan material pada checksheet terkini." : "Periksa checksheet agar shortage mengikuti data terbaru.",
    [...shortages.values()].map((r) => `${r.code}: shortage ${fmt(r.qty)} ${r.unit}`), etaGate?.href);
  for (const [id, label, vendor] of [["materialEta", "ETA supplier / customer", false], ["vendorEta", "ETA proses vendor", true]]) {
    const subset = etaItems.filter((r) => r.category !== "CHECKSHEET" && (r.category === "VENDOR") === vendor);
    const pending = subset.filter((r) => !r.readiness?.ready);
    add(id, label, !fresh ? "UNKNOWN" : pending.length ? "FAIL" : "PASS",
      `${subset.length - pending.length}/${subset.length} jadwal siap · sumber ${doc?.etaMode === "MANUAL" ? "konfirmasi" : "BOM"}.`,
      pending.map((r) => `${r.code} ${r.process || ""} · ${r.partner || ""}: ${r.readiness?.reason || "Belum siap"}`), etaGate?.href);
  }
  add("machine", "Kapasitas mesin / RCCP", !fresh || !rccp || rccp.mpsRevision !== doc?.revision ? "UNKNOWN" : rccpApprovalAllowed ? rccp.status === "FEASIBLE" ? "PASS" : "WARNING" : "FAIL",
    rccp ? `RCCP ${rccp.status}${!fresh ? " · perlu evaluasi dengan data terbaru" : ""}.` : "RCCP belum tersedia.");
  const gateKnown = Boolean(deliveryGate?.officialGateStatus);
  const deliveryRisk = deliveryGate?.officialGateStatus === "APPROVED_WITH_EXCEPTION" || (deliveryGate?.snapshots || []).some((s) => s.feasibilityStatus === "AT_RISK");
  add("delivery", "Tanggal selesai & delivery customer", !fresh || !gateKnown ? "UNKNOWN" : deliveryGate.officialGateStatus === "BLOCKED" ? "FAIL" : deliveryRisk ? "WARNING" : "PASS",
    deliveryGate?.reason || "Hasil delivery gate belum tersedia.");
  const running = ["Pending", "Running", "Queued", "Processing"].includes(mrp?.status);
  add("mrp", "Ketersediaan proses MRP", !doc ? "UNKNOWN" : running ? "FAIL" : "PASS",
    running ? `${mrp.runNumber} sedang ${mrp.status}.` : mrp ? `${mrp.runNumber} · ${mrp.status}${mrp.isCurrentPlan ? "" : " · perlu revision / rerun"}.` : "Belum ada run MRP pada periode ini.");
  for (const [id, label] of [["wip", "Perhitungan WIP"], ["manpower", "Kapasitas manpower"], ["tooling", "Ketersediaan tooling"], ["calendar", "Validasi kalender produksi terpisah"], ["quality", "Quality / Engineering release"]]) {
    add(id, label, "UNKNOWN", "Belum ada hasil pemeriksaan khusus parameter ini pada checksheet MPS. Tidak disimpulkan OK dari RCCP atau BOM saja.");
  }
  const counts = Object.fromEntries(["PASS", "FAIL", "WARNING", "UNKNOWN"].map((s) => [s, checks.filter((c) => c.status === s).length]));
  return { month, mpsNumber: doc?.mpsNumber || null, checkedAt: new Date().toISOString(), checks, counts, total: checks.length,
    status: counts.FAIL ? "NOT_READY" : counts.UNKNOWN ? "NEEDS_REVIEW" : counts.WARNING ? "READY_WITH_RISK" : "READY",
    scope: "MPS periode terpilih. MRP resmi memvalidasi ulang seluruh MPS dalam planning cycle saat dijalankan.",
    simulation: doc && details.length && !doc.replanRequired && !running ? "Simulasi MRP dapat digunakan untuk meninjau kebutuhan; hasilnya belum menjadi rencana resmi." : "Selesaikan pembentukan / pembaruan MPS atau tunggu proses MRP berjalan selesai." };
}
module.exports = { build };
