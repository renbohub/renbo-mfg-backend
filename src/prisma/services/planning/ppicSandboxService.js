"use strict";
const { createHash } = require("node:crypto");
const { atomic } = require("./planningTransactionContext");
const integrated = require("./integratedPlanService");
const { resolveRoutingMachinePolicy } = require("./routingMachinePolicy");
const { findActivePreset } = require("./capacitySimulationPresetService");
const { buildCapacityRuleIndex, withCapacityRuleIndex, shiftWindows } = require("./capacityRecommendationService");
const { businessNow } = require("../../utils/businessClock");
const DAY = 86400000;
const date = value => value ? new Date(value).toISOString().slice(0, 10) : null;
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const minute = value => { const [h, m] = String(value || "00:00").split(":").map(Number); return h * 60 + m; };
const wallMinute = value => { const d = new Date(value); return d.getTime() / 60000 + 420; };
function firmGate(row) {
  let remaining = Math.max(0, Math.min(Number(row.firmSupplyQty || 0), Number(row.grossRequirement || 0) - Number(row.netRequirement || 0)));
  if (!remaining) return null;
  const receipts = (Array.isArray(row.supplyTimeline) ? row.supplyTimeline : []).filter(s => /FIRM|CONFIRMED|RELEASED|RECEIVED/i.test(`${s.status || ""} ${s.confidence || s.supplyClass || ""}`)).map(s=>({qty:Number(s.qty||0),date:date(s.availableDate||s.receiptDate||s.date)})).filter(s=>s.date&&s.qty>0).sort((a,b)=>a.date.localeCompare(b.date));
  let ready = null;
  for (const receipt of receipts) { ready=receipt.date;remaining-=receipt.qty;if(remaining<=1e-6)break; }
  return ready;
}

