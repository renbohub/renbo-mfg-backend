const assert = require("assert");
const {
  resolveCommercialOrderQty,
  summarizePurchaseOrderAllocation,
} = require("../src/prisma/services/purchasing/purchaseOrderQuantityService");

assert.equal(resolveCommercialOrderQty({ commercialQty: 200, demandCoveredQty: 19.456068, outstandingQty: 200, activeAllocationCount: 1 }), 200);
assert.equal(resolveCommercialOrderQty({ commercialQty: null, demandCoveredQty: 19.456068, outstandingQty: 200, activeAllocationCount: 1 }), 200);
assert.equal(resolveCommercialOrderQty({ commercialQty: null, demandCoveredQty: 19.456068, outstandingQty: 200, activeAllocationCount: 2 }), 19.456068);

assert.deepEqual(summarizePurchaseOrderAllocation({
  poQty: 200,
  sources: [
    { qty: 20.789668, metadata: { demandCoveredQty: 10.789668, reservedAllocationQty: 10 } },
    { qty: 18.6664, metadata: { demandCoveredQty: 8.6664, reservedAllocationQty: 10 } },
  ],
}), { orderedQty: 200, demandQty: 19.456068, reserveQty: 20, moqBufferQty: 160.543932 });

console.log("Purchase Order MOQ quantity contracts: 4/4 PASS");
