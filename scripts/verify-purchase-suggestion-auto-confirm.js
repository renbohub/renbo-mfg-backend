"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { findPricedPurchaseSuggestionSupplierMaster } = require("../src/prisma/services/purchasing/purchaseSuggestionMasterDataService");

const backendRoot = path.resolve(__dirname, "..");
const workspaceRoot = path.resolve(backendRoot, "..");
const frontendRoot = path.join(workspaceRoot, "renbo-mfg-frontend");
const read = (...parts) => fs.readFileSync(path.join(...parts), "utf8");

const controller = read(backendRoot, "src", "prisma", "controllers", "purchasing", "PurchaseSuggestionController.js");
const routes = read(backendRoot, "src", "prisma", "routes", "purchasing", "purchase-suggestions.js");
const frontendRoutes = read(frontendRoot, "src", "routes", "modules.js");
const detailUi = read(frontendRoot, "public", "js", "operations-detail.js");

assert.match(routes, /auto-confirm-suppliers.*ctrl\.autoConfirmSuppliers/, "Route backend auto konfirmasi harus tersedia");
assert.match(frontendRoutes, /auto-confirm-suppliers.*proxyPageMutation/, "Proxy frontend auto konfirmasi harus tersedia");
assert.match(detailUi, /data-auto-confirm-suppliers/, "Tombol auto konfirmasi harus tampil di detail Purchase Suggestion");
assert.match(detailUi, /skippedWithoutPriceCount/, "UI harus melaporkan item tanpa harga yang dilewati");
assert.match(controller, /const confirmedQty = number\(item\.recommendedPurchaseQty\)/, "Confirmed qty harus berasal dari qty Purchase Suggestion");
assert.match(controller, /findPricedPurchaseSuggestionSupplierMaster\(tx, item/, "Auto confirm harus mencari supplier terkait yang mempunyai harga");
assert.match(controller, /const effectiveLeadTimeDays = 2/, "Lead time aktual auto confirm harus selalu 2 hari");
assert.match(controller, /item\.status === "Covered by MOQ"/, "Item yang sudah covered oleh MOQ tidak boleh dikonfirmasi ulang");
assert.ok(
  controller.indexOf('reasonCode === "PRICE_NOT_FOUND"') < controller.indexOf("res.json(result)"),
  "Hasil bulk harus menghitung item tanpa harga yang dilewati",
);

const suppliers = {
  S001: { id: "supplier-1", supplierCode: "S001", supplierName: "Supplier tanpa harga", leadTimeDays: 8, status: "Active", isDeleted: false },
  S002: { id: "supplier-2", supplierCode: "S002", supplierName: "Supplier dengan harga", leadTimeDays: 6, status: "Active", isDeleted: false },
};
const part = { id: "part-1", partCode: "PART-1", purchaseUomCode: "PCS", material: null };
const supplierItems = [
  { supplierId: "supplier-1", partId: part.id, isActive: true, isPreferred: true, priority: 1, price: null, supplier: suppliers.S001 },
  { supplierId: "supplier-2", partId: part.id, isActive: true, isPreferred: false, priority: 2, price: 12500, currencyCode: "IDR", supplier: suppliers.S002 },
];
const fakeDb = {
  supplier: { findFirst: async ({ where }) => Object.values(suppliers).find((row) => row.supplierCode === where.supplierCode) || null },
  part: { findFirst: async () => part },
  supplierItem: { findMany: async ({ where }) => where.supplierId ? supplierItems.filter((row) => row.supplierId === where.supplierId) : supplierItems },
  partPriceList: { findMany: async () => [] },
  materialPriceList: { findMany: async () => [] },
  mRPRequirement: { findMany: async () => [] },
};

async function run() {
  const found = await findPricedPurchaseSuggestionSupplierMaster(fakeDb, {
    partId: part.id,
    suggestedSupplierCode: "S001",
  }, { asOf: new Date("2026-08-28T00:00:00.000Z") });
  assert.strictEqual(found.master?.supplierCode, "S002", "Supplier suggestion tanpa harga harus dilewati dan supplier berharga dipilih");
  assert.strictEqual(found.master?.unitPrice, 12500);

  const noPriceDb = {
    ...fakeDb,
    supplierItem: { findMany: async ({ where }) => {
      const rows = supplierItems.map((row) => ({ ...row, price: null }));
      return where.supplierId ? rows.filter((row) => row.supplierId === where.supplierId) : rows;
    } },
  };
  const missing = await findPricedPurchaseSuggestionSupplierMaster(noPriceDb, {
    partId: part.id,
    suggestedSupplierCode: "S001",
  }, { asOf: new Date("2026-08-28T00:00:00.000Z") });
  assert.strictEqual(missing.master, null, "Item harus tetap tanpa konfirmasi jika semua supplier tidak mempunyai harga");
  console.log("Purchase Suggestion auto supplier confirmation: PASS");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
