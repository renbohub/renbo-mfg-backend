"use strict";

function number(value) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }
function round(value) { return Math.round(number(value) * 100) / 100; }
function date(value) { if (!value) return null; const parsed = new Date(value); return Number.isNaN(parsed.getTime()) ? null : parsed; }
function day(value) { return date(value)?.toISOString().slice(0, 10) || null; }
function source(entityType, entityId, label, href) { return { entityType, entityId: String(entityId), label: String(label), href }; }

function phaseSources(item) {
  return (Array.isArray(item.sourceRequirements) ? item.sourceRequirements : []).flatMap((row) => {
    const sources = [];
    if (row.sourceNumber) sources.push(source("MRP_REQUIREMENT", item.mrpRequirementId || `${item.id}:mrp`, row.sourceNumber, `/modules/planning-ppic/mrp/${encodeURIComponent(row.sourceNumber)}`));
    if (row.deliveryTargetId) sources.push(source("FG_DELIVERY_PHASE", row.deliveryTargetId, `${row.fgPartCode || "FG"} · ${day(row.targetDeliveryDate || row.requiredDate) || "delivery"}`, `/modules/planning-ppic/demand-planning/delivery-workbench?deliveryTargetId=${encodeURIComponent(row.deliveryTargetId)}`));
    return sources;
  });
}

async function loadSuggestions(prisma, input = {}) {
  const partCode = String(input.partCode || "").trim();
  return prisma.purchaseSuggestionItem.findMany({
    where: { isDeleted: false, ...(input.suggestionItemId ? { id: input.suggestionItemId } : {}), ...(partCode ? { OR: [{ partCode }, { materialCode: partCode }] } : {}), status: { notIn: ["Cancelled", "Converted to PR"] } },
    orderBy: [{ materialRequiredDate: "asc" }, { partCode: "asc" }], take: Math.min(Math.max(number(input.limit) || 100, 1), 100),
  });
}

async function loadOpenPo(prisma, partCodes) {
  return prisma.purchaseOrderDetail.findMany({
    where: { isDeleted: false, partCode: { in: partCodes }, po: { isDeleted: false, status: { notIn: ["Draft", "Rejected", "Cancelled", "Completed"] } } },
    select: { id: true, partCode: true, qty: true, qtyReceived: true, deliveryDate: true, po: { select: { poNumber: true, supplierCode: true, deliveryDate: true, status: true } } }, take: 500,
  });
}

function mapRisk(item, poRows) {
  const requiredDate = date(item.materialRequiredDate);
  const matching = poRows.filter((row) => row.partCode === item.partCode || row.partCode === item.materialCode);
  const openQty = (row) => Math.max(number(row.qty) - number(row.qtyReceived), 0);
  const onTime = matching.filter((row) => !date(row.deliveryDate || row.po?.deliveryDate) || date(row.deliveryDate || row.po?.deliveryDate) <= requiredDate);
  const late = matching.filter((row) => date(row.deliveryDate || row.po?.deliveryDate) > requiredDate);
  const stockQty = Math.max(number(item.availableStock), 0);
  const coveredQty = round(stockQty + onTime.reduce((sum, row) => sum + openQty(row), 0));
  const requiredQty = round(Math.max(number(item.grossRequirement), number(item.recommendedPurchaseQty), number(item.netRequirement)));
  const shortageQty = round(Math.max(requiredQty - coveredQty, 0));
  const lateSupplyQty = round(late.reduce((sum, row) => sum + openQty(row), 0));
  const sources = [
    source("PURCHASE_SUGGESTION", item.id, item.suggestionNumber, `/modules/purchasing/purchase-suggestions/${encodeURIComponent(item.suggestionNumber)}`),
    ...phaseSources(item),
    ...matching.map((row) => source("PURCHASE_ORDER", row.id, row.po.poNumber, `/modules/purchasing/purchase-order/${encodeURIComponent(row.po.poNumber)}`)),
  ];
  return {
    suggestionItemId: item.id, partCode: item.partCode || item.materialCode, requiredQty, requiredDate: day(requiredDate), coveredQty, shortageQty, lateSupplyQty,
    supplierCode: item.suggestedSupplierCode || matching[0]?.po?.supplierCode || null, supplierLeadTimeDays: number(item.purchasingLeadTimeDays), moq: round(item.moq), latestReleaseDate: day(item.latestPrDate || item.recommendedOrderDate),
    status: shortageQty > 0 ? (lateSupplyQty > 0 ? "LATE_SUPPLY" : "SHORTAGE") : "COVERED", deliveryPhases: (Array.isArray(item.sourceRequirements) ? item.sourceRequirements : []).map((row) => ({ fgPartCode: row.fgPartCode || null, deliveryTargetId: row.deliveryTargetId || null, requiredDate: day(row.targetDeliveryDate || row.requiredDate), requiredQty: round(row.qty || row.requiredQty || 0) })), sources,
  };
}