// Build the occurrence graph inside the preview transaction: temporary MRP IDs
// must never be re-read after rollback. Stable IDs use source pegging + tree path.
function buildGraph(requirements, routes, policies, baseline = [], materialUnits = {}, materialNetting = {}) {
  const byId = new Map(requirements.map(r => [r.id, r]));
  const children = new Map();
  requirements.forEach(r => { if (r.parentRequirementId) { const list = children.get(r.parentRequirementId) || []; list.push(r); children.set(r.parentRequirementId, list); } });
  const routeMap = new Map();
  routes.forEach(r => { const list = routeMap.get(r.mbomDetailId) || []; list.push(r); routeMap.set(r.mbomDetailId, list); });
  const nodes = [], groups = [], issues = [];
  const walk = (r, group, ancestry = new Set()) => {
    if (ancestry.has(r.id)) throw Object.assign(new Error("Siklus ditemukan pada BOM."), { statusCode: 422 });
    const next = new Set(ancestry); next.add(r.id);
    const key = digest([group.id, r.treePath || r.mbomDetailId || r.id]).slice(0, 24);
    const base = { groupId: group.id, partCode: r.partCode, partName: r.part?.partName || r.part?.partNumber || r.partCode, qty: Math.max(0, Number(r.netRequirement)), grossQty: Number(r.grossRequirement), uom: materialUnits[r.id] || r.mbomDetail?.uomCode || r.part?.baseUomCode || r.part?.stockUomCode || "pcs", treePath: r.treePath, dependencies: [], issues: [] };
    if (r.orderType === "Purchase") {
      const id = `material-${key}`;
      base.materialPoolId = materialNetting.requirementPools?.[r.id];
      const timeline = Array.isArray(r.supplyTimeline) ? r.supplyTimeline : [];
      nodes.push({ ...base, id, kind: "material", title: r.part?.partName || r.partCode, leadDays: Math.max(0, Number(r.leadTime)), leadBasis: "calendar", onHandQty: Number(r.onHandQty), firmSupplyQty: Number(r.firmSupplyQty), supplyTimeline: timeline, availableDate: null, firmAvailableDate: firmGate(r), ownership: r.materialSupplyType, owner: r.supplyCustomerCode || r.mbomDetail?.supplier?.supplierCode || "", sourceRequiredDate: date(r.materialRequiredDate || r.requiredDate), sourceOrderDate: date(r.latestPrDate || r.orderDate) });
      return [id];
    }
    // A fully covered subassembly consumes neither child stock nor machine time.
    let dependencies = base.qty > 0 ? (children.get(r.id) || []).flatMap(child => walk(child, group, next)) : [];
    if (base.qty <= 0) {
      const id=`stock-${key}`;
      nodes.push({...base,id,kind:"material",title:"Stok / suplai komponen",coverageOnly:true,leadDays:0,leadBasis:"calendar",onHandQty:Number(r.onHandQty),firmSupplyQty:Number(r.firmSupplyQty),firmAvailableDate:firmGate(r),availableDate:null,ownership:"INVENTORY",owner:"Stok komponen"});
      dependencies=[id];
    }
    const ops = (routeMap.get(r.mbomDetailId) || []).filter(p => !p.isDeleted).sort((a,b) => a.sequence-b.sequence || a.id.localeCompare(b.id));
    if (base.qty > 0) ops.forEach((op, index) => {
      const policy = policies.get(op.id), vendor = op.routingMode === "VENDOR";
      const candidates = policy?.resources || [];
      const allocation = baseline.find(a => a.mbomProcessId === op.id && (a.deliveryPhaseId === r.deliveryTargetId || date(a.customerTargetDate) === group.deliveryDate));
      const selected = candidates.some(m => m.machineId === allocation?.machineId) ? allocation.machineId : policy?.primaryMachineId;
      const machine = candidates.find(m => m.machineId === selected);
      const problems = vendor ? (!op.vendorId ? ["Vendor belum dipilih."] : []) : (policy?.errors || []).map(e => typeof e === "string" ? e : e.message || e.code || "Kebijakan mesin belum lengkap.");
      const id = `process-${key}-${index}`;
      nodes.push({ ...base, id, kind: vendor ? "vendor" : "process", title: op.process?.processName || op.occurrenceCode || "Proses", processCode: op.occurrenceCode || op.process?.processCode, routeId: op.id, sequence: op.sequence, dependencies, machineId: selected || "", machineOptions: candidates, diesId: machine?.diesId || op.diesId || null, cycleSeconds: Number(op.routingOperation?.cycleSeconds || machine?.cycleTimeSeconds || op.cycleTime), efficiency: 0.8, downtime: { coil: 0, dies: 0, rest: 0, setup: Number(machine?.setupMinutes || 0), briefing: 0 }, transitionMinutes: 0, vendorId: op.vendorId || "", leadDays: vendor ? Math.max(1, Number(op.vendor?.leadTimeDays ?? 0)) : 0, leadBasis: "calendar", baselineStart: allocation ? date(allocation.scheduleDate) : null, issues: problems });
      dependencies = [id];
    });
    if (base.qty > 0 && !ops.length && !(children.get(r.id) || []).length) {
      issues.push(`${r.partCode}: BOM/proses belum tersedia.`);
      const id=`missing-${key}`;
      nodes.push({...base,id,kind:"process",title:"Routing belum tersedia",cycleSeconds:0,efficiency:.8,downtime:{coil:0,dies:0,rest:0,setup:0,briefing:0},transitionMinutes:0,machineId:"",machineOptions:[],dependencies:[],issues:["BOM/proses belum tersedia."]});
      dependencies=[id];
    }
    if (r.id === group.sourceId) {
      nodes.push({ ...base, id: `fg-${group.id}`, kind: "fg", title: `FG · ${r.partCode}`, dependencies, targetDate: group.targetDate, deliveryDate: group.deliveryDate });
      return [`fg-${group.id}`];
    }
    return dependencies;
  };
  requirements.filter(r => !r.parentRequirementId && (Number(r.grossRequirement) > 0 || Number(r.netRequirement) > 0)).forEach(r => {
    const id = digest([r.deliveryTargetId, r.mpsDetailId, r.partCode, r.customerCode, r.treePath]).slice(0, 24);
    const group = { id, sourceId: r.id, partCode: r.partCode, partName: r.part?.partName || r.part?.partNumber || r.partCode, customer: r.customerCode || "Buffer", qty: Number(r.netRequirement), demandQty: Number(r.grossRequirement), bufferQty: Number(r.bufferQty||0), targetDate: date(r.requiredDate), deliveryDate: date(r.targetDeliveryDate || r.requiredDate) };
    groups.push(group); walk(r, group); delete group.sourceId;
    const demand=(Array.isArray(r.customerPegging)?r.customerPegging:[]).reduce((sum,p)=>sum+Number(p.qty||0),0);
    group.roundingQty=Number(String(r.notes||"").match(/\[MPS-ROUNDING:([\d.]+)\]/)?.[1]||0);
    group.customerProductionQty=Math.max(0,group.qty-group.bufferQty-group.roundingQty);
    group.deliveryDemandQty=r.rootDemandSourceType==="BUFFER"?0:demand||group.customerProductionQty;
    group.stockCoveredQty=Math.max(0,group.deliveryDemandQty-group.customerProductionQty);
    const split = require("./ppicPhaseBuffer").readSplitMetadata(r.notes);
    if (split) {
      Object.assign(group, split);
      if (group.isRemainder) { group.customer = "Sisa pembagian"; group.deliveryDemandQty = 0; }
      group.initialQty = group.qty;
    }
  });
  // Prepare the complete material kit before any first operation for this FG.
  // Shared purchased items remain distinct pegged occurrences with netted qty.
  const nodeById = new Map(nodes.map(n=>[n.id,n]));
  for(const group of groups){
    const members=nodes.filter(n=>n.groupId===group.id),materials=members.filter(n=>n.kind==="material").map(n=>n.id);
    for(const n of members) if(["process","vendor"].includes(n.kind) && n.dependencies.every(id=>nodeById.get(id)?.kind==="material")) n.dependencies=[...new Set([...n.dependencies,...materials])];
  }
  for (const r of requirements) if (r.parentRequirementId && !byId.has(r.parentRequirementId)) issues.push(`${r.partCode}: induk kebutuhan material tidak ditemukan.`);
  return { nodes, groups, issues: [...new Set(issues)] };
}

