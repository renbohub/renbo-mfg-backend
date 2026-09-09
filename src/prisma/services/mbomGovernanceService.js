const { validateBomGraphStructure } = require('./planning/solver/bomGraphValidationService');
const { resolveRoutingMachinePolicy } = require('./planning/routingMachinePolicy');
const { resolveRoutingExecutionPolicy } = require('./planning/routingExecutionPolicy');
const { calculateLiveMbomCosts } = require('./mbomLiveCostingService');
const { businessNow } = require('../utils/businessClock');
const { latestBomHeaderIds } = require('../utils/latestBomHeaders');

const released = { notIn: ['Draft', 'Planned', 'Cancelled', 'Canceled'] };
const usedWork = { OR: [{ status: released }, { startTime: { not: null } }, { qtyProduced: { gt: 0 } }, { productionLogs: { some: { isDeleted: false } } }] };

async function productionRevisionPolicy(db, header) {
  // Follow exact revision/routing references, never all production of the same part.
  const workSource = { OR: [{ mbomDetail: { is: { noReg: header.noReg } } }, { mbomProcess: { is: { noReg: header.noReg } } }] };
  const scheduleSource = { mbomProcess: { is: { noReg: header.noReg } } };
  const orders = await db.plannedOrder.findMany({ where: { mbomHeaderId: header.id }, select: { orderNumber: true } });
  const orderNumbers = orders.map(row => row.orderNumber);
  const moSource = { OR: [
    { plannedOrderNumber: { in: orderNumbers } }, { sourcePlannedOrderNumber: { in: orderNumbers } },
    { workOrders: { some: workSource } },
  ] };
  const [workOrders, schedules, vendorOrders, manufacturingOrders, family] = await Promise.all([
    db.workOrder.count({ where: { AND: [workSource, usedWork] } }),
    db.dailyProductionSchedule.count({ where: { AND: [scheduleSource, { OR: [{ status: released }, { actualQty: { gt: 0 } }, { productionLogs: { some: { isDeleted: false } } }] }] } }),
    db.vendorProcessOrder.count({ where: { AND: [
      { OR: [{ mbomHeaderId: header.id }, { mbomNoReg: header.noReg },
        { mbomDetailId: { in: (header.details || []).map(row => row.id) } },
        { mbomProcessId: { in: (header.details || []).flatMap(row => (row.mbomProcesses || []).map(route => route.id)) } },
      ] },
      { OR: [{ status: released }, { qtySent: { gt: 0 } }, { sentAt: { not: null } }] },
    ] } }),
    db.manufacturingOrder.count({ where: { AND: [moSource, { OR: [{ status: released }, { actualStartDate: { not: null } }, { qtyProduced: { gt: 0 } }, { productionLogs: { some: { isDeleted: false } } }] }] } }),
    db.mBOMHeader.findMany({ where: { isDeleted: false, ...(header.partId ? { partId: header.partId } : { id: header.id }) }, select: { id: true, partId: true, noReg: true, revision: true, createdAt: true, expiryDate: true } }),
  ]);
  const latestId = latestBomHeaderIds(family)[0];
  const latest = family.find(row => row.id === latestId);
  const usedInProduction = workOrders + schedules + vendorOrders + manufacturingOrders > 0;
  const suggested = new Date(Math.max(businessNow().getTime(), header.effectiveDate ? new Date(header.effectiveDate).getTime() + 86400000 : 0));
  return {
    usedInProduction, mode: usedInProduction ? 'newRevision' : 'correction',
    isLatest: !latest || latest.id === header.id, latestNoReg: latest?.noReg || header.noReg,
    nextRevision: Number(latest?.revision || header.revision || 1) + 1,
    nextEffectiveDate: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' }).format(suggested),
    usage: { workOrders, schedules, vendorOrders, manufacturingOrders },
    reason: usedInProduction ? 'Sudah dipakai produksi. Perubahan disimpan sebagai revisi baru.' : 'Belum dipakai produksi. Perubahan disimpan pada BOM dan revisi yang sama.',
  };
}

