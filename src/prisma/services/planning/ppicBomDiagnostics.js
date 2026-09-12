"use strict";
// Inspect the revision referenced by MPS, never substitute the latest revision.
function diagnoseBom(items, details, routes) {
  const checks = [];
  for (const item of items) {
    const header = details.find(row => row.id === item.id)?.mbom;
    const route = header ? `/modules/manufacturing-bom/bill-of-materials/${encodeURIComponent(header.noReg)}` : "/modules/manufacturing-bom/bill-of-materials";
    const add = (field, actual, valid, action, component = null, process = null, document = header?.noReg) => checks.push({
      code: "BOM_INPUT_DIAGNOSTIC", partCode: item.partCode, component, process, document,
      field, actual, status: valid ? "OK" : "BLOCKER", owner: "Engineering",
      reason: valid ? `${field}: terisi dan valid pada pemeriksaan dasar.` : `${component || item.partCode}${process ? " / " + process : ""}: ${action}`,
      recommendation: valid ? "Tidak perlu perubahan untuk pemeriksaan ini." : action,
      route: document ? `/modules/manufacturing-bom/bill-of-materials/${encodeURIComponent(document)}` : route,
    });
    add("Revisi BOM pada MPS", header && !header.isDeleted ? `${header.noReg} · revisi ${header.revision}` : null, Boolean(header && !header.isDeleted), "Pilih BOM yang tersedia pada detail MPS lalu hitung ulang rencana.");
    if (!header || header.isDeleted) continue;
    add("UOM produk", header.uomCode, Boolean(header.uomCode), "Isi satuan produk pada header BOM.");
    const components = (header.details || []).filter(row => !row.isDeleted);
    add("Jumlah komponen", components.length, components.length > 0, "Tambahkan komponen pada BOM yang dipakai MPS.");
    for (const row of components) {
      const code = row.part?.partCode || row.id;
      add("Qty komponen", row.qty, row.qty != null && Number.isFinite(Number(row.qty)) && Number(row.qty) > 0, "Isi qty kebutuhan komponen lebih dari 0 sesuai BOM engineering.", code);
      add("UOM komponen", row.uomCode, Boolean(row.uomCode), "Isi satuan kebutuhan komponen.", code);
    }
    const processIds = new Set((item.components || []).flatMap(row => (row.processes || []).map(process => process.id)));
    for (const row of routes.filter(row => processIds.has(row.id))) {
      const component = row.mbomDetail?.part?.partCode;
      const process = row.process?.processName || row.process?.processCode || row.id;
      add("Master proses", row.process?.processCode, Boolean(row.process && !row.process.isDeleted), "Pilih master proses yang aktif pada routing.", component, process, row.noReg);
      if (row.routingMode === "VENDOR") {
        add("Vendor pelaksana", row.vendor?.vendorCode, Boolean(row.vendorId && row.vendor && !row.vendor.isDeleted && row.vendor.status !== "Inactive"), "Pilih vendor pelaksana yang aktif pada proses ini.", component, process, row.noReg);
      } else {
        add("Cycle time (detik)", row.cycleTime, row.cycleTime != null && Number.isFinite(Number(row.cycleTime)) && Number(row.cycleTime) > 0, "Isi cycle time proses in-house lebih dari 0 detik berdasarkan standar proses.", component, process, row.noReg);
      }
    }
  }
  return checks;
}
module.exports = { diagnoseBom };