async function seed(prisma, { mpsNumber, user }) {
  const started = Date.now();
  return atomic(prisma, async tx => {
    const preview = await integrated.calculate(tx, { mpsNumber, user, options: integrated.normalizeOptions({}), preview: true, sandbox: true });
    const month = preview.month;
    const start = new Date(`${month}-01T00:00:00Z`); start.setUTCDate(start.getUTCDate() - 120);
    const end = new Date(`${month}-01T00:00:00Z`); end.setUTCMonth(end.getUTCMonth() + 4);
    const range = { gte: start, lt: end };
    const planNumbers = (preview.plans || []).map(p => p.planNumber);
    const [requirements, machines, dies, vendors, preset, overrides, planOverrides, baseline, external, downtime, events, daily] = await Promise.all([
      preview.mrpRunNumber ? tx.mRPRequirement.findMany({ where: { runNumber: preview.mrpRunNumber, isDeleted: false }, include: { part: true, mbomDetail: { include: { supplier: { select: { supplierCode: true } } } } }, orderBy: { treePath: "asc" } }) : [],
      tx.machine.findMany({ where: { isDeleted: false, status: "Active" }, include: { workingHourProfile: { include: { rules: true } }, workCenterMachines: { include: { workCenter: { include: { workingHourProfile: { include: { rules: true } } } } } } } }),
      tx.dies.findMany({ where: { isDeleted: false }, include: { diesParts: true } }),
      tx.vendor.findMany({ where: { isDeleted: false, status: "Active" }, select: { id: true, vendorCode: true, vendorName: true, leadTimeDays: true } }),
      findActivePreset(tx),
      tx.capacityCalendarOverride.findMany({ where: { isDeleted: false, scheduleDate: range } }),
      tx.capacityDayOverride.findMany({ where: { plan: { planNumber: { in: planNumbers } }, isDeleted: false, scheduleDate: range }, orderBy: { changedAt: "asc" } }),
      tx.productionPlanAllocation.findMany({ where: { plan: { planNumber: { in: planNumbers } }, isDeleted: false, status: { not: "Cancelled" }, planningMode: "PRODUCTION" } }),
      tx.productionPlanAllocation.findMany({ where: { plan: { planNumber: { notIn: planNumbers } }, isDeleted: false, status: { in: ["Draft", "Published"] }, planningMode: "PRODUCTION", scheduleDate: range, machineId: { not: null } } }),
      tx.downtimeLog.findMany({ where: { isDeleted: false, status: { not: "Cancelled" }, downtimeDate: range, machineCode: { not: null } } }),
      tx.machineAvailabilityEvent.findMany({ where: { isDeleted: false, status: { not: "CANCELLED" }, eventType: { not: "AVAILABLE" }, startedAt: { lt: end }, OR: [{ endedAt: null }, { endedAt: { gt: start } }] } }),
      tx.dailyProductionSchedule.findMany({ where: { isDeleted: false, productionPlanAllocationId: null, status: { in: ["Draft", "Released", "In Progress"] }, scheduleDate: range, machineId: { not: null } } }),
    ]);
    const routes = await tx.mBOMProcess.findMany({ where: { isDeleted: false, mbomDetailId: { in: [...new Set(requirements.map(r => r.mbomDetailId).filter(Boolean))] } }, include: { process: true, vendor: true, machine: true, routingOperation: true, mbomDetail: { include: { part: true } } } });
    const qualificationStart = new Date(`${month}-01T00:00:00Z`), qualificationEnd = new Date(qualificationStart); qualificationEnd.setUTCMonth(qualificationEnd.getUTCMonth()+1); qualificationEnd.setUTCDate(0);
    const policies = new Map(routes.map(r => [r.id, resolveRoutingMachinePolicy(r, machines, dies, { start: qualificationStart, end: qualificationEnd })]));
    const graph = buildGraph(requirements, routes, policies, baseline, Object.fromEntries((preview.materials || []).map(m=>[m.id,m.uomCode])), preview.sandboxMaterialNetting);
    const { windowsFor, closedDatesFor, workingCalendar } = require("./ppicSandboxCalendar").buildCalendar({machines,preset,overrides,planOverrides,start,end});
    const resources = machines.map(m => ({ id: m.id, code: m.machineCode, name: m.machineName, windows: windowsFor(m), closedDates: closedDatesFor(m), blocked: [], reservations: [], unavailable: [] }));
    const resourceById = new Map(resources.map(r => [r.id,r]));
    const block = (machineId, day, from, to) => {
      const r = resourceById.get(machineId); if (!r) return;
      const at = new Date(date(day)).getTime()/60000;
      if (!from || !to) { r.blocked.push([at,at+1440]); return; }
      const a=minute(from), b=minute(to); r.blocked.push([at+a,at+b+(b<=a?1440:0)]);
    };
    [...external,...daily].forEach(a=>block(a.machineId,a.scheduleDate,a.plannedStartTime,a.plannedEndTime));
    resources.forEach(r=>{r.reservations=[...r.blocked];r.blocked=[];});
    downtime.forEach(d=>block(machines.find(m=>m.machineCode===d.machineCode)?.id,d.downtimeDate,d.startTime,d.endTime));
    events.forEach(e=>resourceById.get(e.machineId)?.blocked.push([wallMinute(e.startedAt),e.endedAt?wallMinute(e.endedAt):end.getTime()/60000]));
    resources.forEach(r=>{r.unavailable=[...r.blocked];r.blocked=[...r.reservations,...r.unavailable];});
    const seed = { version: 1, month, mpsNumber: preview.mpsNumber, revision: preview.mpsRevision, sourceMode: preview.sourceMode, businessDate: new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(businessNow()), horizonStart: date(start), horizonEnd: date(end), ...graph, resources, vendors, initial: { engine: "CP-SAT", elapsedMs: Date.now()-started, materialTimingStatus: preview.materialTimingStatus, allocationCount: baseline.length, plans: (preview.plans || []).map(p=>({ planNumber: p.planNumber, ready: !!p.recommendation?.ready, error: p.recommendation?.error || null, preservedExecution: !!p.preservedExecution })), exceptions: (preview.exceptions || []).map(e=>e.reason).filter(Boolean) }, assumptions: ["Efisiensi awal 80%; batching = pembulatan ke atas durasi / 8 jam.", "Seluruh kuantitas satu proses selesai sebelum proses berikutnya; tidak ada transfer batch otomatis.", "Downtime per proses ditambah sekali per lot. Isi hanya downtime tambahan di luar penutupan kalender/kejadian mesin.", "Lead time awal memakai hari kalender; basis dapat diubah ke hari kerja Senin–Jumat.", "Jadwal dibulatkan ke menit; rumus tetap menampilkan detik. Spare di bawah 2 hari kalender diberi status risiko.", "Vendor diasumsikan menerima lot paralel; lead time mencakup antrean dan pengiriman vendor.", "Kuantitas net memakai snapshot MRP. Perubahan skenario tidak menjalankan netting stok atau menerbitkan PR/PO/MPP."] };
    seed.workingCalendar = workingCalendar;
    seed.materialNetting = { version: 1, pools: preview.sandboxMaterialNetting?.pools || [] };
    seed.assumptions[6] = "Netting material dialokasikan ulang menurut tanggal konsumsi proses setiap adjustment. Stok dan suplai dipakai sekali per material, pemilik, dan satuan; suplai belum firm tetap diberi risiko. Kuantitas produksi FG/WIP tetap dari snapshot MRP.";
    seed.netting=(preview.workbench?.items||[]).map(item=>({partCode:item.partCode,openingQty:item.metrics?.openingNettableQty,productionQty:item.metrics?.plannedProductionQty,bufferTargetQty:item.metrics?.targetEndingStockQty,phases:(item.phases||[]).map(p=>({targetDate:date(p.fgRequiredDate),deliveryDate:date(p.targetDeliveryDate),demandQty:Number(p.qty||0),stockCoveredQty:Number(p.stockUsedQty||0),productionQty:Number(p.customerProductionQty??p.plannedProductionQty??0)}))}));
    for (const row of seed.netting) {
      const groups = seed.groups.filter(group=>group.partCode===row.partCode);
      row.sourceProductionQty = row.productionQty;
      row.roundingQty = groups.reduce((sum,group)=>sum+Number(group.roundingQty||0),0);
      if (groups.length) row.productionQty = groups.reduce((sum,group)=>sum+group.qty,0);
    }
    seed.assumptions.push("Jumlah awal bulanan dibulatkan ke atas kelipatan 1.000 satu kali. Jumlah delivery menentukan banyak pembagian dasar; tiap pembagian memakai kelipatan 1.000 bila cukup, dan sisa menjadi pembagian tambahan. Semua jumlah dapat disesuaikan dalam skenario.");
    seed.assumptions.push("Pembagian produksi tidak mengubah jumlah dan tanggal delivery. Periksa pemenuhan delivery setelah adjustment; kebutuhan material mengikuti jumlah produksi skenario.","Semua material FG harus siap sebelum proses pertamanya. Bar menghubungkan rentang proses sepanjang hari kerja; jam beban aktual tetap mengikuti shift.");
    for (const n of seed.nodes) if (["vendor","material"].includes(n.kind)) n.leadBasis = "working";
    seed.assumptions[3] = "Seluruh proses dan lead time mengikuti working calendar. Hari libur dilewati; satu hari lead time memakai satu hari kerja sesuai jam kalender. Target FG/delivery tetap sebagai batas kebutuhan.";
    try { seed.initial.solver = await require("./ppicSandboxInitialSolver").initialize(seed); }
    catch(error) { seed.initial.solver = {status:"FAILED",feasible:false,error:error.message}; }
    seed.initial.elapsedMs = Date.now()-started;
    seed.initial.exceptions = [...new Set(seed.initial.exceptions)];
    seed.fingerprint = digest({ nodes: seed.nodes, groups: seed.groups, resources, vendors, workingCalendar, materialNetting: seed.materialNetting, businessDate: seed.businessDate });
    return seed;
  }, { preview: true, timeout: 180000 });
}
module.exports = { seed, buildGraph };
