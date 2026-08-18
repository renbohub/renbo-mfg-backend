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
const {
  capacityDetailAppliesToJob,
  capacityTaskBatchQuantity,
  buildPriorCampaignCompletionByPhase,
} = require("../src/prisma/services/planning/capacityRecommendationService");

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
check("auto recommendation synchronizes current MPS/MRP snapshot before capacity allocation", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/prisma/controllers/planning/MonthlyProductionPlanController.js"), "utf8");
  const syncCall = source.indexOf("const sourcePlanSync = await syncDraftPlanWithCurrentMps");
  const recommendationCall = source.indexOf("const recommendation = await recommendMonthlyCapacity", syncCall);
  assert(syncCall >= 0, "Capacity recommendation harus menyinkronkan detail MPP Draft dari MPS current");
  assert(recommendationCall > syncCall, "Sinkronisasi MPS→MPP harus selesai sebelum graph capacity dibentuk");
  assert(source.includes("sourceMrpRunNumber: completedMrp.runNumber"), "Audit sync harus menyimpan MRP run sumber");
  assert(source.includes("createdPartCodes"), "Audit sync harus mencatat part baru seperti Painting");
  assert(source.includes("splitPlanDetailsByMrpExecutionMonth"), "MPP harus dipecah memakai order date hasil netting MRP");
  assert(source.includes("[MRP-TARGET:"), "Baris MPP process harus menyimpan target delivery sumber formula");
  assert(source.includes("[MRP-ORDER-MONTH:"), "Baris MPP process harus menyimpan bucket execution month");
});

check("capacity applies MRP process only to its pegged delivery target", () => {
  const detail = { notes: "[MRP-PRODUCTION] [MRP-TARGET:target-14]" };
  assert(capacityDetailAppliesToJob(detail, { sourceDeliveryTargetId: "target-14" }));
  assert(!capacityDetailAppliesToJob(detail, { sourceDeliveryTargetId: "target-12" }));
  assert(capacityDetailAppliesToJob({ notes: "[MRP-PRODUCTION]" }, { sourceDeliveryTargetId: "target-12" }));
});

check("phase scoped batch quantity ignores prior delivery cumulative quantity", () => {
  const task = { phasePlannedQty: 40, phaseReceiptQty: 20, detail: { qtyPlanned: 40, uomCode: "PCS" } };
  assert.equal(capacityTaskBatchQuantity(task, 10, 200, 443, 200), 20);
  assert.equal(capacityTaskBatchQuantity(task, 10, 210, 443, 200), 20);
});

check("prior month vendor return becomes next month execution gate", () => {
  const gates = buildPriorCampaignCompletionByPhase(new Date("2026-09-01T00:00:00Z"), [
    {
      id: "paint-aug", deliveryPhaseId: "phase-6", routingMode: "VENDOR",
      scheduleDate: new Date("2026-08-28T00:00:00Z"), vendorReturnDate: new Date("2026-09-02T00:00:00Z"), plannedEndTime: "00:00",
    },
    {
      id: "old-inhouse", deliveryPhaseId: "phase-6", routingMode: "INHOUSE",
      scheduleDate: new Date("2026-09-01T00:00:00Z"), plannedEndTime: "10:00",
    },
  ]);
  assert.equal(gates.get("PHASE:phase-6").minute, 1440);
  assert.deepEqual(gates.get("PHASE:phase-6").allocationIds, ["paint-aug"]);
});

check("FG receipt is split by independent MRP target and supports receipt milestone", () => {
  const controller = fs.readFileSync(path.join(__dirname, "../src/prisma/controllers/planning/MonthlyProductionPlanController.js"), "utf8");
  const capacity = fs.readFileSync(path.join(__dirname, "../src/prisma/services/planning/capacityRecommendationService.js"), "utf8");
  assert(controller.includes('requirementType: { in: ["Independent", "Dependent"] }'));
  assert(controller.includes("detailSourceId(detail)"));
  assert(capacity.includes('capacityMode: "FG_RECEIPT_MILESTONE"'));
});


console.log(`Vendor Process PR checks passed: ${passed}/12 cases`);
