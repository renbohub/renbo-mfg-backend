"use strict";
const { numeric, iso } = require("./ppicWorkspaceDomain");
const { validateBomGraphStructure } = require("./solver/bomGraphValidationService");
const { resolveRoutingMachinePolicy } = require("./routingMachinePolicy");
const EPS = 1e-6;
const bomRoute = noReg => `/modules/manufacturing-bom/bill-of-materials/${encodeURIComponent(noReg)}`;
const mpsRoute = "/modules/planning-ppic/mps/workbench";
const day = value => iso(value) ? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(new Date(value)) : null;
const production = row => ["INHOUSE", "VENDOR"].includes(String(row.type || row.category).toUpperCase());
const discrete = unit => ["PCS", "PC", "PIECE", "PIECES", "EA", "UNIT", "SET"].includes(String(unit || "").trim().toUpperCase());

// Dates must come from the current phase's production requirements. A customer
// due date, another phase, or an obsolete MRP run is not production evidence.
function phaseWindow(item, phase, partCodes, current) {
  const ready = typeof current === "object" ? current.ready : current;
  if (!ready) return { status: "UNKNOWN", reason: current?.reason || "MRP belum menjadi rencana terkini atau MPS sudah berubah." };
  const required = (item.components || []).filter(row => production(row) && partCodes.has(row.partCode)).map(row => ({
    row, net: (row.phaseNetting || []).find(net => net.phaseId === phase.id),
  }));
  if (!required.length || required.some(({ net }) => numeric(net?.plannedOrderQty) == null)) return { status: "UNKNOWN", reason: "Alokasi produksi komponen pada fase ini belum tersedia." };
  const active = required.filter(({ net }) => numeric(net.plannedOrderQty) > EPS);
  if (!active.length) return { status: "NA", reason: "Komponen pada fase ini dipenuhi dari stok/pasokan; tidak ada produksi baru." };
  if (active.some(({ net }) => !iso(net.leadTime?.startDate) || !iso(net.leadTime?.endDate) || !net.leadTime?.scheduleSources?.some(source => ["OR_TOOLS_WASM_CP_SAT", "OFFICIAL_MRP"].includes(source)))) return { status: "UNKNOWN", reason: "Tanggal mulai/selesai produksi komponen belum tersedia dari jadwal MRP pada fase ini." };
  if (active.some(({ net }) => new Date(net.leadTime.endDate) < new Date(net.leadTime.startDate))) return { status: "BLOCKER", reason: "Tanggal selesai produksi komponen mendahului tanggal mulai." };
  return { status: "OK", start: active.map(({ net }) => iso(net.leadTime.startDate)).sort()[0], end: active.map(({ net }) => iso(net.leadTime.endDate)).sort().at(-1), reason: "Tanggal produksi dari jadwal komponen MRP pada fase yang sama." };
}

// Schema effectivity is inclusive; null bounds are unbounded, matching the
// existing selectAuthoritativeMbom contract. Compare in the plant date zone.
function effectivity(header, window) {
  if (window.status !== "OK") return window;
  const start = day(window.start), end = day(window.end), from = day(header.effectiveDate), until = day(header.expiryDate);
  if ((header.effectiveDate && !from) || (header.expiryDate && !until) || (from && until && from > until)) return { status: "BLOCKER", reason: "Rentang berlaku BOM tidak valid." };
  const valid = (!from || from <= start) && (!until || until >= end);
  return { status: valid ? "OK" : "BLOCKER", reason: valid ? "BOM berlaku sepanjang tanggal produksi fase ini." : `Produksi ${start}–${end} berada di luar masa berlaku BOM ${from || "tanpa batas awal"}–${until || "tanpa batas akhir"}.`, start, end };
}

