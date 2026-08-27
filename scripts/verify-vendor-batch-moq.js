"use strict";

const assert = require("assert");
const { validateVendorBatch, splitVendorQuantity } = require("../src/prisma/services/planning/vendorBatchPlanningService");

assert.deepStrictEqual(splitVendorQuantity(250, [100, 100, 50]), [100, 100, 50]);
assert.throws(() => validateVendorBatch({ qty: 40, minimumOrderQty: 50 }), /MOQ/i);
assert.throws(() => validateVendorBatch({ qty: 125, minimumOrderQty: 50, orderMultipleQty: 25.5 }), /kelipatan/i);
assert.doesNotThrow(() => validateVendorBatch({ qty: 125, minimumOrderQty: 50, orderMultipleQty: 25 }));
assert.throws(() => validateVendorBatch({ qty: 40, minimumOrderQty: 50, force: true }), /alasan/i);
assert.throws(() => validateVendorBatch({ qty: 40, minimumOrderQty: 50, force: true, reason: "Trial vendor", approvalStatus: "PENDING" }), /approval/i);
assert.doesNotThrow(() => validateVendorBatch({ qty: 40, minimumOrderQty: 50, force: true, reason: "Trial vendor", approvalStatus: "APPROVED" }));

console.log("Vendor batch MOQ contract passed.");