async function getMaterialShortage({ prisma, input }) {
  const suggestions = await loadSuggestions(prisma, input);
  const poRows = await loadOpenPo(prisma, suggestions.map((row) => row.partCode || row.materialCode).filter(Boolean));
  const items = suggestions.map((row) => mapRisk(row, poRows));
  return { items, sources: items.flatMap((row) => row.sources).slice(0, 100) };
}

async function findLatePo({ prisma, input }) {
  const asOf = date(input.asOfDate) || new Date();
  const rows = await prisma.purchaseOrderDetail.findMany({ where: { isDeleted: false, po: { isDeleted: false, status: { notIn: ["Completed", "Cancelled", "Rejected"] } } }, select: { id: true, partCode: true, qty: true, qtyReceived: true, deliveryDate: true, po: { select: { poNumber: true, supplierCode: true, deliveryDate: true, status: true } } }, take: Math.min(Math.max(number(input.limit) || 100, 1), 100) });
  const items = rows.filter((row) => Math.max(number(row.qty) - number(row.qtyReceived), 0) > 0 && date(row.deliveryDate || row.po.deliveryDate) > asOf).map((row) => ({ poNumber: row.po.poNumber, partCode: row.partCode, supplierCode: row.po.supplierCode, outstandingQty: round(number(row.qty) - number(row.qtyReceived)), committedDate: day(row.deliveryDate || row.po.deliveryDate), status: "LATE_VS_REQUIRED_DATE", sources: [source("PURCHASE_ORDER", row.id, row.po.poNumber, `/modules/purchasing/purchase-order/${encodeURIComponent(row.po.poNumber)}`)] }));
  return { items, sources: items.flatMap((row) => row.sources) };
}

async function createRecoveryDraft({ prisma, input, user }) {
  const [item] = await loadSuggestions(prisma, { suggestionItemId: input.suggestionItemId, limit: 1 });
  if (!item) throw Object.assign(new Error("Purchase Suggestion tidak ditemukan."), { code: "AI_PURCHASE_SOURCE_NOT_FOUND", statusCode: 404 });
  const sourceReferences = [source("PURCHASE_SUGGESTION", item.id, item.suggestionNumber, `/modules/purchasing/purchase-suggestions/${encodeURIComponent(item.suggestionNumber)}`), ...phaseSources(item)];
  return prisma.aiDraft.create({ data: {
    conversationId: input.conversationId, requestId: input.requestId, userId: String(user?.id || ""), moduleCode: "purchasing", pageCode: "purchase-suggestions", draftType: "PURCHASING_RECOVERY",
    generationSource: "AI_GENERATED", status: "WAITING_CONFIRMATION",
    payload: { owner: input.owner, proposedSupplierCommitmentDate: input.proposedSupplierCommitmentDate, expediteNote: input.expediteNote, sourceReferences }, sourceRefs: sourceReferences,
    validationSummary: { valid: true, issues: [], restrictions: ["NO_PO_MUTATION", "NO_QUANTITY_MUTATION"] }, expiresAt: new Date(Date.now() + 7 * 86400000),
  } });
}

function createPurchasingCapabilityDefinitions() {
  const readPermission = { moduleCode: "purchasing", pageCode: "*", resourceCode: "purchaseSuggestions", action: "read" };
  const draftPermission = { ...readPermission, action: "update" };
  return [
    { code: "purchasing.get_material_shortage", operationClass: "ANALYZE", permission: readPermission, maxRows: 100, fieldAllowlist: ["items", "sources"], inputSchema: { type: "object", additionalProperties: false, properties: { partCode: { type: "string", maxLength: 100 }, limit: { type: "integer", minimum: 1, maximum: 100 } } }, outputSchema: { type: "object" }, execute: getMaterialShortage },
    { code: "purchasing.find_late_po", operationClass: "ANALYZE", permission: readPermission, maxRows: 100, fieldAllowlist: ["items", "sources"], inputSchema: { type: "object", additionalProperties: false, properties: { asOfDate: { type: "string", format: "date" }, limit: { type: "integer", minimum: 1, maximum: 100 } } }, outputSchema: { type: "object" }, execute: findLatePo },
    { code: "purchasing.create_recovery_draft", operationClass: "DRAFT", permission: draftPermission, maxRows: 100, fieldAllowlist: ["id", "status", "draftType", "payload", "sourceRefs", "expiresAt"], inputSchema: { type: "object", additionalProperties: false, required: ["conversationId", "requestId", "suggestionItemId", "owner", "proposedSupplierCommitmentDate", "expediteNote"], properties: { conversationId: { type: "string", minLength: 1 }, requestId: { type: "string", minLength: 1 }, suggestionItemId: { type: "string", minLength: 1 }, owner: { type: "string", minLength: 1, maxLength: 120 }, proposedSupplierCommitmentDate: { type: "string", format: "date" }, expediteNote: { type: "string", minLength: 3, maxLength: 1000 } } }, outputSchema: { type: "object" }, execute: createRecoveryDraft },
  ];
}

function registerPurchasingCapabilities(registry) { for (const definition of createPurchasingCapabilityDefinitions()) if (!registry.has(definition.code)) registry.register(definition); return registry; }
module.exports = { createPurchasingCapabilityDefinitions, registerPurchasingCapabilities };