function evaluateBomReadiness(workbench, details, headers, machines = [], dies = []) {
  const checks = [], items = workbench.items || [];
  const runAt = iso(workbench.mrp?.createdAt);
  const sourceDates = [workbench.mps?.updatedAt, ...headers.flatMap(h => [h.updatedAt, ...(h.details || []).flatMap(row => [row.updatedAt, ...(row.mbomProcesses || []).flatMap(p => [p.updatedAt, ...(p.routingOperation ? [p.routingOperation.updatedAt, p.routingOperation.routingHeader?.updatedAt] : [])])])])];
  const current = workbench.mrp?.isCurrentPlan === true && !workbench.mps?.replanRequired && workbench.mrp?.mpsNumber === workbench.mps?.mpsNumber && Boolean(runAt) && sourceDates.every(date => iso(date) && iso(date) <= runAt);
  const freshness = { ready: current, reason: !workbench.mrp ? "Belum ada hasil MRP untuk MPS ini." : workbench.mps?.replanRequired ? (workbench.mps.replanReason || "MPS berubah setelah perhitungan; rencana perlu dihitung ulang.") : !workbench.mrp.isCurrentPlan ? `${workbench.mrp.runNumber || "Hasil MRP"} belum ditetapkan sebagai rencana MRP terkini (status: ${workbench.mrp.status || "belum tersedia"}).` : workbench.mrp.mpsNumber !== workbench.mps?.mpsNumber ? "Hasil MRP berasal dari nomor MPS yang berbeda." : "Data BOM/routing/MPS berubah setelah MRP dihitung, atau waktu pembaruannya belum tersedia." };
  const pendingMrp = !workbench.mps?.replanRequired && workbench.mrp?.runNumber && !workbench.mrp.isCurrentPlan;
  const dateAction = pendingMrp ? `Buka ${workbench.mrp.runNumber}, tinjau hasil dan selesaikan workflow persetujuan MRP untuk menetapkan rencana terkini. Jika sumber berubah, hitung revisi baru sebelum persetujuan.` : "Hitung ulang MPS/MRP agar fase ini memiliki tanggal produksi komponen terkini; tanggal delivery tidak dipakai sebagai pengganti.";
  const dateRoute = pendingMrp ? `/modules/planning-ppic/mrp/${encodeURIComponent(workbench.mrp.runNumber)}` : mpsRoute;
  for (const item of items) {
    const detail = details.find(row => row.id === item.id), root = detail?.mbom;
    const phases = [...(item.phases || []), ...(item.bufferPhase ? [item.bufferPhase] : [])];
    const add = (field, status, actual, requirement, recommendation, extra = {}) => checks.push({
      code: "BOM_INPUT_DIAGNOSTIC", category: "BOM_ROUTING_LOT", partCode: item.partCode, field, status, actual, requirement,
      owner: "Engineering", route: root ? bomRoute(root.noReg) : mpsRoute, document: root?.noReg,
      reason: `${item.partCode}: ${field} — ${status === "OK" ? "sesuai" : requirement}`,
      recommendation: status === "OK" ? "Tidak perlu perubahan untuk pemeriksaan ini." : recommendation,
      ...extra,
    });
    const total = numeric(item.planMetrics?.totalPlanQty);
    if (total === 0 && phases.every(p => numeric(p.plannedProductionQty) === 0)) {
      add("Kebutuhan BOM produksi", "NA", 0, "Tidak ada produksi baru pada MPS ini.", "Tidak perlu validasi BOM untuk pemenuhan dari stok."); continue;
    }
    const validQty = qty => numeric(qty) != null && Number(qty) >= 0 && (!discrete(item.uomCode) || Math.abs(Number(qty) - Math.round(Number(qty))) < EPS);
    add("Satuan batch MPS", item.uomCode ? "OK" : "BLOCKER", item.uomCode, "Batch MPS perlu satuan yang jelas.", "Lengkapi satuan produksi pada MPS.", { owner: "PPIC", route: mpsRoute });
    for (const [index, phase] of phases.entries()) {
      add("Qty batch produksi", validQty(phase.plannedProductionQty) ? "OK" : "BLOCKER", phase.plannedProductionQty,
        `Qty harus non-negatif${discrete(item.uomCode) ? " dan bulat dalam satuan " + item.uomCode : ""}.`, "Perbaiki qty fase pada MPS; qty manual tidak harus kelipatan 1.000.",
        { owner: "PPIC", route: mpsRoute, phaseId: phase.id, deliveryTargetId: phase.deliveryTargetId || null, phaseLabel: phase.rowType === "BUFFER" || phase === item.bufferPhase ? "Buffer akhir bulan" : `Delivery ${index + 1} · ${day(phase.targetDeliveryDate) || "tanggal belum diisi"}` });
    }
    const sum = phases.every(p => numeric(p.plannedProductionQty) != null) ? phases.reduce((n, p) => n + Number(p.plannedProductionQty), 0) : null;
    add("Total batch termasuk buffer", total != null && sum != null && validQty(total) && Math.abs(sum - total) < EPS ? "OK" : "BLOCKER", sum,
      `Total batch harus sama dengan qty MPS ${total ?? "belum tersedia"} ${item.uomCode || ""}.`, "Sesuaikan pembagian fase dan buffer agar sama dengan total rencana MPS.", { owner: "PPIC", route: mpsRoute });
    if (!root || root.isDeleted) continue; // Basic diagnostics already identify the missing selected revision.
    if (detail.partId && root.partId !== detail.partId) add("Produk pada revisi BOM", "BLOCKER", root.noReg, "BOM harus milik part pada detail MPS.", "Pilih BOM untuk part MPS yang sesuai.", { owner: "PPIC", route: mpsRoute });
    const usedNos = new Set([root.noReg]);
    for (const component of item.components || []) {
      for (const header of headers) if ((header.details || []).some(row => row.id === component.id || (row.mbomProcesses || []).some(p => (component.processes || []).some(cp => cp.id === p.id)))) usedNos.add(header.noReg);
    }
    const used = headers.filter(header => usedNos.has(header.noReg));
    if (!used.some(h => h.id === root.id)) used.push(root);
    const visited = new Set();
    function inspect(header, path = new Set()) {
      if (path.has(header.id)) { add("Referensi BOM turunan", "BLOCKER", header.noReg, "Referensi BOM tidak boleh membentuk siklus.", "Perbaiki referensi komponen yang kembali ke BOM induk.", { document: header.noReg, route: bomRoute(header.noReg) }); return; }
      if (visited.has(header.id)) return;
      visited.add(header.id); const next = new Set(path); next.add(header.id);
      if (header.isDeleted) { add("BOM terhapus", "BLOCKER", header.noReg, "Revisi BOM yang dipakai harus tersedia.", "Pilih revisi yang tersedia dan hitung ulang MPS/MRP.", { document: header.noReg, route: bomRoute(header.noReg) }); return; }
      const rows = (header.details || []).filter(row => !row.isDeleted);
      const graph = validateBomGraphStructure(header);
      add("Struktur dan urutan routing", graph.valid ? "OK" : "BLOCKER", graph.valid ? `${rows.length} komponen; urutan proses unik per komponen` : graph.errors.map(e => e.message).join(" "), "Parent komponen, qty, unit dan urutan proses harus valid.", graph.errors.map(e => e.message).join(" "), { document: header.noReg, route: bomRoute(header.noReg) });
      for (const row of rows) {
        const component = row.part?.partCode || row.id, routes = (row.mbomProcesses || []).filter(p => !p.isDeleted);
        const info = { document: header.noReg, component, route: bomRoute(header.noReg) };
        const children = used.filter(h => h.id !== header.id && h.partId === row.partId);
        if (row.category === "inHouse" && !routes.length) {
          add("Routing komponen", children.length === 1 ? "OK" : "BLOCKER", children.length ? children.map(h => h.noReg).join(", ") : "Tidak ada proses atau BOM turunan dalam rencana", "Komponen in-house perlu proses atau satu BOM turunan yang digunakan rencana.", "Lengkapi proses/BOM turunan untuk komponen ini, lalu hitung ulang MPS dan MRP.", info);
          if (children.length === 1) inspect(children[0], next);
        }
        if (row.category === "Vendor") add("Routing vendor", routes.some(p => p.routingMode === "VENDOR") ? "OK" : "BLOCKER", routes.length, "Komponen vendor memerlukan proses dengan pelaksana vendor.", "Tambahkan proses vendor pada komponen ini.", info);
        if (row.part?.rawType === "MATERIAL" && row.category === "Purchase") {
          const cavity = row.materialScheme === "ALTERNATIVE" ? row.alternateMaterialCavity : row.materialCavity;
          add("Cavity material", Number.isInteger(cavity) && cavity > 0 ? "OK" : "BLOCKER", cavity, "Cavity skema material aktif harus bilangan bulat lebih dari 0.", "Isi cavity material pada skema aktif BOM; ini dipakai untuk berat/kebutuhan material, bukan membagi lagi cycle time detik/pcs.", info);
        }
        add("Scrap allowance material", numeric(row.scrapFactor) != null && Number(row.scrapFactor) >= 0 ? "OK" : "BLOCKER", row.scrapFactor, "Scrap allowance harus angka non-negatif.", "Perbaiki scrap allowance pada komponen BOM. Scrap material berbeda dari yield hasil proses.", info);
        for (const route of routes) {
          const process = route.process?.processName || route.process?.processCode || route.id;
          const ri = { ...info, process, processId: route.id, route: bomRoute(header.noReg) + "/processes" };
          if (route.routingMode !== "VENDOR") {
            const policy = resolveRoutingMachinePolicy({ ...route, mbomDetail: row }, machines, dies);
            add("Mesin dan tooling routing", policy.errors.length ? "BLOCKER" : "OK", policy.resources.map(r => machines.find(m => m.id === r.machineId)?.machineCode || r.machineId).join(", ") || "Belum dipilih", "Mesin aktif, qualified, dan tooling sesuai routing.", policy.errors.join(" "), ri);
            add("Basis cycle time", "OK", "Detik per pcs", "Cycle time per pcs tidak dibagi cavity lagi.", "", ri);
          }
          const operation = route.routingOperation, y = numeric(operation?.yieldPercent);
          const validLink = operation && operation.isActive && operation.routingHeader?.status === "ACTIVE" && !operation.routingHeader.isDeleted && operation.routingHeader.partId === row.partId && operation.processId === route.processId && operation.isSubcontract === (route.routingMode === "VENDOR");
          add("Yield hasil proses (%)", !operation ? "UNKNOWN" : !validLink || y == null || y <= 0 || y > 100 ? "BLOCKER" : "OK", y,
            !operation ? "Proses BOM belum ditautkan ke operasi master yang memuat yield." : "Yield harus > 0 hingga 100% pada operasi aktif dengan part, proses, dan pelaksana yang sesuai.",
            !operation ? "Buka routing BOM, pilih operasi master untuk proses ini melalui tautan operasi routing. Isi Yield (%) pada master routing sesuai standar Engineering." : "Perbaiki operasi master/revisi routing dan tautannya pada BOM; jangan mengasumsikan yield 100% jika belum ditentukan.", ri);
          if (validLink && y > 0 && y < 100) {
            add("Allowance yield pada rencana", "UNKNOWN", `${y}%`, "Qty input per operasi harus membuktikan output baik setelah yield.", "Hitung qty input = ceil(qty hasil baik / (yield / 100)) per operasi dan sertakan bukti alokasinya pada rencana. Qty hasil baik pada batch bukan bukti qty input.", { ...ri, owner: "PPIC", route: mpsRoute });
          }
          if (validLink) {
            const componentCodes = new Set([component]);
            for (const [index, phase] of phases.entries()) {
              if (!(numeric(phase.plannedProductionQty) > EPS)) continue;
              const window = phaseWindow(item, phase, componentCodes, freshness);
              const result = effectivity({ effectiveDate: operation.routingHeader.effectiveFrom, expiryDate: operation.routingHeader.effectiveUntil }, window);
              add("Master operasi berlaku pada fase", result.status, window.start ? `${day(window.start)} – ${day(window.end)}` : null,
                result.reason.replaceAll("BOM", "master operasi"), "Gunakan revisi master operasi yang berlaku pada tanggal produksi; hitung ulang rencana setelah perbaikan.",
                { ...ri, phaseId: phase.id, deliveryTargetId: phase.deliveryTargetId || null, phaseLabel: phase === item.bufferPhase ? "Buffer akhir bulan" : `Delivery ${index + 1}` });
            }
          }
        }
      }
      const codes = header.id === root.id ? new Set((item.components || []).filter(production).map(c => c.partCode)) : new Set(rows.map(row => row.part?.partCode));
      for (const [index, phase] of phases.entries()) {
        if (!(numeric(phase.plannedProductionQty) > EPS)) continue;
        const window = phaseWindow(item, phase, codes, freshness), result = effectivity(header, window);
        add("BOM berlaku pada fase produksi", result.status, window.start ? `${day(window.start)} – ${day(window.end)}` : null, result.reason,
          result.status === "BLOCKER" ? "Pilih revisi BOM yang berlaku pada tanggal produksi, atau sesuaikan jadwal dan hitung ulang rencana." : dateAction,
          { document: header.noReg, route: result.status === "BLOCKER" ? bomRoute(header.noReg) : dateRoute, actionLabel: result.status === "BLOCKER" ? "Buka BOM terkait" : pendingMrp ? "Tinjau hasil MRP" : "Buka rencana MPS", owner: "PPIC", phaseId: phase.id, deliveryTargetId: phase.deliveryTargetId || null, phaseLabel: phase === item.bufferPhase ? "Buffer akhir bulan" : `Delivery ${index + 1} · ${day(phase.targetDeliveryDate) || "tanggal belum diisi"}`, effectiveFrom: day(header.effectiveDate), effectiveUntil: day(header.expiryDate), basis: "Tanggal produksi komponen MRP pada fase yang sama" });
      }
    }
    inspect(root);
    // Expanded MRP may include another branch that is not a direct child of the root.
    for (const header of used) if (!visited.has(header.id)) inspect(header);
  }
  return checks;
}

