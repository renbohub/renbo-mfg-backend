"use strict";
const assert = require("node:assert/strict");
const { procurementWeek, groupWeeklyPurchases } = require("../src/prisma/services/planning/weeklyProcurementService");
assert.deepEqual(procurementWeek("2026-09-06"), { key: "2026-08-31", startDate: "2026-08-31", endDate: "2026-09-06" });
assert.equal(procurementWeek("2026-09-07").key, "2026-09-07");
assert.equal(procurementWeek("2027-01-01").key, "2026-12-28");
assert.throws(() => procurementWeek(null), /wajib valid/);
const base = { orderType: "Purchase", partCode: "MAT1", uomCode: "KG", status: "Planned", qty: 10 };
const orders = [
  { ...base, orderNumber: "PO1", requiredDate: "2026-09-01", orderDate: "2026-08-20" },
  { ...base, orderNumber: "PO2", requiredDate: "2026-09-05", orderDate: "2026-08-25" },
  { ...base, orderNumber: "PO3", requiredDate: "2026-09-07", orderDate: "2026-09-01" },
  { ...base, orderNumber: "PO4", requiredDate: "2026-09-01", uomCode: "PCS" },
  { ...base, orderNumber: "PO5", requiredDate: "2026-09-01", supplierCode: "S1" },
  { ...base, orderNumber: "IGNORE", requiredDate: "2026-09-01", orderType: "Manufacture" },
];
const snapshot = JSON.stringify(orders);
const groups = groupWeeklyPurchases([...orders, orders[0]]);
assert.equal(groups.length, 4); assert.equal(groups.reduce((n, g) => n + g.qty, 0), 50);
const consolidated = groups.find((g) => g.orders.length === 2);
assert.equal(consolidated.qty, 20); assert.equal(consolidated.earliestRequiredDate, "2026-09-01"); assert.equal(consolidated.earliestOrderDate, "2026-08-20");
assert.deepEqual(consolidated.orders.map((r) => r.orderNumber), ["PO1", "PO2"]);
assert.equal(JSON.stringify(orders), snapshot, "grouping must preserve exact solver dates/quantities");
console.log("Weekly purchasing: month/year boundaries, units/suppliers, exact dates, source trace and deduplication PASS");
