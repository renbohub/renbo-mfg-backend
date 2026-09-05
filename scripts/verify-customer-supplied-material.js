"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  SUPPLIER_PURCHASE,
  CUSTOMER_SUPPLIED,
  normalizeMaterialSupplyType,
  isCustomerSupplied,
} = require("../src/prisma/utils/materialSupply");
const { consolidateRequirements } = require("../src/prisma/services/planning/demandPlanningService");

assert.equal(normalizeMaterialSupplyType(), SUPPLIER_PURCHASE);
assert.equal(normalizeMaterialSupplyType("customer_supplied"), CUSTOMER_SUPPLIED);
assert.equal(isCustomerSupplied(CUSTOMER_SUPPLIED), true);

const dueDate = new Date("2026-09-10T00:00:00.000Z");
const rows = consolidateRequirements([
  {
    partCode: "RM-CUSTOMER",
    materialSupplyType: CUSTOMER_SUPPLIED,
    supplyCustomerCode: "C003",
    requiredDate: dueDate,
    qty: 100,
    onHandQty: 20,
  },
  {
    partCode: "RM-SUPPLIER",
    materialSupplyType: SUPPLIER_PURCHASE,
    supplierCode: "S003",
    requiredDate: dueDate,
    qty: 100,
    onHandQty: 20,
  },
]);

const customerMaterial = rows.find((row) => row.partCode === "RM-CUSTOMER");
const supplierMaterial = rows.find((row) => row.partCode === "RM-SUPPLIER");
assert.equal(customerMaterial.shortageQty, 80);
assert.equal(customerMaterial.suggestedOrderQty, 0);
assert.equal(supplierMaterial.shortageQty, 80);
assert.equal(supplierMaterial.suggestedOrderQty, 80);

const root = path.join(__dirname, "..");
const mrp = fs.readFileSync(path.join(root, "src/prisma/controllers/planning/MRPController.js"), "utf8");
const bom = fs.readFileSync(path.join(root, "src/prisma/controllers/mbom/BOMController.js"), "utf8");
const editor = fs.readFileSync(path.join(root, "../frontend/public/js/bom-table-editor.js"), "utf8");
assert.match(mrp, /CUSTOMER_SUPPLIED_BOM/);
assert.match(mrp, /plannedOrderQty = customerSupplied \? 0/);
assert.match(bom, /Customer pemasok material wajib dipilih/);
assert.match(editor, /Beli ke supplier/);
assert.match(editor, /Disuplai customer/);
assert.match(editor, /tidak dibuat Purchase Suggestion \/ PR \/ PO/);

console.log("Customer supplied material contracts PASS");