const headerInclude = { details: { where: { isDeleted: false }, include: { part: true, mbomProcesses: { where: { isDeleted: false }, include: { process: true, machine: true, vendor: true, routingOperation: { include: { routingHeader: true } } } } } } };
async function loadBomReadiness(tx, workbench, machines, dies) {
  const items = workbench.items || [];
  const details = await tx.mPSDetail.findMany({ where: { id: { in: items.map(item => item.id) } }, select: { id: true, partId: true, mbom: { include: headerInclude } } });
  const componentRefs = await tx.mBOMDetail.findMany({ where: { id: { in: [...new Set(items.flatMap(item => (item.components || []).map(row => row.id)))] } }, select: { noReg: true } });
  const processRefs = await tx.mBOMProcess.findMany({ where: { id: { in: [...new Set(items.flatMap(item => (item.components || []).flatMap(row => (row.processes || []).map(p => p.id))))] } }, select: { noReg: true } });
  const rootNos = new Set(details.map(row => row.mbom?.noReg).filter(Boolean));
  const nested = await tx.mBOMHeader.findMany({ where: { noReg: { in: [...new Set([...componentRefs, ...processRefs].map(row => row.noReg))].filter(no => !rootNos.has(no)) } }, include: headerInclude });
  const headers = [...details.map(row => row.mbom).filter(Boolean), ...nested];
  return { details, checks: evaluateBomReadiness(workbench, details, headers, machines, dies) };
}
module.exports = { evaluateBomReadiness, loadBomReadiness, phaseWindow, effectivity };