function bomCompleteness(header, context, visiting = new Set()) {
  const issues = [];
  const add = (group, message, partCode = null) => issues.push({ group, message, partCode });
  if (visiting.has(header.id)) return { complete: false, status: 'INCOMPLETE', issues: [{ group: 'Struktur', message: 'Referensi BOM turunan membentuk siklus.' }], issueCount: 1 };
  const next = new Set(visiting); next.add(header.id);
  if (!header.partId || !header.part || header.part.isDeleted) add('Produk', 'Produk utama belum dipilih atau sudah dihapus.');
  if (!header.uomCode) add('Produk', 'UOM produk utama belum diisi.');
  const details = (header.details || []).filter(row => !row.isDeleted);
  if (!details.length) add('Struktur', 'BOM belum memiliki komponen.');
  const graph = validateBomGraphStructure(header);
  graph.errors.forEach(issue => add('Struktur', issue.message));
  for (const row of details) {
    const code = row.part?.partCode || 'Komponen';
    const routes = (row.mbomProcesses || []).filter(p => !p.isDeleted);
    if (!row.part || row.part.isDeleted) add('Komponen', 'Master part tidak tersedia.', code);
    if (!['inHouse', 'Purchase', 'Vendor'].includes(row.category)) add('Komponen', 'Kategori produksi/pembelian belum valid.', code);
    const linked = (row.part?.mbomHeaders || []).find(bom => bom.noReg !== header.noReg && !bom.isDeleted);
    if (linked) {
      const child = context.headers.get(linked.id);
      if (!child) add('BOM Turunan', `BOM ${linked.noReg} tidak tersedia.`, code);
      else {
        const childStatus = bomCompleteness(child, context, next);
        if (!childStatus.complete) add('BOM Turunan', `${linked.noReg}: ${childStatus.issueCount} data perlu dilengkapi.`, code);
      }
    }
    if (row.category === 'Purchase') {
      const supplied = row.materialSupplyType === 'CUSTOMER_SUPPLIED';
      const supplier = row.supplierId ? row.supplier : row.part?.supplier;
      if (supplied ? !row.supplyCustomerId || row.supplyCustomer?.isDeleted || row.supplyCustomer?.status === 'Inactive' : !(row.supplierId || row.part?.supplierId) || supplier?.isDeleted || supplier?.status === 'Inactive') add('Partner', supplied ? 'Customer pemilik material belum valid.' : 'Supplier default belum valid.', code);
      if (row.part?.rawType === 'MATERIAL') {
        if (!row.part.materialId || !row.part.material || row.part.material.isDeleted) add('Material', 'Hubungkan part ke master material.', code);
        const alt = row.materialScheme === 'ALTERNATIVE';
        if (!(alt ? row.alternateMaterialFormId : row.materialFormId)) add('Material', 'Bentuk material untuk skema aktif belum dipilih.', code);
        if (!(Number(alt ? row.alternateMaterialPitch : row.materialPitch) > 0) || !(Number(alt ? row.alternateMaterialCavity : row.materialCavity) > 0) || !(Number(row.grossWeight) > 0)) add('Material', 'Pitch, cavity, dan gross weight skema aktif harus lebih dari nol.', code);
      }
    }
    if (row.category === 'inHouse' && !routes.length && !linked) add('Routing', 'Proses in-house belum diisi.', code);
    if (row.category === 'Vendor' && !routes.some(p => p.routingMode === 'VENDOR')) add('Routing', 'Routing proses vendor belum diisi.', code);
    for (const route of routes) {
      if (!route.processId || !route.process || route.process.isDeleted) add('Routing', 'Master proses belum valid.', code);
      if (route.machinePlanningPolicy?.execution !== undefined) {
        const execution = resolveRoutingExecutionPolicy({ ...route, mbomDetail: { partId: row.partId } }, context);
        execution.errors.forEach(message => add('Pelaksana Alternatif', message, code));
      }
      if (route.routingMode === 'VENDOR') {
        if (!route.vendorId || !route.vendor || route.vendor.isDeleted || route.vendor.status === 'Inactive') add('Vendor', 'Vendor pelaksana belum valid.', code);
        const assignment = context.vendorAssignments.find(a => a.vendorId === route.vendorId && !a.vendorProcess?.isDeleted && a.vendorProcess?.vendorProcessCode === route.process?.processCode);
        if (!assignment) add('Vendor', `Vendor belum terdaftar untuk proses ${route.process?.processCode || ''}.`, code);
      } else {
        const policy = resolveRoutingMachinePolicy({ ...route, mbomDetail: { partId: row.partId } }, context.machines, context.dies);
        policy.errors.forEach(message => add('Mesin & Tooling', message, code));
      }
    }
  }
  const cost = context.costs.get(header.id);
  if (cost && cost.covered < cost.lines) add('Harga', `${cost.lines - cost.covered} harga material/purchase part atau rate proses belum tersedia pada tanggal pemeriksaan.`);
  const unique = [...new Map(issues.map(issue => [JSON.stringify(issue), issue])).values()];
  return { complete: unique.length === 0, status: unique.length ? 'INCOMPLETE' : 'COMPLETE', label: unique.length ? 'Belum lengkap' : 'Lengkap', issueCount: unique.length, issues: unique, checkedAt: businessNow().toISOString() };
}

async function attachBomCompleteness(db, headers, include) {
  if (!headers.length) return headers;
  const [machines, dies, costs, vendorAssignments, vendors] = await Promise.all([
    db.machine.findMany({ where: { isDeleted: false } }),
    db.dies.findMany({ where: { isDeleted: false }, include: { diesParts: true } }),
    calculateLiveMbomCosts(db, { costingDate: businessNow() }),
    db.entityVendorProcess.findMany({ where: { entityType: 'vendor' }, include: { vendorProcess: true } }),
    db.vendor.findMany({ where: { isDeleted: false } }),
  ]);
  const context = { machines, dies, costs, vendorAssignments, vendors, headers: new Map(headers.map(h => [h.id, h])) };
  const attempted = new Set(context.headers.keys());
  let frontier = headers;
  while (frontier.length) {
    const ids = [...new Set(frontier.flatMap(h => (h.details || []).flatMap(r => (r.part?.mbomHeaders || []).filter(b => b.noReg !== h.noReg && !attempted.has(b.id)).map(b => b.id))))];
    if (!ids.length) break;
    ids.forEach(id => attempted.add(id));
    frontier = await db.mBOMHeader.findMany({ where: { id: { in: ids }, isDeleted: false }, include });
    frontier.forEach(h => context.headers.set(h.id, h));
  }
  return headers.map(header => ({ ...header, completeness: bomCompleteness(header, context) }));
}

module.exports = { productionRevisionPolicy, bomCompleteness, attachBomCompleteness };
