const assert = require("assert");
const {
  resolveCommercialOrderQty,
  buildManualPrSourcingDecision,
  summarizePurchaseOrderAllocation,
} = require("../src/prisma/services/purchasing/purchaseOrderQuantityService");

assert.equal(resolveCommercialOrderQty({ commercialQty: 200, demandCoveredQty: 19.456068, outstandingQty: 200, activeAllocationCount: 1 }), 200);
assert.equal(resolveCommercialOrderQty({ commercialQty: null, demandCoveredQty: 19.456068, outstandingQty: 200, activeAllocationCount: 1 }), 200);
assert.equal(resolveCommercialOrderQty({ commercialQty: null, demandCoveredQty: 19.456068, outstandingQty: 200, activeAllocationCount: 2 }), 19.456068);

assert.deepEqual(buildManualPrSourcingDecision({
  detail: {
    qty: 396,
    orderedQty: 0,
    uomCode: "KG",
    proposedSupplierCode: "S007",
    purchasePackageQty: 3,
    purchasePackageUomCode: "COIL",
    conversionUomCode: "KG",
    conversionFactor: 132,
    convertedPurchaseQty: 396,
    width: 50,
    estimatedPrice: 150000,
    pr: { requiredDate: "2026-08-20" },
  },
}), {
  id: null,
  supplierCode: "S007",
  vendorCode: null,
  demandCoveredQty: 396,
  commercialQty: 396,
  demandUomCode: "KG",
  purchasePackageQty: 3,
  purchasePackageUomCode: "COIL",
  conversionFactor: 132,
  conversionUomCode: "KG",
  convertedPurchaseQty: 396,
  materialWidth: 50,
  materialLength: null,
  deliveryDate: "2026-08-20",
  currencyCode: "IDR",
  unitPrice: 150000,
  notes: "[MANUAL_PR_ADAPTER] Keputusan supplier dan bentuk diambil dari detail PR manual.",
});

assert.deepEqual(summarizePurchaseOrderAllocation({
  poQty: 200,
  sources: [
    { qty: 20.789668, metadata: { demandCoveredQty: 10.789668, reservedAllocationQty: 10 } },
    { qty: 18.6664, metadata: { demandCoveredQty: 8.6664, reservedAllocationQty: 10 } },
  ],
}), { orderedQty: 200, demandQty: 19.456068, reserveQty: 20, moqBufferQty: 160.543932 });

console.log("Purchase Order MOQ quantity contracts: 5/5 PASS");
