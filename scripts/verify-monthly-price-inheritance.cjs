"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const pricing = require("../src/prisma/services/pricing/effectivePriceService");
const { calculateLiveMbomCosts } = require("../src/prisma/services/mbomLiveCostingService");
const { resolveVendorProcessPrice } = require("../src/prisma/services/pricing/vendorProcessPricingService");
const { resolvePurchaseSuggestionSupplierMaster, findPricedPurchaseSuggestionSupplierMaster } = require("../src/prisma/services/purchasing/purchaseSuggestionMasterDataService");
const annual = (months = {}) => pricing.normalizeMonthlyPriceInput({ pricingYear: 2026, january: 100, june: 120, september: 110, ...months });
const view = async (row, model = "partPriceList") => pricing.monthlyPriceView({ [model]: { findMany: async () => [row] } }, model, row);
const at = month => new Date(Date.UTC(2026, month, 15));

test("January and June carry through intervening months; explicit zero persists", () => {
  const row = annual({ september: null });
  assert.deepEqual(pricing.MONTH_FIELDS.map((_, index) => pricing.resolveEffectivePrice([row], at(index)).unitPrice), [100,100,100,100,100,120,120,120,120,120,120,120]);
  const free = annual({ june: 0 });
  assert.equal(pricing.resolveEffectivePrice([free], at(7)).unitPrice, 0);
  assert.equal(pricing.resolveEffectivePrice([free], at(8)).unitPrice, 110);
  assert.equal(pricing.nullablePriceValue({ january: null }, at(2)), null);
  assert.equal(pricing.resolveEffectiveRecord([{ id: "free", pricingYear: 2026, january: 0 }], at(2)).id, "free");
  assert.equal(pricing.resolveEffectiveRecord([{ pricingYear: 2026, january: 0, isActive: false }], at(2)), null);
});

test("monthly view retains sparse anchors and separates effective values and override flags", async () => {
  const row = { id: "price", updatedAt: new Date(), ...annual({ august: 120 }) };
  const plan = (await view(row)).monthlyPlan;
  assert.equal(plan.july, null); assert.equal(plan.monthlyResolved.july, 120);
  assert.equal(plan.monthlyOverrides.july, false); assert.equal(plan.monthlyOverrides.august, true);
  assert.equal(plan.august, 120); assert.equal(plan.september, 110);
  const dense = { id: "dense", updatedAt: new Date(), pricingYear: 2026, ...Object.fromEntries(pricing.MONTH_FIELDS.map((f, i) => [f, i < 5 ? 100 : i < 8 ? 120 : 110])) };
  const densePlan = (await view(dense)).monthlyPlan;
  assert.equal(densePlan.february, null); assert.equal(densePlan.june, 120); assert.equal(densePlan.september, 110);
});

test("edit June preserves January and later September; blank removes only its own override", async () => {
  const existing = await view({ id: "price", updatedAt: new Date(), ...annual() });
  const updated = pricing.normalizeMonthlyPriceInput({ june: 130 }, { existing });
  assert.equal(updated.january, 100); assert.equal(updated.june, 130); assert.equal(updated.september, 110);
  assert.equal(pricing.legacyPriceValue(updated, at(7)), 130); assert.equal(pricing.legacyPriceValue(updated, at(10)), 110);
  const cleared = pricing.normalizeMonthlyPriceInput({ june: " " }, { existing });
  assert.equal(cleared.june, null); assert.equal(pricing.legacyPriceValue(cleared, at(7)), 100);
  assert.equal(pricing.legacyPriceValue(cleared, at(10)), 110);
  assert.equal(updated.monthlyResolved, undefined); assert.equal(updated.sourceVersions, undefined);
  assert.throws(() => pricing.normalizeMonthlyPriceInput({ pricingYear: 2027 }, { existing }), /Tahun harga tidak dapat/);
});

