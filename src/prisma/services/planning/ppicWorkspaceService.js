"use strict";
const d = require("./ppicWorkspaceDomain");
const { businessNow } = require("../../utils/businessClock");
const base = "/modules/planning-ppic";
const ownerRoutes = { Sales: "/modules/sales/sales-orders", Engineering: "/modules/manufacturing-bom/bill-of-materials", Inventory: "/modules/inventory/stock-balances", Purchasing: "/modules/purchasing/purchase-order", Production: "/modules/production/daily-production-schedules", QC: "/modules/qc/quality-inspections", PPIC: `${base}/mps/workbench` };
const maxDate = values => values.map(d.iso).filter(Boolean).sort().at(-1) || null;
async function sourceTimes(tx) {
  const models = { "bom-routing": ["mBOMHeader", "mBOMDetail", "mBOMProcess"], inventory: ["stockBalance", "stockReservation"], material: ["mRPRequirement", "purchaseOrder", "purchaseOrderDetail", "materialSupplySchedule"], resource: ["machine", "dies", "workingHourProfile", "workingHourRule", "capacityCalendarOverride", "machineAvailabilityEvent"], quality: ["qualityInspection", "incomingInspection", "deliverySchedule"], vendor: ["vendorProcessOrder", "vendor"] };
  const schema = require("@prisma/client").Prisma.dmmf.datamodel.models;
  const results = await Promise.all(Object.entries(models).map(async ([key, names]) => {
    const times = await Promise.all(names.map(async name => { const model = schema.find(row => row.name[0].toLowerCase() + row.name.slice(1) === name); const field = ["updatedAt", "createdAt"].find(field => model?.fields.some(row => row.name === field)); if (!field) return null; const value = await tx[name].aggregate({ _max: { [field]: true } }); return value._max[field]; }));
    return [key, maxDate(times)];
  }));
  return Object.fromEntries(results);
}

function projectDemand(calendar, targets, parts, customers, workbench, month) {
  const byTarget = new Map(targets.map(row => [row.id, row])), partByCode = new Map(parts.map(row => [row.partCode, row])), customerByCode = new Map(customers.map(row => [row.customerCode, row]));
  const phases = new Map();
  for (const item of workbench.items || []) for (const phase of item.phases || []) {
    if (!phase.deliveryTargetId) continue;
    const row = phases.get(phase.deliveryTargetId) || { stock: 0, production: 0, states: [], stockKnown: true, productionKnown: true };
    row.stockKnown &&= d.numeric(phase.stockUsedQty) != null;
    row.productionKnown &&= d.numeric(phase.customerProductionQty ?? phase.plannedProductionQty) != null;
    row.stock += d.numeric(phase.stockUsedQty) ?? 0;
    row.production += d.numeric(phase.customerProductionQty ?? phase.plannedProductionQty) ?? 0;
    row.states.push(d.state(phase.checklistSummary?.status)); phases.set(phase.deliveryTargetId, row);
  }
  const rows = new Map();
  for (const item of calendar.items || []) for (const split of item.effectiveDeliverySplits || []) {
    const dueAt = d.iso(split.targetDate);
    if (!dueAt?.startsWith(month)) continue;
    const target = byTarget.get(split.deliveryTargetId), id = split.deliveryTargetId;
    if (!id) continue;
    const qty = d.numeric(split.qty);
    if (qty == null || qty <= 0) continue;
    const row = rows.get(id) || { id, sourceType: split.sourceType, sourceNumber: split.sourceNumber || target?.sourceNumber || null, sourceLineId: split.sourceLineId || target?.sourceLineId || null, customerCode: item.customerCode || null, customerName: customerByCode.get(item.customerCode)?.customerName || item.customerCode || null, partCode: item.partCode, partName: partByCode.get(item.partCode)?.partName || item.partCode, dueAt, qty: 0, deliveredQty: 0, remainingQty: 0, uom: item.uomCode || target?.uomCode ? String(item.uomCode || target.uomCode).trim().toUpperCase() : null, firm: split.sourceType === "SALES_ORDER", consumedForecastQty: 0, allocatedStockQty: null, netNeedQty: null, status: "UNKNOWN", updatedAt: d.iso(target?.updatedAt), route: split.sourceType === "SALES_ORDER" ? `/modules/sales/sales-orders/${encodeURIComponent(split.sourceNumber || "")}` : `/modules/sales/forecasts`, progressBasis: split.progressBasis || "SOURCE_DEMAND", fgRequiredAt: d.iso(split.fgRequiredDate || item.fgRequiredDate) };
    row.duePrecision = "DATE";
    row.qty += qty;
    const delivered = d.numeric(split.deliveredQty), remaining = d.numeric(split.remainingQty);
    row.deliveredQty = row.deliveredQty == null || delivered == null ? null : row.deliveredQty + delivered;
    row.remainingQty = row.remainingQty == null || remaining == null ? null : row.remainingQty + remaining;
    if (delivered == null || remaining == null) row.progressReason = "Bukti quantity pengiriman atau outstanding belum tersedia pada sumber.";
    if (split.sourceType === "SALES_ORDER" && split.matchedForecastTargetId) row.consumedForecastQty += qty;
    rows.set(id, row);
  }
  for (const row of rows.values()) {
    const phase = phases.get(row.id);
    if (phase) {
      row.allocatedStockQty = phase.stockKnown && row.remainingQty != null ? Math.min(phase.stock, row.remainingQty) : null;
      row.netNeedQty = phase.productionKnown ? phase.production : null;
      row.status = d.worst(phase.states);
    }
    if (workbench.mps?.replanRequired) row.status = "UNKNOWN";
  }
  return [...rows.values()].sort((a, b) => a.dueAt.localeCompare(b.dueAt) || a.partCode.localeCompare(b.partCode) || a.id.localeCompare(b.id));
}

