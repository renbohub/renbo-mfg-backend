"use strict";

const assert = require("assert");
const { createPurchasingCapabilityDefinitions } = require("../src/prisma/services/ai/capabilities/purchasingCapabilities");

const requiredDate = new Date("2026-09-05T00:00:00Z");
const suggestion = {
  id: "psi-1", suggestionNumber: "PS-001", mrpRequirementId: "req-1", partCode: "NUT-M6", uomCode: "PCS",
  materialRequiredDate: requiredDate, recommendedOrderDate: new Date("2026-08-20T00:00:00Z"), latestPrDate: new Date("2026-08-21T00:00:00Z"),
  grossRequirement: 100, availableStock: 20, openPoQty: 50, atRiskSupplyQty: 30, netRequirement: 30, recommendedPurchaseQty: 50,
  moq: 50, purchasingLeadTimeDays: 14, suggestedSupplierCode: "SUP-01", sourceRequirements: [{ sourceType: "MPS", sourceNumber: "MPS-202609", fgPartCode: "FG-A", deliveryTargetId: "phase-1", targetDeliveryDate: "2026-09-05", requiredDate: "2026-09-05", qty: 100 }],
};
const poRows = [
  { id: "pod-1", partCode: "NUT-M6", qty: 30, qtyReceived: 0, deliveryDate: new Date("2026-09-03"), po: { poNumber: "PO-ON-TIME", supplierCode: "SUP-01", deliveryDate: new Date("2026-09-03"), status: "Confirmed" } },
  { id: "pod-2", partCode: "NUT-M6", qty: 20, qtyReceived: 0, deliveryDate: new Date("2026-09-10"), po: { poNumber: "PO-LATE", supplierCode: "SUP-01", deliveryDate: new Date("2026-09-10"), status: "Sent" } },
];
let draftData;
const prisma = {
  purchaseSuggestionItem: { findMany: async () => [suggestion] },
  purchaseOrderDetail: { findMany: async () => poRows },
  aiDraft: { create: async ({ data }) => { draftData = data; return { id: "draft-1", ...data }; } },
};

(async () => {
  const defs = createPurchasingCapabilityDefinitions();
  assert.deepStrictEqual(defs.map((row) => row.code), ["purchasing.get_material_shortage", "purchasing.find_late_po", "purchasing.create_recovery_draft"]);
  const shortage = await defs[0].execute({ prisma, input: { partCode: "NUT-M6" } });
  assert.strictEqual(shortage.items[0].requiredDate, "2026-09-05");
  assert.strictEqual(shortage.items[0].coveredQty, 50);
  assert.strictEqual(shortage.items[0].shortageQty, 50);
  assert.strictEqual(shortage.items[0].lateSupplyQty, 20);
  assert.strictEqual(shortage.items[0].moq, 50);
  assert.ok(shortage.items[0].sources.some((source) => source.entityType === "MRP_REQUIREMENT"));
  assert.ok(shortage.items[0].sources.some((source) => source.entityType === "FG_DELIVERY_PHASE"));
  const late = await defs[1].execute({ prisma, input: { asOfDate: "2026-09-05" } });
  assert.strictEqual(late.items.length, 1);
  assert.strictEqual(late.items[0].poNumber, "PO-LATE");
  const draft = await defs[2].execute({ prisma, user: { id: "u-1" }, input: { conversationId: "c-1", requestId: "ar-1", suggestionItemId: "psi-1", owner: "Buyer A", proposedSupplierCommitmentDate: "2026-09-04", expediteNote: "Expedite via air" } });
  assert.strictEqual(draft.status, "WAITING_CONFIRMATION");
  assert.deepStrictEqual(Object.keys(draftData.payload).sort(), ["expediteNote", "owner", "proposedSupplierCommitmentDate", "sourceReferences"].sort());
  assert.ok(!JSON.stringify(draftData.payload).match(/poStatus|quantity|qty/i));
  console.log("AI purchasing capabilities: OK");
})().catch((error) => { console.error(error); process.exitCode = 1; });