test("strict payload validation rejects malformed/negative values, while zero-only prices work", () => {
  for (const value of [true, false, [], {}, "100bad", NaN, Infinity, -1]) {
    assert.throws(() => annual({ june: value }), error => error.statusCode === 400);
  }
  assert.equal(pricing.normalizeMonthlyPriceInput({ pricingYear: 2026, january: 0 }).january, 0);
  assert.throws(() => pricing.normalizeMonthlyPriceInput({ pricingYear: 2026, january: null }), /minimal/);
  assert.throws(() => pricing.normalizeMonthlyPriceInput({ pricingYear: 2026, details: [null] }, { vendor: true }), /Detail/);
});

test("vendor details preserve individual future overrides on partial edits", async () => {
  const row = { id: "vendorprice", vendorId: "vendor", category: "PROCESS", pricingYear: 2026, updatedAt: new Date(), details: [
    { vendorProcessId: "paint", january: 100, june: 120, september: 110, uomCode: "PCS" },
    { vendorProcessId: "inspect", january: 0, november: 10, uomCode: "PCS" },
  ] };
  const existing = await view(row, "vendorPriceList");
  const result = pricing.normalizeMonthlyPriceInput({ details: [{ vendorProcessId: "paint", june: 130 }, { vendorProcessId: "inspect" }] }, { vendor: true, existing });
  assert.equal(result.details[0].january, 100); assert.equal(result.details[0].september, 110);
  assert.equal(result.details[0].june, 130); assert.equal(result.details[0].uomCode, "PCS");
  assert.equal(result.details[1].january, 0); assert.equal(result.details[1].november, 10);
  assert.equal(result.details[0].monthlyResolved, undefined);
});

test("live BOM costing and vendor process costing accept a zero override without fallback", async () => {
  const row = { id: "price", partId: "part", supplierId: "supplier", currencyCode: "IDR", ...annual({ june: 0 }) };
  const db = {
    mBOMHeader: { findMany: async () => [{ id: "bom", partId: "fg", details: [{ id: "line", partId: "part", supplierId: "supplier", category: "Purchase", qty: 2, part: { id: "part", itemType: "RAW" }, mbomProcesses: [] }] }] },
    partPriceList: { findMany: async () => [row] }, materialPriceList: { findMany: async () => [] }, vendorPriceList: { findMany: async () => [] },
    machineCostRate: { findMany: async () => [] }, currency: { findMany: async () => [] },
  };
  const zero = (await calculateLiveMbomCosts(db, { costingDate: at(6) })).get("bom");
  assert.equal(zero.totalCost, 0); assert.equal(zero.covered, 1); assert.equal(zero.status, "LIVE ESTIMATE");
  assert.equal((await calculateLiveMbomCosts(db, { costingDate: at(9) })).get("bom").totalCost, 220);
  const vendorPrice = { id: "v", vendorId: "vendor", pricingYear: 2026, details: [{ january: 100, june: 0, vendorProcess: { vendorProcessCode: "PAINT" } }] };
  const vendor = resolveVendorProcessPrice({ vendorPrices: [vendorPrice], vendorId: "vendor", process: { processCode: "PAINT" }, costingDate: at(6) });
  assert.equal(vendor.unitPrice, 0); assert.equal(vendor.found, true);
});

test("purchase suggestion supplier pricing uses monthly zero and never accepts absent price as zero", async () => {
  let prices = [{ id: "price", partId: "part", supplierId: "supplier", ...annual({ june: 0 }) }];
  const db = {
    supplier: { findFirst: async () => ({ id: "supplier", supplierCode: "S1" }) },
    part: { findFirst: async () => ({ id: "part" }) },
    supplierItem: { findMany: async () => [] }, partPriceList: { findMany: async () => prices },
    materialPriceList: { findMany: async () => [] },
  };
  const item = { partId: "part", alternativeSupplierCode: "S1" };
  const master = await resolvePurchaseSuggestionSupplierMaster(db, item, "S1", { asOf: at(6) });
  assert.equal(master.unitPrice, 0); assert.equal(master.sources.price, "PART_PRICE_LIST");
  assert.equal((await findPricedPurchaseSuggestionSupplierMaster(db, item, { asOf: at(6) })).master.unitPrice, 0);
  prices = [];
  assert.equal((await findPricedPurchaseSuggestionSupplierMaster(db, item, { asOf: at(6) })).master, null);
});
