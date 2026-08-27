const fs = require("fs");
const path = require("path");
const assert = require("assert");

const root = path.resolve(__dirname, "..");
const {
  mergePrimaryAndSplitSupplierAllocations,
  sumSupplierAllocationQty,
} = require("../src/prisma/services/purchasing/purchaseSuggestionSupplierSplitService");

const allocations = mergePrimaryAndSplitSupplierAllocations({
  primaryAllocation: { supplierCode: "S007", confirmedQty: 100 },
  splitAllocations: [{ supplierCode: "S006", confirmedQty: 100 }],
});
assert.deepStrictEqual(allocations.map((row) => row.supplierCode), ["S007", "S006"]);
assert.strictEqual(sumSupplierAllocationQty(allocations), 200);

const deduplicated = mergePrimaryAndSplitSupplierAllocations({
  primaryAllocation: { supplierCode: "S007", confirmedQty: 100, deliveryDate: "2026-08-30" },
  splitAllocations: [{ supplierCode: "s007", confirmedQty: 100, deliveryDate: "2026-08-30" }],
});
assert.strictEqual(deduplicated.length, 1);
assert.strictEqual(sumSupplierAllocationQty(deduplicated), 100);

const splitDelivery = mergePrimaryAndSplitSupplierAllocations({
  primaryAllocation: { supplierCode: "S007", confirmedQty: 100, deliveryDate: "2026-08-30" },
  splitAllocations: [{ supplierCode: "s007", confirmedQty: 100, deliveryDate: "2026-09-06" }],
});
assert.strictEqual(splitDelivery.length, 2);
assert.strictEqual(sumSupplierAllocationQty(splitDelivery), 200);

const controller = fs.readFileSync(
  path.join(root, "src", "prisma", "controllers", "purchasing", "PurchaseSuggestionController.js"),
  "utf8",
);
const frontend = fs.readFileSync(
  path.join(root, "..", "frontend", "public", "js", "operations-detail.js"),
  "utf8",
);

assert(controller.includes("mergePrimaryAndSplitSupplierAllocations"));
assert(controller.includes("sumSupplierAllocationQty"));
assert(frontend.includes("primarySupplierAllocation"));
assert(frontend.includes("allConfirmedSupplierAllocations"));
assert(frontend.includes("data-add-delivery-split"));
assert(frontend.includes("refreshSupplierAllocationSummary"));
assert(frontend.includes("Supplier tambahan harus berbeda dari supplier utama"));

console.log("PASS supplier utama 100 + split supplier 100 menghasilkan dua allocation dengan total 200");
console.log("PASS supplier utama yang sudah ada di split tidak dihitung dua kali");
console.log("PASS supplier yang sama dengan delivery berbeda tetap dihitung sebagai split delivery");
console.log("PASS UI dan konversi PR memakai gabungan supplier utama + split");
console.log("PASS popup membedakan Tambah Supplier dan Split Delivery serta menampilkan total allocation");
