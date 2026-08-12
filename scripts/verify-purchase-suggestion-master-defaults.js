"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  normalizePurchaseFormCode,
  resolveBomPurchaseDefaults,
  resolvePurchaseSuggestionSupplierMaster,
} = require("../src/prisma/services/purchasing/purchaseSuggestionMasterDataService");

const effectiveFrom = new Date("2026-08-01T00:00:00.000Z");
const effectiveUntil = new Date("2026-08-31T23:59:59.999Z");
const supplier = { id: "supplier-1", supplierCode: "S001", supplierName: "Supplier One", leadTimeDays: 9 };
const material = {
  id: "material-1",
  materialCode: "SPHC",
  materialSubstanceId: "substance-1",
  materialGradeId: "grade-1",
  thickness: 1.6,
  width: 100,
  materialForm: null,
  materialFormRef: null,
};
const part = { id: "part-1", partCode: "PART-1", purchaseUomCode: "KG", material };
const requirement = {
  id: "requirement-1",
  mbomDetailId: "detail-1",
  mbomDetail: {
    id: "detail-1",
    noReg: "MBOM-001",
    materialScheme: "DEFAULT",
    materialWidth: 50,
    materialForm: { formCode: "COIL", symbol: "C", defaultPurchaseUomCode: "COIL" },
    alternateMaterialForm: { formCode: "SHEET", symbol: "S", defaultPurchaseUomCode: "SHEET" },
  },
};

function fakeDb(options = {}) {
  return {
    supplier: { findFirst: async () => supplier },
    part: { findFirst: async () => part },
    supplierItem: { findMany: async () => options.supplierItems || [{
      supplierId: supplier.id,
      partId: part.id,
      isActive: true,
      isPreferred: true,
      priority: 1,
      leadTimeDays: 5,
      moq: 120,
      orderMultiple: 20,
      price: 9000,
      currencyCode: "IDR",
    }] },
    partPriceList: { findMany: async () => options.partPrices || [] },
    materialPriceList: { findMany: async () => options.materialPrices || [{
      id: "material-price-1",
      materialId: material.id,
      supplierId: supplier.id,
      unitPrice: 12500,
      currencyCode: "IDR",
      purchasePackageUomCode: "COIL",
      moq: 200,
      orderMultiple: 50,
      effectiveFrom,
      effectiveUntil,
      isActive: true,
      isDeleted: false,
      updatedAt: effectiveFrom,
    }] },
    mRPRequirement: { findMany: async () => [options.requirement || requirement] },
  };
}

async function run() {
  assert.strictEqual(normalizePurchaseFormCode("C"), "COIL");
  assert.strictEqual(normalizePurchaseFormCode({ formCode: "SHEET", symbol: "S" }), "SHEET");
  assert.deepStrictEqual(resolveBomPurchaseDefaults(requirement), {
    form: "COIL",
    width: 50,
    source: "MBOM_DEFAULT",
    materialScheme: "DEFAULT",
    mbomDetailId: "detail-1",
    mbomNumber: "MBOM-001",
  });

  const resolved = await resolvePurchaseSuggestionSupplierMaster(fakeDb(), {
    partId: part.id,
    materialId: material.id,
    mrpRequirementId: requirement.id,
    sourceRequirements: [{ id: requirement.id }],
  }, supplier.supplierCode, { asOf: new Date("2026-08-12T00:00:00.000Z") });
  assert.strictEqual(resolved.moq, 200, "MOQ harus memprioritaskan Material Price List aktif");
  assert.strictEqual(resolved.orderMultiple, 50);
  assert.strictEqual(resolved.unitPrice, 12500);
  assert.strictEqual(resolved.leadTimeDays, 5);
  assert.strictEqual(resolved.purchasePackageUomCode, "COIL", "Bentuk BOM harus mengalahkan packaging price list");
  assert.strictEqual(resolved.materialWidth, 50);
  assert.strictEqual(resolved.sources.form, "MBOM_DEFAULT");
  assert.strictEqual(resolved.sources.price, "MATERIAL_PRICE_LIST");

  const alternativeRequirement = {
    ...requirement,
    mbomDetail: { ...requirement.mbomDetail, materialScheme: "ALTERNATIVE" },
  };
  const alternative = await resolvePurchaseSuggestionSupplierMaster(fakeDb({ requirement: alternativeRequirement }), {
    partId: part.id,
    materialId: material.id,
    mrpRequirementId: requirement.id,
  }, supplier.supplierCode, { asOf: new Date("2026-08-12T00:00:00.000Z") });
  assert.strictEqual(alternative.purchasePackageUomCode, "SHEET");
  assert.strictEqual(alternative.sources.form, "MBOM_ALTERNATIVE");

  const frontend = fs.readFileSync(path.resolve(__dirname, "../../frontend/public/js/operations-detail.js"), "utf8");
  assert.match(frontend, /lookupSuggestionSupplierMaster/);
  assert.match(frontend, /data-confirm-moq-source/);
  assert.match(frontend, /bomDefaultPurchaseForm/);
  assert.match(frontend, /supplier-master\?/);
  console.log("Purchase Suggestion supplier master defaults: PASS");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
