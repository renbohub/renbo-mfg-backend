"use strict";
const assert = require("node:assert/strict");
const dates = require("../src/prisma/services/purchasing/purchaseSuggestionDates");
const { readSuggestion, generateForRun } = require("../src/prisma/controllers/purchasing/PurchaseSuggestionController");
const day = value => value.toISOString().slice(0, 10);
async function main() {
  for (const [need, lead, expected] of [["2026-09-20", 5, "2026-09-15"], ["2026-09-20", 0, "2026-09-20"], ["2026-03-02", 5, "2026-02-25"], ["2028-03-01", 1, "2028-02-29"], ["2026-01-02", 5, "2025-12-28"], ["2026-09-20", 1.5, "2026-09-18"]]) {
    const result = dates.schedule({ materialRequiredDate: need, supplierLeadTimeDays: lead });
    assert.equal(day(result.latestPoDate), expected);
    assert.equal(day(result.supplierRequiredArrivalDate), need);
    assert.equal(result.source, dates.SOURCE);
    assert.equal(result.solver, undefined);
  }
  assert.throws(() => dates.schedule({ materialRequiredDate: "bad date" }), { code: "MRP_DELIVERY_NEED_MISSING" });
  assert.throws(() => dates.schedule({ materialRequiredDate: "2026-09-20", supplierLeadTimeDays: -1 }));
  const row = { id: "PSI-1", mrpRequirementId: "REQ-1", plannedOrderNumber: "PLN-1", partCode: "RAW", runNumber: "MRP-1", materialRequiredDate: "2026-08-01", recommendedOrderDate: "2026-07-01", customerDeliveryDate: "2026-10-01", purchasingLeadTimeDays: 5, sourceRequirements: [{ id: "REQ-1" }, { id: "MOQ", allocationType: "MOQ_PULL_FORWARD", requiredDate: "2026-08-01" }], supplierAllocations: [], productionLeadTimeBreakdown: { productionLeadTimeHours: 999, procurementPolicy: { safetyLeadTimeDays: 30 } } };
  const requirements = [{ id: "REQ-1", materialRequiredDate: "2026-09-20", requiredDate: "2026-09-21" }, { id: "MOQ", requiredDate: "2026-08-01" }];
  assert.equal(day(dates.itemDeliveryNeed(row, new Map(requirements.map(r => [r.id, r])))), "2026-09-20");
  assert.equal(day(dates.deliveryNeed([{ requiredDate: "2026-09-22" }, { requiredDate: "2026-09-20" }])), "2026-09-20");
  assert.equal(day(dates.itemDeliveryNeed({ plannedOrderNumber: "PLN-1" }, new Map(), new Map([["PLN-1", { requiredDate: "2026-09-20" }]]))), "2026-09-20");
  assert.throws(() => dates.itemDeliveryNeed({ materialRequiredDate: "2026-08-01" }, new Map()), { code: "MRP_DELIVERY_NEED_MISSING" }, "must not use an old BOM-calculated date when MRP source is missing");
  const fake = {
    purchaseSuggestion: { findFirst: async () => ({ suggestionNumber: "PS-1", runNumber: "MRP-1", items: [row] }) },
    mRPRequirement: { findMany: async ({ select }) => { if (!select.mbomDetailId) assert.ok(select.requiredDate && select.materialRequiredDate); return requirements; } },
    plannedOrder: { findMany: async () => [{ orderNumber: "PLN-1", requiredDate: "2026-09-20" }] },
    part: { findMany: async () => [] }, mRPRun: { findMany: async () => [] }, demandPlanningDecision: { findFirst: async () => null },
  };
  // No routing, capacity, BOM, or solver delegates: reading a suggestion must not recalculate production.
  const result = (await readSuggestion(fake, "PS-1")).items[0];
  assert.equal(day(result.materialRequiredDate), "2026-09-20");
  assert.equal(day(result.calculatedPurchaseDueDate), "2026-09-15");
  assert.equal(day(result.supplierRequiredArrivalDate), "2026-09-20");
  assert.equal(row.materialRequiredDate, "2026-08-01", "reading must not mutate the saved document");
  row.confirmedLeadTimeDays = 0;
  assert.equal(day((await readSuggestion(fake, "PS-1")).items[0].calculatedPurchaseDueDate), "2026-09-20");
  assert.equal(day(await dates.loadItemDeliveryNeed(fake, row)), "2026-09-20");
  const bom = { id: "S2", supplierCode: "S-2", supplierName: "BOM Supplier", leadTimeDays: 7 };
  requirements[0].mbomDetail = { supplierId: "S2", supplier: bom };
  const draftDb = { ...fake,
    supplier: { findFirst: async () => bom },
    part: { ...fake.part, findFirst: async () => ({ id: "RAW-ID" }) },
    supplierItem: { findMany: async () => [{ price: 200, leadTimeDays: 7 }] },
    partPriceList: { findMany: async () => [] }, materialPriceList: { findMany: async () => [] },
  };
  row.partId = "RAW-ID";
  row.suggestedSupplierCode = "S-1";
  const draft = (await readSuggestion(draftDb, "PS-1")).items[0];
  assert.equal(draft.suggestedSupplierCode, "S-2", "legacy unconfirmed suggestions show the BOM supplier");
  assert.equal(day(draft.calculatedPurchaseDueDate), "2026-09-13");
  row.confirmationStatus = "Confirmed";
  assert.equal((await readSuggestion(draftDb, "PS-1")).items[0].suggestedSupplierCode, "S-1", "confirmed suppliers must not be silently overwritten");
  row.suggestedSupplierName = "PT. Papajaya Agung";
  row.alternativeSupplierCode = "S006";
  draftDb.supplier.findMany = async () => [{ supplierCode: "S006", supplierName: "PT. Indometal Mitrabuana" }];
  const selected = (await readSuggestion(draftDb, "PS-1")).items[0];
  assert.equal(selected.effectiveSupplierCode, "S006");
  assert.equal(selected.effectiveSupplierName, "PT. Indometal Mitrabuana", "confirmed supplier code and name must match, not retain Papajaya's name");
  assert.equal(selected.suggestedSupplierName, "PT. Papajaya Agung", "original suggestion remains available for history");
  draftDb.supplier.findMany = async () => [];
  assert.equal((await readSuggestion(draftDb, "PS-1")).items[0].effectiveSupplierName, "S006", "missing supplier name must fall back to selected code, never another supplier's name");
  const empty = { findMany: async () => [] };
  const generated = await generateForRun({
    mRPRun: { findFirst: async () => ({ runNumber: "MRP-1", status: "Completed", scenarioStatus: "APPROVED", isCurrentPlan: true }) },
    purchaseSuggestion: { findFirst: async () => null, create: async ({ data }) => data },
    plannedOrder: { findMany: async () => [{ orderNumber: "PLN-1", partId: "RAW-ID", partCode: "RAW", qty: 10, qtyReleased: 0, uomCode: "PCS", requiredDate: new Date("2026-09-20"), part: { supplierItems: [
      { supplierId: "S1", leadTimeDays: 5, moq: 1, price: 100, supplier: { id: "S1", supplierCode: "S-1" } },
      { supplierId: "S2", leadTimeDays: 7, moq: 1, price: 200, supplier: { id: "S2", supplierCode: "S-2" } },
    ] } }] },
    mRPRequirement: { findMany: async () => [{ id: "REQ-1", partCode: "RAW", materialRequiredDate: new Date("2026-09-20"), requiredDate: new Date("2026-09-20"), grossRequirement: 10, netRequirement: 10, orderType: "Purchase", mbomDetail: { supplierId: "S2", supplier: { id: "S2", supplierCode: "S-2" } } }] },
    partPriceList: empty, materialPriceList: empty, stockBalance: empty, purchaseOrderDetail: empty,
  }, "MRP-1", "TEST");
  assert.equal(day(generated.items.create[0].materialRequiredDate), "2026-09-20");
  assert.equal(day(generated.items.create[0].recommendedOrderDate), "2026-09-13");
  assert.equal(generated.items.create[0].suggestedSupplierCode, "S-2", "BOM supplier overrides the preferred supplier item");
  assert.equal(generated.items.create[0].estimatedUnitPrice, 200, "price comes from the BOM supplier");
  assert.equal(generated.items.create[0].recommendedPurchaseQty, 10);
  console.log("PASS: MRP date source, calendar subtraction, zero/confirmed lead time, MOQ exclusion, missing source guard, and legacy detail recalculation without BOM/solver.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
