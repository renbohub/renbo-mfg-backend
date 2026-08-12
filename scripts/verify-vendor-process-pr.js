const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  capacityVendorPrMarker,
  capacityAllocationMarker,
  groupVendorAllocations,
  processMatches,
  effectiveVendorRate,
} = require("../src/prisma/services/planning/vendorProcessPrService");

let passed = 0;
function check(name, test) {
  try { test(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}`); throw error; }
}

check("marker links MPP and vendor", () => assert.equal(capacityVendorPrMarker("MPP-202608-001", "V001"), "[CAPACITY-VENDOR-PR:MPP-202608-001:V001]"));
check("marker links exact capacity allocation", () => assert.equal(capacityAllocationMarker("alloc-1"), "[CAPACITY-ALLOCATION:alloc-1]"));
check("group excludes non-vendor and zero quantity", () => {
  const groups = groupVendorAllocations([
    { id: "a", routingMode: "VENDOR", plannedQty: 12, vendor: { vendorCode: "V001" } },
    { id: "b", routingMode: "INHOUSE", plannedQty: 12, vendor: { vendorCode: "V001" } },
    { id: "c", routingMode: "VENDOR", plannedQty: 0, vendor: { vendorCode: "V002" } },
  ]);
  assert.deepEqual([...groups.keys()], ["V001"]);
  assert.equal(groups.get("V001").length, 1);
});
check("process matching accepts code or name", () => {
  assert(processMatches({ vendorProcessCode: "PAINT" }, { processCode: "PAINT" }));
  assert(processMatches({ vendorProcessName: "Painting" }, { processName: "Painting" }));
});
check("effective price uses month before base unit price", () => {
  const rate = effectiveVendorRate({ id: "pl", currencyCode: "IDR", details: [{ unitPrice: 10, august: 12, vendorProcessId: "vp", vendorProcess: { vendorProcessCode: "PAINT" } }] }, { processCode: "PAINT" }, new Date("2026-08-12T00:00:00Z"));
  assert.equal(rate.unitPrice, 12);
  assert.equal(rate.priceSource, "MONTH_AUGUST");
});
check("capacity controller synchronizes PR on create update remove auto and adoption", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/prisma/controllers/planning/MonthlyProductionPlanController.js"), "utf8");
  assert(source.includes("syncVendorProcessDraftPrForPlan"));
  assert((source.match(/syncVendorProcessDraftPrForPlan\(/g) || []).length >= 5);
});
check("PR confirmation supports vendorCode", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/prisma/controllers/purchasing/PurchaseRequisitionController.js"), "utf8");
  assert(source.includes("const vendorProcessPr"));
  assert(source.includes("vendorCode: row.vendorCode"));
});

console.log(`Vendor Process PR checks passed: ${passed}/7 cases`);
