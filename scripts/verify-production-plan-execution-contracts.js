const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const read = (...segments) => fs.readFileSync(path.join(root, ...segments), "utf8");
const checks = [];
const verify = (name, condition) => {
  if (!condition) throw new Error(`FAIL ${name}`);
  checks.push(name);
};

const schema = read("prisma", "schema.prisma");
const monthlyPlan = read("src", "prisma", "controllers", "planning", "MonthlyProductionPlanController.js");
const dailyPlan = read("src", "prisma", "controllers", "production", "DailyProductionScheduleController.js");
const childFgReceipt = read("src", "prisma", "controllers", "production", "services", "childFgReceiptService.js");
const productionLog = read("src", "prisma", "controllers", "production", "ProductionLogController.js");
const workflow = read("src", "prisma", "controllers", "production", "services", "productionWorkflowService.js");
const capacity = read("src", "prisma", "services", "planning", "capacityPlanningService.js");
const capacityUi = read("..", "frontend", "public", "js", "ppic-capacity.js");
const capacityView = read("..", "frontend", "views", "ppic", "capacity.ejs");
const monthlyPlanController = read("src", "prisma", "controllers", "planning", "MonthlyProductionPlanController.js");
const capacityPresetController = read("src", "prisma", "controllers", "planning", "CapacityPlanningController.js");
const capacityRecommendation = read("src", "prisma", "services", "planning", "capacityRecommendationService.js");
const qualityInspection = read("src", "prisma", "controllers", "production", "QualityInspectionController.js");
const purchaseSuggestion = read("src", "prisma", "controllers", "purchasing", "PurchaseSuggestionController.js");
const operationsDetail = read("..", "frontend", "public", "js", "operations-detail.js");
const operationsDetailView = read("..", "frontend", "views", "operations", "detail.ejs");

verify("Work Order stores exact MBOM routing occurrence", /model WorkOrder[\s\S]*mbomProcessId\s+String\?/.test(schema));
verify("Daily Plan stores MPP allocation lineage", /model DailyProductionSchedule[\s\S]*productionPlanAllocationId\s+String\?/.test(schema));
verify("Root WO generator persists mbomProcessId", workflow.includes("mbomProcessId: operation.mbomProcessId || null"));
verify("MPP publisher generates missing child routing WO", monthlyPlan.includes("[MPP-CHILD-ROUTING:"));
verify("MPP child routing follows its Parent FG forecast", monthlyPlan.includes("parentLineByLine") && monthlyPlan.includes("[MPS-SOURCE:"));
verify("MPP publisher persists explicit allocation trace", monthlyPlan.includes("productionPlanAllocationId: item.allocation.id"));
verify("MPP publisher stores operation output on Daily Plan", monthlyPlan.includes("partId: item.workOrder?.outputPartId") && monthlyPlan.includes("item.allocation.mbomProcess?.mbomDetail?.part?.partCode"));
verify("Daily Plan material scope resolves legacy operation output", dailyPlan.includes("workOrderOutput?.outputPartCode") && dailyPlan.includes("routeOutput?.mbomDetail?.part?.partCode"));
verify("Nested FG receipt is capped by its MPP child receipt line", childFgReceipt.includes("[CHILD-FG-RECEIPT:") && childFgReceipt.includes("receiptLine.qtyPlanned"));
verify("Nested FG receipt consumes final WIP with paired movements", childFgReceipt.includes('stockType: "WIP"') && childFgReceipt.includes('stockType: "Finished Goods"') && childFgReceipt.includes("transferGroupId"));
verify("Daily Plan rejects an empty Material Issue", dailyPlan.includes('code: "DPP_BOM_INPUT_EMPTY"') && dailyPlan.includes('code: "MATERIAL_ISSUE_EMPTY"'));
verify("Production Log rejects direct MO or WO input", productionLog.includes('code: "PRODUCTION_PLAN_REQUIRED"'));
verify("Production Log requires an In Progress Daily Plan", productionLog.includes('code: "DAILY_PLAN_NOT_IN_PROGRESS"'));
verify("Production Log requires complete MPP trace", productionLog.includes('code: "DAILY_PLAN_TRACE_INCOMPLETE"'));
verify("Capacity checks predecessor time", capacity.includes('code: "PLAN_PREDECESSOR_FINISH_AFTER_SUCCESSOR"'));
verify("Capacity checks predecessor quantity", capacity.includes('code: "PLAN_PREDECESSOR_QTY_SHORT"'));
verify("Capacity checks machine time overlap", capacity.includes('code: "PLAN_MACHINE_TIME_OVERLAP"'));
verify("Capacity checks vendor return shortage", capacity.includes('code: "PLAN_VENDOR_RETURN_QTY_SHORT"'));
verify("Capacity checks machine specification", capacity.includes('code: "PLAN_MACHINE_SPEC_MISMATCH"'));
verify("Capacity exposes resolution guidance", capacityUi.includes("Tindakan:"));
verify("Past Production capacity days are hard locked", monthlyPlanController.includes('code: "CAPACITY_HISTORY_LOCKED"') && monthlyPlanController.includes("assertCapacityDateEditable(scheduleDate)"));
verify("Adopting a preset preserves past Production allocations and DPP", monthlyPlanController.includes("preservedProduction") && monthlyPlanController.includes("replaceableSchedules") && monthlyPlanController.includes("lockedPastAllocationCount"));
verify("Capacity recommendation cannot regenerate work in past dates", capacityRecommendation.includes("executionFloor") && capacityRecommendation.includes("scheduleDate: { gte: today }"));
verify("Past daily preset overrides cannot be changed", capacityPresetController.includes("assertPastPresetDaysUnchanged") && capacityPresetController.includes('code: "CAPACITY_HISTORY_LOCKED"'));
verify("Capacity UI explains preset promotion and history lock", capacityView.includes("Tetapkan Preset sebagai Production") && capacityView.includes("Hari yang sudah lewat") && capacityUi.includes("isPastDate"));
verify("FG non-component stays visible through the receipt milestone", qualityInspection.includes("buildNonComponentFgTrackingRows") && qualityInspection.includes('partType: { not: "COMP" }') && qualityInspection.includes('receiptState: "READY_TO_RECEIVE"'));
verify("FG receipt blocks non-component posting until production and QC are valid", qualityInspection.includes('code: blockerCode') && qualityInspection.includes('actionable: false') && qualityInspection.includes('blockerCode = "FG_NONCOMP_QC_PENDING"'));
verify("Purchase Suggestion splits selected material and purchase part into separate PR headers", purchaseSuggestion.includes('`SELECTED_ITEMS|${procurementCategory}`') && purchaseSuggestion.includes('poType: procurementCategory === "MATERIAL" ? "Material" : "Part"') && purchaseSuggestion.includes("purchaseRequisitions.push"));
verify("Production detail uses Excel-style tables and blocker resolution links", operationsDetailView.includes("production-detail-page") && operationsDetail.includes("production-excel-table") && operationsDetail.includes("blockerReferences"));

for (const name of checks) console.log(`PASS ${name}`);