function projectReadiness(workbench, demand, routeRows, source, bomChecks = []) {
  const items = workbench.items || [], checks = items.flatMap(item => (item.feasibilityAssessment?.checks || item.scheduleFeasibility?.checks || []).map(check => ({ ...check, partCode: item.partCode })));
  checks.push(...bomChecks);
  const definitions = [
    { id: "bom-routing", label: "BOM, routing, lot & yield", owner: "Engineering", codes: ["BOM_INPUT_DIAGNOSTIC", "MASTER_DATA_READY", "ROUTING_SEQUENCE_VALID", "LOT_BATCH_YIELD_VALID"], source: "BOM efektif dan routing" },
    { id: "inventory", label: "Stok FG & alokasi", owner: "Inventory", codes: ["FG_COVERAGE_AT_DUE_DATE"], source: "StockBalance / StockReservation / dated netting" },
    { id: "material", label: "Material & incoming", owner: "Purchasing", codes: ["MPS_MATERIAL", "MATERIAL_READY_BY_START", "FIRM_SUPPLY_ON_TIME"], source: "Checksheet material MPS / MRP / qualified stock / eligible incoming" },
    { id: "resource", label: "Kapasitas RCCP", owner: "Production", codes: ["MPS_CAPACITY", "CAPACITY_AVAILABLE", "RESOURCE_CALENDAR_AVAILABLE"], source: "Checksheet kapasitas MPS / RCCP; validasi interval dan kompetensi operator tetap terpisah" },
    { id: "vendor-lead-time", label: "Lead time proses vendor", owner: "Purchasing", codes: ["MPS_VENDOR"], source: "Checksheet vendor MPS / lead time BOM / jadwal CP-SAT" },
    { id: "quality", label: "QC & kesiapan pengiriman", owner: "QC", codes: ["QUALITY_RELEASE_READY", "DELIVERY_SLOT_AVAILABLE"], source: "QC / dispatch / transport evidence" },
  ];
  const dataset = (definition, selected) => {
    const applicable = selected.filter(row => row.applicable !== false && d.state(row.status) !== "NA"), known = applicable.filter(row => ["OK", "CONDITIONAL", "BLOCKER"].includes(d.state(row.status)));
    const problems = selected.filter(row => !["OK", "NA"].includes(d.state(row.status))).sort((a, b) => (d.state(b.status) === "BLOCKER") - (d.state(a.status) === "BLOCKER"));
    const affected = new Set(problems.map(row => row.partCode));
    return { ...definition, codes: undefined, status: selected.length ? d.worst(selected.map(row => d.state(row.status))) : "UNKNOWN", owner: definition.owner, route: ownerRoutes[definition.owner], asOf: source.datasetUpdatedAt?.[definition.id === "vendor-lead-time" ? "vendor" : definition.id] || null, completeness: { complete: known.length, total: applicable.length, percent: applicable.length ? known.length / applicable.length * 100 : null }, affectedFgCount: selected.length ? affected.size : null, affectedDeliveryCount: selected.length ? demand.filter(row => problems.some(problem => problem.partCode === row.partCode && (problem.phaseId ? problem.deliveryTargetId === row.id : true))).length : null, issues: [...new Set(problems.map(row => row.reason).filter(Boolean))].slice(0, 12), evidence: selected.map(row => ({ ...row, code: row.code, partCode: row.partCode, status: d.state(row.status), reason: row.reason, actual: row.actual, requirement: row.requirement, gap: row.gap, evidence: row.evidence || [], evaluatedAt: row.evaluatedAt })) };
  };
  const validDemand = demand.filter(row => row.id && row.sourceLineId && row.dueAt && row.uom && row.customerCode), invalidDemand = demand.filter(row => !validDemand.includes(row));
  const rows = [{ id: "demand", label: "Demand & delivery customer", owner: "Sales", source: "DemandDeliveryTarget / forecast consumption", status: !demand.length ? "UNKNOWN" : invalidDemand.length ? "BLOCKER" : "OK", asOf: maxDate(demand.map(row => row.updatedAt)), completeness: { complete: validDemand.length, total: demand.length, percent: demand.length ? validDemand.length / demand.length * 100 : null }, affectedFgCount: new Set(invalidDemand.map(row => row.partCode)).size, affectedDeliveryCount: invalidDemand.length, issues: !demand.length ? ["Belum ada demand efektif pada periode ini."] : invalidDemand.length ? ["Sebagian delivery belum memiliki customer, satuan, tanggal, atau source line yang lengkap."] : [], route: `${base}/labs/demand-delivery` }, ...definitions.map(definition => dataset(definition, checks.filter(check => definition.codes.includes(check.code))))];
  const vendorParts = new Set(items.filter(item => (item.components || []).some(component => (component.processes || []).some(process => routeRows.some(route => route.id === process.id && route.routingMode === "VENDOR")))).map(item => item.partCode));
  const hasVendor = routeRows.some(row => row.routingMode === "VENDOR");
  rows.push({ id: "vendor", label: "Kapasitas vendor", owner: "Purchasing", source: "Routing vendor / komitmen kapasitas", status: hasVendor ? "UNKNOWN" : items.length ? "NA" : "UNKNOWN", asOf: source.datasetUpdatedAt?.vendor || maxDate(routeRows.map(row => row.updatedAt)), completeness: { complete: 0, total: hasVendor ? routeRows.filter(row => row.routingMode === "VENDOR").length : 0, percent: null }, affectedFgCount: vendorParts.size, affectedDeliveryCount: demand.filter(row => vendorParts.has(row.partCode)).length, issues: hasVendor ? ["Lead time vendor tersedia pada routing; bukti komitmen kapasitas interval vendor belum tersedia. Release belum dapat menyimpulkan vendor siap."] : items.length ? ["Tidak ada routing vendor pada cakupan ini."] : ["Routing belum tersedia untuk menentukan kebutuhan vendor."], route: "/modules/production/vendor-process-orders" });
  rows.push({ id: "version", label: "Versi sumber & snapshot", owner: "PPIC", source: "MPS revision / source fingerprint", status: source.stale ? "BLOCKER" : workbench.mps ? "OK" : "UNKNOWN", asOf: source.asOf, completeness: { complete: workbench.mps && !source.stale ? 1 : 0, total: 1, percent: workbench.mps && !source.stale ? 100 : 0 }, affectedFgCount: source.stale ? items.length : 0, affectedDeliveryCount: source.stale ? demand.length : 0, issues: source.stale ? [workbench.mps?.replanReason || "Sumber berubah setelah rencana dihitung."] : !workbench.mps ? ["MPS bulan ini belum tersedia. Buka MPS untuk menghitung snapshot dari demand."] : [], route: `${base}/labs/mps-gantt` });
  return rows.map(row => !row.issues.length && row.status === "UNKNOWN" ? { ...row, issues: ["Evaluasi sumber belum tersedia; belum dapat dinyatakan siap."] } : row);
}

