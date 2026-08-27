"use strict";
function source(entityType, entityId, label, href) { return { entityType, entityId: String(entityId), label: String(label), href }; }
async function explainMps({ prisma, input }) {
  const document = await prisma.mPS.findFirst({ where: { mpsNumber: input.mpsNumber, isDeleted: false }, include: { details: { where: { isDeleted: false } }, deliveryPlans: { where: { isDeleted: false } } } });
  if (!document) throw Object.assign(new Error("MPS tidak ditemukan."), { statusCode: 404 });
  const sources = [source("MPS", document.id, document.mpsNumber, `/modules/planning-ppic/mps/workbench?mpsNumber=${encodeURIComponent(document.mpsNumber)}`)];
  return { document: { mpsNumber: document.mpsNumber, revision: document.revision, status: document.status }, calculationHistory: document.details.map((row) => ({ partCode: row.partCode, mpsQty: row.mpsQty, shortageQty: row.shortageQty, bufferQty: row.bufferQty, nettingHistory: row.nettingHistory || row.calculationHistory || null })), deliveryPhases: document.deliveryPlans.map((row) => ({ deliveryTargetId: row.deliveryTargetId || row.id, fgRequiredDate: row.fgRequiredDate || row.deliveryDate, feasibilityStatus: row.feasibilityStatus, blockerStatus: row.blockerStatus, forecast: row.forecastNumber || row.sourceNumber })), sources };
}
async function explainMrpNetting({ prisma, input }) {
  const run = await prisma.mRPRun.findFirst({ where: { runNumber: input.runNumber, isDeleted: false } });
  const rows = await prisma.mRPRequirement.findMany({ where: { runNumber: input.runNumber, isDeleted: false, ...(input.partCode ? { partCode: input.partCode } : {}) }, orderBy: { requiredDate: "asc" }, take: 100 });
  const items = rows.map((row) => ({ requirementId: row.id, partCode: row.partCode, grossRequirement: row.grossRequirement, netRequirement: row.netRequirement, warehouseStock: row.supplyBreakdown?.warehouseStock || { qtyOnHand: row.onHandQty, qtyReserved: row.allocatedQty }, wipStock: row.supplyBreakdown?.wipStock || null, freeStock: row.projectedAvailableQty, reservedStock: row.allocatedQty, nettingHistory: row.consumptionSources || row.supplyTimeline || null, deliveryTargetId: row.deliveryTargetId, fgRequiredDate: row.productionRequiredDate || row.requiredDate, forecast: row.rootDemandSourceType === "FORECAST" ? row.rootDemandSourceNumber : null }));
  const sources = [source("MRP", run?.id || input.runNumber, input.runNumber, `/modules/planning-ppic/mrp/${encodeURIComponent(input.runNumber)}`), ...rows.filter((row) => row.deliveryTargetId).map((row) => source("FG_DELIVERY_PHASE", row.deliveryTargetId, row.fgPartCode || row.partCode, `/modules/planning-ppic/demand-planning/delivery-workbench?deliveryTargetId=${encodeURIComponent(row.deliveryTargetId)}`))];
  return { document: { runNumber: input.runNumber, revision: run?.revision, status: run?.status }, items, sources };
}
async function getDeliveryBlockers({ prisma, input }) {
  const rows = await prisma.mPSDeliveryPlan.findMany({ where: { isDeleted: false, ...(input.mpsNumber ? { mpsNumber: input.mpsNumber } : {}), OR: [{ feasibilityStatus: { not: "FEASIBLE" } }, { blockerStatus: { not: null } }] }, take: 100 });
  const items = rows.map((row) => ({ deliveryTargetId: row.deliveryTargetId || row.id, mpsNumber: row.mpsNumber, partCode: row.partCode || row.fgPartCode, fgRequiredDate: row.fgRequiredDate || row.deliveryDate, feasibilityStatus: row.feasibilityStatus, blockerStatus: row.blockerStatus, recoveryStatus: row.recoveryStatus, forecast: row.forecastNumber || row.sourceNumber }));
  return { items, sources: items.map((row) => source("FG_DELIVERY_PHASE", row.deliveryTargetId, `${row.partCode || "FG"} · ${row.fgRequiredDate || "required"}`, `/modules/planning-ppic/demand-planning/delivery-workbench?deliveryTargetId=${encodeURIComponent(row.deliveryTargetId)}`)) };
}
function createPpicCapabilityDefinitions() {
  const permission = { moduleCode: "planning-ppic", pageCode: "*", resourceCode: "monthlyProductionPlan", action: "read" };
  return [
    { code: "ppic.explain_mps", operationClass: "ANALYZE", permission, maxRows: 100, fieldAllowlist: ["document", "calculationHistory", "deliveryPhases", "sources"], inputSchema: { type: "object", additionalProperties: false, required: ["mpsNumber"], properties: { mpsNumber: { type: "string" } } }, outputSchema: { type: "object" }, execute: explainMps },
    { code: "ppic.explain_mrp_netting", operationClass: "ANALYZE", permission, maxRows: 100, fieldAllowlist: ["document", "items", "sources"], inputSchema: { type: "object", additionalProperties: false, required: ["runNumber"], properties: { runNumber: { type: "string" }, partCode: { type: "string" } } }, outputSchema: { type: "object" }, execute: explainMrpNetting },
    { code: "ppic.get_delivery_blockers", operationClass: "READ", permission, maxRows: 100, fieldAllowlist: ["items", "sources"], inputSchema: { type: "object", additionalProperties: false, properties: { mpsNumber: { type: "string" } } }, outputSchema: { type: "object" }, execute: getDeliveryBlockers },
  ];
}
function registerPpicCapabilities(registry) { for (const definition of createPpicCapabilityDefinitions()) if (!registry.has(definition.code)) registry.register(definition); return registry; }
module.exports = { createPpicCapabilityDefinitions, registerPpicCapabilities };
