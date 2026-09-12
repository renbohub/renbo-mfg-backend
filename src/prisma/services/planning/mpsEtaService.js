"use strict";
const evidence = require("./mpsProductionEvidenceService");
const store = require("../purchasing/etaConfirmationStore");
const n = (v) => Number(v) || 0;
const value = (v) => v != null && v !== "" && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : null;
const unique = (values) => [...new Set(values.filter(Boolean))];
const partSelect = { partCode: true, partNumber: true, partName: true, itemType: true, rawType: true, hasDrawing: true, category: true, productionUomCode: true, baseUomCode: true };
const detailInclude = { part: { select: partSelect }, demandSources: { orderBy: [{ effectiveRequiredDate: "asc" }, { sourceNumber: "asc" }] } };
function procurementPolicy(material) {
  const source = material.procurementPolicy || material.procurementLeadTimeBreakdown;
  if (!source) return null;
  const keys = material.materialSupplyType === "CUSTOMER_SUPPLIED" ? ["transitDays", "receivingQcDays", "safetyLeadTimeDays"] : ["prApprovalDays", "poProcessingDays", "transitDays", "receivingQcDays", "safetyLeadTimeDays"];
  if (keys.some((key) => value(source[key]) == null)) return null;
  return { ...Object.fromEntries(keys.map((key) => [key, value(source[key])])), holidays: source.holidays || [] };
}
function materialCategory(part, materialCode) {
  if (materialCode || (part?.itemType === "RAW" && part?.rawType === "MATERIAL")) return "MATERIAL";
  if (part?.rawType === "PURCHASE_PART") return part.hasDrawing ? "PURCHASE_PART" : "UNIVERSAL_PART";
  return "OTHER";
}
function vendorIdentity(process, phase, header) {
  const candidates = (header?.details || []).flatMap((detail) => (detail.mbomProcesses || []).map((route) => ({ detail, route })))
    .filter(({ route }) => process.mbomProcessId ? route.id === process.mbomProcessId
      : route.process?.processCode === process.processCode && n(route.sequence) === n(process.sequence)
        && (!process.vendorCode || route.vendor?.vendorCode === process.vendorCode));
  const match = candidates.length === 1 ? candidates[0] : null;
  const part = match?.detail.part;
  let qty = value(process.requiredQty ?? process.qty);
  if (qty == null && match) {
    const traces = (phase.bomTrace || []).filter((row) => row.mbomNumber === header.noReg && row.partCode === part?.partCode);
    if (traces.length === 1) qty = value(traces[0].requiredQty);
    else {
      // Resolve only the pinned BOM parent chain; never substitute FG quantity.
      const byId = new Map(header.details.map((row) => [row.id, row]));
      const visited = new Set();
      let cursor = match.detail, amount = value(phase.plannedProductionQty);
      while (cursor && amount != null) {
        if (visited.has(cursor.id) || value(cursor.qty) == null) { amount = null; break; }
        visited.add(cursor.id);
        amount *= Number(cursor.qty);
        if (cursor.parentDetailId && !byId.has(cursor.parentDetailId)) { amount = null; break; }
        cursor = byId.get(cursor.parentDetailId);
      }
      qty = amount;
    }
  }
  return { partCode: process.partCode || part?.partCode || null, partNumber: process.partNumber || part?.partNumber || null,
    partName: process.partName || part?.partName || null, qty, uom: process.uomCode || match?.detail.uomCode || part?.productionUomCode || part?.baseUomCode || null,
    vendorCode: process.vendorCode || match?.route.vendor?.vendorCode || null,
    vendorName: process.vendorName || match?.route.vendor?.vendorName || null,
    leadTime: value(process.vendorLeadTimeDays) ?? value(match?.route.vendor?.leadTimeDays) };
}
const href = (doc) => `/modules/planning-ppic/mps?month=${store.day(doc.periodStart)?.slice(0, 7)}`;
function buildRows(doc, inputKey, masters = {}) {
  const rows = [];
  for (const detail of doc.details || []) {
    if (detail.isDeleted || String(detail.notes || "").startsWith("[MRP-PRODUCTION]") || n(detail.qtyPlanned) <= 0) continue;
    const saved = detail.calculationTrace?.productionChecksheet;
    const current = !doc.replanRequired && saved?.version === evidence.VERSION && saved.mpsRevision === doc.revision && saved.sourceKey === inputKey && saved.mbomHeaderId === detail.mbomHeaderId;
    const base = { etaMode: doc.etaMode || "BOM", source: doc.mpsNumber, mpsNumber: doc.mpsNumber, mpsRevision: doc.revision, documentStatus: doc.status, bomId: detail.mbomHeaderId, detailId: detail.id, href: href(doc), action: "Buka checksheet MPS", stage: "Sebelum release MPS", receivedQty: null, confirmed: false, stale: !current, blockReason: current ? null : "Checksheet belum diperiksa untuk data terbaru. Jalankan Periksa checksheet." };
    const phases = Object.entries(saved?.phases || {});
    const total = phases.reduce((sum, [, p]) => sum + n(p.plannedProductionQty), 0);
    if (!current || !phases.length || Math.abs(total - n(detail.qtyPlanned)) > .0001 || phases.some(([, p]) => !p.complete || p.error)) {
      rows.push({ ...base, id: `MPSCHECK:${detail.id}`, category: "CHECKSHEET", code: detail.partCode, name: detail.part?.partName, needDate: detail.fgRequiredDate || detail.endDate, qty: detail.qtyPlanned, canConfirm: false, checkOnly: true, blockReason: "Checksheet material / vendor belum lengkap atau berubah. Jalankan Periksa checksheet." });
      continue;
    }
    for (const [phaseKey, phase] of phases) {
      const demandPhase = detail.demandSources?.length ? require("./mpsWorkbenchService").demandPhases(detail).find((row) => row.id === phase.phaseId) : null;
      const phaseBase = { ...base, phaseKey, phaseId: phase.phaseId, fgRequiredDate: phase.fgRequiredDate,
        customerDeliveryDate: ["BUFFER", "CARRYOVER"].includes(phase.sourceType || demandPhase?.sourceType) ? null
          : phase.customerDeliveryDate || phase.targetDeliveryDate || demandPhase?.targetDeliveryDate || null,
        needDateSource: "Explode BOM checksheet MPS · sebelum MRP resmi" };
      for (const [index, material] of (phase.materialCoverage || []).entries()) {
        if (material.shortageQty == null) {
          rows.push({ ...phaseBase, id: `MPSCHECK:${detail.id}:${phaseKey}:${index}`, category: "CHECKSHEET", code: material.partCode, needDate: material.requiredDate, qty: material.qty, canConfirm: false, checkOnly: true, blockReason: "Net kebutuhan material belum tersedia; periksa checksheet." });
          continue;
        }
        if (n(material.shortageQty) <= 0) continue;
        const customer = material.materialSupplyType === "CUSTOMER_SUPPLIED";
        const part = masters.parts?.get(material.partCode) || material.part;
        const materialMaster = masters.materials?.get(material.materialCode);
        const partnerCode = customer ? material.supplyCustomerCode : material.supplierCode;
        const partnerMaster = (customer ? masters.customers : masters.suppliers)?.get(partnerCode);
        const supplierItem = masters.supplierItems?.get(material.supplierItemId);
        rows.push({ ...phaseBase, id: `MPSM:${detail.id}:${phaseKey}:${index}`, category: customer ? "CUSTOMER" : materialCategory(part, material.materialCode),
          masterCategory: part?.category || materialMaster?.itemCategory || null, code: material.materialCode || material.partCode,
          materialCode: material.materialCode || null, partCode: material.partCode, partNumber: material.partNumber || part?.partNumber || null,
          name: material.materialName || materialMaster?.materialName || material.partName || part?.partName || null,
          partnerCode, partner: (customer ? partnerMaster?.customerName || material.supplyCustomerName : partnerMaster?.supplierName || material.supplierName) || partnerCode,
          materialSupplyType: material.materialSupplyType, supplyCustomerCode: customer ? partnerCode : null,
          supplyPoolKey: customer ? require("./customerSupplyService").poolKey(material) : null,
          eligibleSupply: material.eligibleSupply || [],
          needDate: material.requiredDate, eta: null, readyDate: null,
          targetArrivalDate: material.targetArrivalDate || (customer ? material.customerRequiredArrivalDate : material.supplierRequiredArrivalDate) || null,
          purchaseMaxDate: customer ? null : material.purchaseMaxDate || material.latestPoDate || null,
          procurementPolicy: procurementPolicy(material),
          leadTime: customer ? evidence.customerSupplyLeadTime(material)
            : value(supplierItem?.leadTimeDays) ?? value(partnerMaster?.leadTimeDays) ?? (masters.suppliers ? null : value(material.supplierLeadTimeDays)),
          qty: n(material.shortageQty), requiredQty: n(material.shortageQty), uom: material.uomCode, requiresQc: true, checkpoint: "MPS_MATERIAL" });
      }
      for (const [index, process] of (phase.processTimeline || []).entries()) {
        if (process.routingMode !== "VENDOR") continue;
        const identity = vendorIdentity(process, phase, masters.headers?.get(detail.mbomHeaderId));
        const part = masters.parts?.get(identity.partCode);
        const vendor = masters.vendors?.get(identity.vendorCode);
        const complete = Boolean(identity.partCode && identity.qty > 0 && identity.uom);
        rows.push({ ...phaseBase, id: `MPSV:${detail.id}:${phaseKey}:${index}`, category: "VENDOR", code: identity.partCode, partCode: identity.partCode,
          partNumber: identity.partNumber || part?.partNumber || null, name: identity.partName || part?.partName || null, process: process.processCode, partnerCode: identity.vendorCode,
          partner: vendor?.vendorName || identity.vendorName || identity.vendorCode, needDate: process.latestFinishDate,
          targetArrivalDate: process.latestFinishDate, sendDate: process.latestStartDate, bomStartDate: phase.solver?.forward?.tasks?.find((task) => task.id === process.solverTaskId)?.startDate || null, eta: null, readyDate: null,
          leadTime: value(vendor?.leadTimeDays) ?? identity.leadTime, qty: identity.qty, requiredQty: identity.qty, uom: identity.uom,
          canConfirm: complete, checkOnly: !complete, blockReason: complete ? base.blockReason : "Identitas / qty proses vendor belum tersedia atau ambigu pada BOM terpilih; periksa checksheet.", checkpoint: "MPS_VENDOR" });
      }
    }
  }
  return rows;
}
async function forDocuments(db, docs, options = {}) {
  if (!docs.length) return [];
  const key = options.inputKey || await evidence.sourceKey(db);
  const phases = docs.flatMap((doc) => (doc.details || []).flatMap((detail) => Object.values(detail.calculationTrace?.productionChecksheet?.phases || {})));
  const materials = phases.flatMap((phase) => phase.materialCoverage || []);
  const processes = phases.flatMap((phase) => phase.processTimeline || []);
  const load = async (model, field, codes, select) => {
    const keys = unique(codes);
    const rows = keys.length ? await db[model].findMany({ where: { [field]: { in: keys }, ...(model === "supplierItem" ? { isActive: true } : { isDeleted: false }) }, select }) : [];
    return new Map(rows.map((row) => [row[field], row]));
  };
  const [parts, materialMasters, suppliers, customers, vendors, supplierItems, headers] = await Promise.all([
    load("part", "partCode", [...materials, ...processes].map((r) => r.partCode), partSelect),
    load("material", "materialCode", materials.map((r) => r.materialCode), { materialCode: true, materialName: true, itemCategory: true }),
    load("supplier", "supplierCode", materials.filter((r) => r.materialSupplyType !== "CUSTOMER_SUPPLIED").map((r) => r.supplierCode), { supplierCode: true, supplierName: true, leadTimeDays: true }),
    load("customer", "customerCode", materials.filter((r) => r.materialSupplyType === "CUSTOMER_SUPPLIED").map((r) => r.supplyCustomerCode), { customerCode: true, customerName: true }),
    load("vendor", "vendorCode", processes.map((r) => r.vendorCode), { vendorCode: true, vendorName: true, leadTimeDays: true }),
    load("supplierItem", "id", materials.filter((r) => r.materialSupplyType !== "CUSTOMER_SUPPLIED").map((r) => r.supplierItemId), { id: true, leadTimeDays: true }),
    load("mBOMHeader", "id", docs.flatMap((doc) => (doc.details || []).filter((detail) => Object.values(detail.calculationTrace?.productionChecksheet?.phases || {}).some((phase) => phase.processTimeline?.some((p) => p.routingMode === "VENDOR"))).map((detail) => detail.mbomHeaderId)),
      { id: true, noReg: true, details: { where: { isDeleted: false }, select: { id: true, parentDetailId: true, qty: true, uomCode: true, part: { select: partSelect }, mbomProcesses: { where: { isDeleted: false }, select: { id: true, sequence: true, process: { select: { processCode: true } }, vendor: { select: { vendorCode: true, vendorName: true, leadTimeDays: true } } } } } } }),
  ]);
  const rows = docs.flatMap((doc) => buildRows(doc, key, { parts, materials: materialMasters, suppliers, customers, vendors, supplierItems, headers }));
  const decorated = await store.attach(db, rows);
  const cache = new Map();
  const automatic = await Promise.all(decorated.map((row) => require("../purchasing/etaBomService").attach(row, { cache })));
  return automatic.map((row) => ({ ...row, readiness: store.readiness(row) }));
}
async function document(db, mpsNumber) {
  const doc = await db.mPS.findFirst({ where: { mpsNumber, isDeleted: false, status: { notIn: ["Cancelled", "Superseded"] } }, include: { details: { where: { isDeleted: false }, include: detailInclude } } });
  if (!doc) store.fail("MPS tidak ditemukan.", 404);
  return doc;
}
function summary(rows) {
  const pending = rows.filter((row) => !row.readiness.ready);
  return { ready: !pending.length, total: rows.length, confirmed: rows.length - pending.length, byBom: rows.filter((r) => r.etaBasis === "BOM" && r.readiness.ready).length, manual: rows.filter((r) => r.confirmed && r.readiness.ready).length, pending: pending.length, blockers: pending.map((r) => ({ id: r.id, source: r.source, code: r.code, category: r.category, reason: r.readiness.reason, href: r.href })) };
}
async function assertReady(db, mpsNumber) {
  const doc = await document(db, mpsNumber);
  const gate = summary(await forDocuments(db, [doc]));
  if (!gate.ready) store.fail(`${mpsNumber}: ${gate.pending} konfirmasi / checksheet belum selesai. Buka ETA → Sebelum release.`, 409, "MPS_ETA_NOT_READY");
  return gate;
}
async function list(db, month, mpsNumber = null) {
  const range = require("../purchasing/etaMonitorService").period(month);
  const docs = await db.mPS.findMany({ where: { isDeleted: false, status: { notIn: ["Cancelled", "Superseded", "Completed", "Closed"] }, periodStart: { lt: range.lt }, periodEnd: { gte: range.gte } }, include: { details: { where: { isDeleted: false }, include: detailInclude } }, orderBy: { mpsNumber: "asc" }, take: 101 });
  if (docs.length > 100) store.fail("Periode memuat lebih dari 100 MPS. Persempit periode.", 422);
  const available = docs.filter((doc) => !doc.isDeleted && !["Cancelled", "Superseded", "Completed", "Closed"].includes(doc.status)
    && new Date(doc.periodStart) < range.lt && new Date(doc.periodEnd) >= range.gte);
  const requested = mpsNumber == null ? "" : String(mpsNumber).trim();
  const canonical = available.filter((doc) => doc.sourceKey === `MONTH:${month}` && !doc.simulationOnly);
  const fallback = available.filter((doc) => !doc.simulationOnly);
  const selected = requested ? available.find((doc) => doc.mpsNumber === requested)
    : canonical.length === 1 ? canonical[0] : !canonical.length && fallback.length === 1 ? fallback[0] : null;
  if (requested && !selected) store.fail("MPS tidak tersedia pada periode yang dipilih.", 404, "MPS_ETA_SELECTION_INVALID");
  const items = selected ? await forDocuments(db, [selected]) : [];
  return { month, selectedMpsNumber: selected?.mpsNumber || null, items,
    documents: available.map((doc) => ({ mpsNumber: doc.mpsNumber, revision: doc.revision, status: doc.status, href: href(doc), etaMode: doc.etaMode || "BOM", etaModeVersion: doc.etaModeVersion || 0, etaModeChangedBy: doc.etaModeChangedBy, etaModeChangedAt: doc.etaModeChangedAt,
      periodStart: doc.periodStart, periodEnd: doc.periodEnd, sourceKey: doc.sourceKey, simulationOnly: Boolean(doc.simulationOnly),
      capacityStatus: doc.capacityStatus, deliveryStatus: doc.deliveryFeasibilityStatus,
      eta: doc.mpsNumber === selected?.mpsNumber ? summary(items) : null })) };
}
async function assertPlanReady(db, plan) {
  const ids = [...new Set((plan.details || []).map((r) => r.mpsDetailId).filter(Boolean))];
  const details = ids.length ? await db.mPSDetail.findMany({ where: { id: { in: ids }, isDeleted: false }, select: { mpsNumber: true } }) : [];
  for (const mpsNumber of new Set(details.map((r) => r.mpsNumber))) await assertReady(db, mpsNumber);
  const monitor = require("../purchasing/etaMonitorService");
  const rows = (await monitor.loaders["vendor-plans"](db, { gte: plan.periodStart, lt: new Date(new Date(plan.periodEnd).getTime() + 86400000) })).filter((r) => r.source === plan.planNumber);
  const commitments = await store.attach(db, rows);
  const pending = commitments.filter((r) => !store.readiness(r).ready);
  if (pending.length) store.fail(`${pending.length} proses vendor belum memiliki qty / ETA terkonfirmasi sesuai kebutuhan. Buka ETA → Proses Vendor.`, 409, "PLAN_VENDOR_ETA_NOT_READY");
}
module.exports = { buildRows, forDocuments, document, summary, assertReady, assertPlanReady, list };