async function snapshot(prisma, query, user) {
  d.assertAccess(user, query);
  const month = d.monthKey(query.month), customerFilter = d.text(query.customer), resourceFilter = d.text(query.resource);
  if (customerFilter.length > 100 || resourceFilter.length > 100) throw d.fail("Filter tidak valid.");
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    const [workbench, calendar, parts, customers, machines, targets] = await Promise.all([
      require("./mpsWorkbenchService").getMpsWorkbench(tx, { month, allItemsForEvaluation: true, includeFeasibilityDetail: "true" }),
      require("./deliveryCalendarService").deliveryCalendar(tx),
      tx.part.findMany({ where: { isDeleted: false }, select: { partCode: true, partName: true } }),
      tx.customer.findMany({ where: { isDeleted: false }, select: { customerCode: true, customerName: true } }),
      tx.machine.findMany({ where: { isDeleted: false, status: "Active" } }),
      tx.demandDeliveryTarget.findMany({ where: { isDeleted: false, status: "ACTIVE" }, select: { id: true, sourceNumber: true, sourceLineId: true, uomCode: true, updatedAt: true } }),
    ]);
    const processIds = [...new Set((workbench.items || []).flatMap(item => (item.components || []).flatMap(component => (component.processes || []).map(process => process.id))))];
    const [routeRows, dies, fingerprint, saved, datasetUpdatedAt] = await Promise.all([
      tx.mBOMProcess.findMany({ where: { id: { in: processIds }, isDeleted: false }, include: { mbomDetail: { include: { part: true } }, machine: true, process: true, vendor: true } }),
      tx.dies.findMany({ where: { isDeleted: false }, include: { diesParts: true } }),
      require("./integratedPlanService").sourceFingerprint(tx, `MONTH:${month}`, ["Vendor", "Supplier", "Process", "Customer"]),
      tx.$queryRaw`SELECT count(*)::int AS total FROM tbl_ppic_workspace_scenario WHERE month=${month}`,
      sourceTimes(tx),
    ]);
    const machineById = new Map(machines.map(row => [row.id, row]));
    const resourceIdsByRoute = new Map(routeRows.map(route => [route.id, require("./routingMachinePolicy").resolveRoutingMachinePolicy(route, machines, dies, { start: new Date(`${month}-01T00:00:00Z`), end: new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0, 23, 59, 59)) }).resources.map(resource => resource.machineId)]));
    const allowedParts = new Set((workbench.items || []).filter(item => (item.components || []).some(component => (component.processes || []).some(process => (resourceIdsByRoute.get(process.id) || []).includes(resourceFilter)))).map(item => item.partCode));
    const allDemand = projectDemand(calendar, targets, parts, customers, workbench, month);
    const validCustomer = !customerFilter || customerFilter === "ALL" || customers.some(row => row.customerCode === customerFilter);
    if (!validCustomer || (resourceFilter && resourceFilter !== "ALL" && !machineById.has(resourceFilter))) throw d.fail("Customer atau resource filter tidak ditemukan.", "INVALID_FILTER");
    const demand = allDemand.filter(row => (!customerFilter || customerFilter === "ALL" || row.customerCode === customerFilter) && (!resourceFilter || resourceFilter === "ALL" || allowedParts.has(row.partCode)));
    const visibleParts = new Set(demand.map(row => row.partCode));
    const visibleWorkbench = { ...workbench, items: (workbench.items || []).filter(item => visibleParts.has(item.partCode)) };
    const visibleProcessIds = new Set(visibleWorkbench.items.flatMap(item => (item.components || []).flatMap(component => (component.processes || []).map(process => process.id))));
    const visibleRoutes = routeRows.filter(route => visibleProcessIds.has(route.id));
    const source = { identifier: workbench.mps?.mpsNumber || `MONTH:${month}`, fingerprint, asOf: maxDate([workbench.mps?.updatedAt, ...demand.map(row => row.updatedAt), ...Object.values(datasetUpdatedAt)]), datasetUpdatedAt, stale: Boolean(workbench.mps?.replanRequired), completeness: "INCOMPLETE", basis: "Sumber ERP pada satu transaksi snapshot; fingerprint seluruh dependensi planning. Timestamp dataset memakai perubahan terakhir sumber, bukan waktu data dibuka." };
    const bomEvaluation = await require("./ppicBomReadiness").loadBomReadiness(tx, visibleWorkbench, machines, dies);
    const productionItems = visibleWorkbench.items.filter(item => d.numeric(item.planMetrics?.totalPlanQty) !== 0);
    const bomChecks = [...require("./ppicBomDiagnostics").diagnoseBom(productionItems, bomEvaluation.details, visibleRoutes), ...bomEvaluation.checks];
    const readiness = projectReadiness(visibleWorkbench, demand, visibleRoutes, source, bomChecks);
    const releaseReadiness = require("../../../../../library/ppic-workspace/domain.js").evaluateReadiness(readiness.map(row => ({ id: row.id, status: row.status, mandatory: true, reason: row.issues[0] || (row.status === "NA" ? "Tidak berlaku pada sumber dan routing terpilih." : row.label) })), { now: new Date().toISOString() });
    source.status = d.worst(readiness.map(row => row.status));
    source.completeness = readiness.every(row => row.status === "NA" || (row.completeness.total > 0 && row.completeness.complete === row.completeness.total)) ? "COMPLETE" : "INCOMPLETE";
    const exceptions = readiness.filter(row => ["BLOCKER", "UNKNOWN", "CONDITIONAL"].includes(row.status)).map(row => ({ id: row.id, title: row.issues[0] || row.label, status: row.status, owner: row.owner, affectedCount: row.affectedDeliveryCount, route: row.route }));
    const mrpCurrent = workbench.mrp?.isCurrentPlan === true;
    const stages = [
      { id: "delivery", label: "Delivery Schedule", status: readiness[0].status, route: `${base}/labs/demand-delivery`, detail: `${demand.length} delivery efektif` },
      { id: "mps", label: "MPS / FG Schedule", status: !workbench.mps ? "UNKNOWN" : source.stale ? "BLOCKER" : d.worst(demand.map(row => row.status)), route: `${base}/labs/mps-gantt`, detail: workbench.mps ? `${workbench.mps.mpsNumber} · revisi ${workbench.mps.revision}` : "MPS belum tersedia" },
      { id: "mrp", label: "MRP", status: mrpCurrent ? d.worst(readiness.filter(row => ["inventory", "material"].includes(row.id)).map(row => row.status)) : "UNKNOWN", route: `${base}/labs/mrp-material-readiness`, detail: workbench.mrp?.runNumber || "MRP terkini belum tersedia" },
      { id: "monthly", label: "Monthly Production Plan", status: "UNKNOWN", route: `${base}/labs/monthly-production-plan`, detail: "Status release memerlukan paket rencana dan validasi versi terkait." },
      { id: "daily", label: "Daily Draft", status: "UNKNOWN", route: `${base}/labs/daily-production-draft`, detail: "Validasi kesiapan dispatch terpisah dari kesiapan rencana." },
    ];
    return { schemaVersion: 1, month, businessDate: new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(businessNow()), timezone: "Asia/Jakarta", generatedAt: new Date().toISOString(), scope: { id: "ERP_GLOBAL", label: "Seluruh ERP", plantMappingAvailable: false }, capabilities: d.capabilities(user), source,
      filters: { plants: [{ value: "ALL", label: "Seluruh ERP" }], customers: [...new Set(allDemand.map(row => row.customerCode).filter(Boolean))].sort().map(code => ({ value: code, label: customers.find(row => row.customerCode === code)?.customerName || code })), resources: [...new Set([...resourceIdsByRoute.values()].flat())].sort().map(id => ({ value: id, label: machineById.get(id)?.machineCode || id })), resourceBasis: "FG dengan routing yang qualified untuk resource terpilih" },
      home: { deliveryCount: demand.length, fgCount: visibleParts.size, demandByUom: d.totalsByUom(demand), riskDeliveryCount: demand.filter(row => ["BLOCKER", "CONDITIONAL"].includes(row.status)).length, blockerCount: readiness.filter(row => row.status === "BLOCKER").length, unknownCount: readiness.filter(row => row.status === "UNKNOWN").length, stages, exceptions, scenarioCount: saved[0]?.total || 0, releaseReadiness },
      readiness, demand: { items: demand, total: demand.length, totalsByUom: d.totalsByUom(demand), basis: "Firm order mengonsumsi forecast sebelum baris delivery dibuat. Qty pengiriman SO dialokasikan sekali berdasarkan urutan due date; belum merupakan bukti penerimaan customer per fase." },
    };
  }, { isolationLevel: "RepeatableRead", timeout: 120000 });
}
module.exports = { snapshot, projectDemand, projectReadiness, ownerRoutes };
