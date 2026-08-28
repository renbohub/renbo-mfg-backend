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
const productionNgDisposition = read("src", "prisma", "controllers", "production", "ProductionNgDispositionController.js");
const materialIssue = read("src", "prisma", "controllers", "production", "MaterialIssueController.js");
const workflow = read("src", "prisma", "controllers", "production", "services", "productionWorkflowService.js");
const capacity = read("src", "prisma", "services", "planning", "capacityPlanningService.js");
const capacityUi = read("..", "renbo-mfg-frontend", "public", "js", "ppic-capacity.js");
const capacityView = read("..", "renbo-mfg-frontend", "views", "ppic", "capacity.ejs");
const monthlyPlanController = read("src", "prisma", "controllers", "planning", "MonthlyProductionPlanController.js");
const capacityPresetController = read("src", "prisma", "controllers", "planning", "CapacityPlanningController.js");
const capacityPresetService = read("src", "prisma", "services", "planning", "capacitySimulationPresetService.js");
const capacityRecommendation = read("src", "prisma", "services", "planning", "capacityRecommendationService.js");
const qualityInspection = read("src", "prisma", "controllers", "production", "QualityInspectionController.js");
const purchaseSuggestion = read("src", "prisma", "controllers", "purchasing", "PurchaseSuggestionController.js");
const purchaseRequisition = read("src", "prisma", "controllers", "purchasing", "PurchaseRequisitionController.js");
const supplyChainRead = read("src", "prisma", "controllers", "supply-chain", "SupplyChainReadController.js");
const vendorProcessOrder = read("src", "prisma", "controllers", "production", "VendorProcessOrderController.js");
const outgoingTransaction = read("src", "prisma", "controllers", "outgoing", "OutgoingTransactionController.js");
const deliveryReadiness = read("src", "prisma", "services", "outgoing", "deliveryReadinessService.js");
const operationsDetail = read("..", "renbo-mfg-frontend", "public", "js", "operations-detail.js");
const operationsDetailView = read("..", "renbo-mfg-frontend", "views", "operations", "detail.ejs");
const operationsDashboardView = read("..", "renbo-mfg-frontend", "views", "operations", "dashboard.ejs");
const productionScheduleForm = read("..", "renbo-mfg-frontend", "public", "js", "production-schedule-form.js");
const productionScheduleView = read("..", "renbo-mfg-frontend", "views", "production", "schedule-form.ejs");
const numberingService = read("src", "prisma", "services", "numberingService.js");
const fgReceiptView = read("..", "renbo-mfg-frontend", "views", "production", "fg-receipt.ejs");
const productionLogForm = read("..", "renbo-mfg-frontend", "public", "js", "production-log-form.js");
const productionLogView = read("..", "renbo-mfg-frontend", "views", "production", "log-form.ejs");
const moduleRegistry = read("..", "renbo-mfg-frontend", "src", "moduleRegistry.js");
const operationsDashboard = read("..", "renbo-mfg-frontend", "public", "js", "operations-dashboard.js");
const incomingController = read("src", "prisma", "controllers", "incoming", "IncomingTransactionController.js");
const incomingForm = read("..", "renbo-mfg-frontend", "public", "js", "supply-chain-form.js");
const shortfallCarryover = read("src", "prisma", "services", "planning", "productionShortfallCarryoverService.js");
const diesCapacity = read("src", "prisma", "services", "planning", "diesCapacityService.js");
const {
  intervalsOverlap,
  isDiesCapacityBlockingEnabled,
  isPressResource,
  plannedInterval,
} = require("../src/prisma/services/planning/diesCapacityService");
const { capacityOperationCode } = require("../src/prisma/services/planning/capacityPlanningService");

verify("Work Order stores exact MBOM routing occurrence", /model WorkOrder[\s\S]*mbomProcessId\s+String\?/.test(schema));
verify("Daily Plan stores MPP allocation lineage", /model DailyProductionSchedule[\s\S]*productionPlanAllocationId\s+String\?/.test(schema));
verify("Daily Plan carries process time and delivery phase", /model DailyProductionSchedule[\s\S]*plannedStartTime\s+String\?[\s\S]*deliveryPhaseNumber\s+Int\?/.test(schema) && monthlyPlan.includes("plannedStartTime: item.allocation.plannedStartTime"));
verify("Allocation and Daily Plan persist Dies capacity lineage", /model ProductionPlanAllocation[\s\S]*diesId\s+String\?/.test(schema) && /model DailyProductionSchedule[\s\S]*diesId\s+String\?/.test(schema) && monthlyPlan.includes("item.allocation.diesId"));
verify("Root WO generator persists mbomProcessId", workflow.includes("mbomProcessId: operation.mbomProcessId || null"));
verify("MPP publisher generates missing child routing WO", monthlyPlan.includes("[MPP-CHILD-ROUTING:"));
verify("MPP child routing follows its Parent FG forecast", monthlyPlan.includes("parentLineByLine") && monthlyPlan.includes("[MPS-SOURCE:"));
verify("MPP publisher persists explicit allocation trace", monthlyPlan.includes("productionPlanAllocationId: item.allocation.id"));
verify("MPP publisher stores operation output on Daily Plan", monthlyPlan.includes("partId: item.workOrder?.outputPartId") && monthlyPlan.includes("item.allocation.mbomProcess?.mbomDetail?.part?.partCode"));
verify("Daily Plan material scope resolves legacy operation output", dailyPlan.includes("workOrderOutput?.outputPartCode") && dailyPlan.includes("routeOutput?.mbomDetail?.part?.partCode"));
verify("Nested FG receipt is capped by its MPP child receipt line", childFgReceipt.includes("[CHILD-FG-RECEIPT:") && childFgReceipt.includes("receiptLine.qtyPlanned"));
verify("Nested FG receipt consumes final WIP with paired movements", childFgReceipt.includes('stockType: "WIP"') && childFgReceipt.includes('stockType: "Finished Goods"') && childFgReceipt.includes("transferGroupId"));
verify("Daily Plan rejects an empty Material Issue", dailyPlan.includes('code: "DPP_BOM_INPUT_EMPTY"') && dailyPlan.includes('code: "MATERIAL_ISSUE_EMPTY"'));
verify("Rework Daily Plan bypasses MPP and new Material Issue gates only for rework WO", dailyPlan.includes("isReworkSchedule") && dailyPlan.includes("reworkNoMaterialIssue") && dailyPlan.includes('referencedWorkOrder?.isReworkOrder === true') && productionLog.includes('scheduleWorkOrder?.isReworkOrder === true'));
verify("In Progress Daily Plan can be revised without overwriting actual output", dailyPlan.includes('["Draft", "Released", "In Progress"].includes(existing.status)') && dailyPlan.includes("plannedQty + 0.000001 < executedQty") && !/exports\.update[\s\S]*body\.actualQty[\s\S]*dailyProductionSchedule\.update/.test(dailyPlan));
verify("Daily Plan revision form loads and patches an existing command", productionScheduleForm.includes('config.mode === "edit"') && productionScheduleForm.includes('method: editing ? "PATCH" : "POST"') && productionScheduleView.includes("Simpan Revisi"));
verify("Manual Daily Plan tolerates a missing MBOM routing occurrence", capacityOperationCode(null) === null && capacityOperationCode({ processCode: "WELD" }) === "WELD");
verify("Production Log rejects direct MO or WO input", productionLog.includes('code: "PRODUCTION_PLAN_REQUIRED"'));
verify(
  "Monthly Production Plan accepts every MPS month covered by one rolling MRP cycle",
  monthlyPlan.includes("completedMrpCandidates")
    && monthlyPlan.includes("scenarioAssumptions?.sourceMpsNumbers")
    && monthlyPlan.includes("sourceMpsNumbers.includes(mpsNumber)"),
);
verify("Draft MPP survives MRP-generated id changes", monthlyPlan.includes("stableMpsPlanDetailMatch") && monthlyPlan.includes("sourceMpsDetailId(existingDetail)"));
verify("MPP creation identifies the source-month receipt plan as primary", monthlyPlan.includes("primaryPlanNumber") && monthlyPlan.includes("receiptLineCount"));
verify("MPP detail read preserves MRP-netted production quantity", monthlyPlan.includes("Keep the persisted MPP execution quantity") && !monthlyPlan.slice(monthlyPlan.indexOf("async function withMpsSnapshot"), monthlyPlan.indexOf("async function withManufacturingOrderTrace")).includes("synced.qtyPlanned = Math.max"));
verify("Monthly Planning keeps overload in its owner month", monthlyPlan.includes('overloadHandling: "QUEUE_IN_OWNER_MONTH"') && monthlyPlan.includes("automaticMonthOffset: false"));
verify("Monthly Planning exposes separate INHOUSE and VENDOR operation views", operationsDetail.includes("monthlyPlanRoutingTablesCard") && operationsDetail.includes('table("INHOUSE"') && operationsDetail.includes('table("VENDOR"'));
verify("Production Log requires an In Progress Daily Plan", productionLog.includes('code: "DAILY_PLAN_NOT_IN_PROGRESS"'));
verify("Daily Production Schedule stays Draft while stock is incomplete", dailyPlan.includes('code: "DPP_STOCK_NOT_READY"') && dailyPlan.includes("Daily Production Schedule tetap Draft"));
verify("Production Log requires complete MPP trace", productionLog.includes('code: "DAILY_PLAN_TRACE_INCOMPLETE"'));
verify("Capacity checks the two-hour predecessor gap", capacity.includes('code: "PLAN_PREDECESSOR_GAP_SHORT"') && capacity.includes("MINIMUM_SUCCESSOR_GAP_MINUTES = 120"));
verify("Capacity checks predecessor quantity", capacity.includes('code: "PLAN_PREDECESSOR_QTY_SHORT"'));
verify("Capacity checks machine time overlap", capacity.includes('code: "PLAN_MACHINE_TIME_OVERLAP"'));
verify("Capacity blocks overlapping Dies across machines", capacity.includes('code: "PLAN_DIES_TIME_OVERLAP"') && capacity.includes('category: "DIES"'));
verify("Dies blocker is feature-flagged off for simulation", diesCapacity.includes('DIES_CAPACITY_BLOCKING_ENABLED || "false"') && !isDiesCapacityBlockingEnabled());
verify("Configured Dies remains capacity validated", capacity.includes('code: "PLAN_DIES_TIME_OVERLAP"') && diesCapacity.includes('PLAN_DIES_MACHINE_TONNAGE_MISMATCH'));
verify("Dies intervals handle overnight schedules", intervalsOverlap(plannedInterval("2026-08-07", "23:00", "01:00"), plannedInterval("2026-08-08", "00:30", "02:00")));
verify("Press machines are recognized as Dies consumers", isPressResource({ machineFamily: "PRESS" }, {}));
verify("Capacity checks vendor return shortage", capacity.includes('code: "PLAN_VENDOR_RETURN_QTY_SHORT"'));
verify("Capacity checks machine specification", capacity.includes('code: "PLAN_MACHINE_SPEC_MISMATCH"'));
verify("Capacity exposes resolution guidance", capacityUi.includes("Tindakan:"));
verify("MPP release uses authoritative capacity settings", !monthlyPlanController
  .slice(monthlyPlanController.indexOf("exports.release ="), monthlyPlanController.indexOf("exports.convertToDailyPlans ="))
  .includes("...(req.body || {})")
  && !operationsDetail.includes("requestBody = { shiftHours: 8, shiftsPerDay: 1, efficiencyPercent: 85 }"));
verify("Past Production capacity days are hard locked", monthlyPlanController.includes('code: "CAPACITY_HISTORY_LOCKED"') && monthlyPlanController.includes("assertCapacityDateEditable(scheduleDate)"));
verify("Adopting a preset preserves past Production allocations and DPP", monthlyPlanController.includes("preservedProduction") && monthlyPlanController.includes("replaceableSchedules") && monthlyPlanController.includes("lockedPastAllocationCount"));
verify("Capacity recommendation replaces stale Draft proposals but cannot regenerate work in past dates", capacityRecommendation.includes("executionFloor") && capacityRecommendation.includes('if (row?.status === "Draft") return true') && capacityRecommendation.includes("return !scheduleDate || scheduleDate >= today") && capacityRecommendation.includes("replaceableIds"));
verify("In Progress MPP replans only unexecuted Draft capacity", capacityRecommendation.includes('const allowedStatuses = ["Draft", "Confirmed", "Released", "In Progress"]') && capacityRecommendation.includes("firmAllocationIds") && capacityRecommendation.includes('status: "Draft"'));
verify("Capacity preset adoption preserves completed DPP", monthlyPlanController.includes("firmSchedules") && monthlyPlanController.includes("preservedCompletedDppCount") && monthlyPlanController.includes('row.status === "Completed"'));
verify("Past daily preset overrides cannot be changed", capacityPresetController.includes("assertPastPresetDaysUnchanged") && capacityPresetController.includes('code: "CAPACITY_HISTORY_LOCKED"'));
verify("Capacity UI exposes Current Use promotion and enforces past-date lock", capacityView.includes("Tetapkan sebagai Current Use") && capacityView.includes("capacity-production-guide-lock") && capacityUi.includes("isPastDate"));
verify("Capacity keeps exactly one Current Use preset", capacityPresetService.includes("CAPACITY_CURRENT_USE_PRESET_V1") && capacityPresetService.includes("activatePreset") && capacityPresetController.includes("currentPresetId"));
verify("Auto recommendation supports the two primary algorithms", capacityRecommendation.includes("FULL_COMPLETION_SEQUENCE") && capacityRecommendation.includes("SHIFT_CAPACITY_TRANSFER") && capacityRecommendation.includes("shiftCapacityTransferQuantity"));
verify("Auto recommendation keeps each process whole when its own slot fits", capacityRecommendation.includes("scheduleFitFirstPerRoute") && capacityRecommendation.includes("const fullPlacement") && capacityRecommendation.includes("qty: totalQty"));
verify("Auto recommendation jointly occupies machine and Dies", capacityRecommendation.includes("trialDiesUsage") && capacityRecommendation.includes("occupyDies") && capacityRecommendation.includes("diesId: item.dies?.id"));
verify("Shift transfer follows predecessor batches", capacityRecommendation.includes("predecessorDraftIndexes") && capacityRecommendation.includes("transferBatchNumber"));
verify("Delivery coverage includes published recommendation output", capacity.includes('["Draft", "Published"].includes(allocation.status)') && capacity.includes("terminalAllocationByBatch") && capacity.includes("Math.max(firmQtyByDueDate, autoTerminalQtyByDueDate)"));
verify("Buffer production is due at month end after delivery phases", capacityRecommendation.includes('due: plan.periodEnd') && capacityRecommendation.includes('targetCode: "BUFFER_STOCK"'));
verify("Capacity allocation supports time editing and drag move", capacityView.includes("capacity-manual-start") && capacityUi.includes("data-drag-allocation") && capacityUi.includes('plannedStartTime: routingMode === "INHOUSE"'));
verify("Capacity allocation exposes Dies secondary resource", capacityView.includes("capacity-manual-dies") && capacityUi.includes('diesId: routingMode === "INHOUSE"'));
verify("Daily schedule renders separate machine tables", operationsDashboardView.includes("daily-machine-tables") && operationsDashboard.includes("renderDailyMachineTables"));
verify("FG non-component stays visible through the receipt milestone", qualityInspection.includes("buildNonComponentFgTrackingRows") && qualityInspection.includes('partType: { not: "COMP" }') && qualityInspection.includes('receiptState: "READY_TO_RECEIVE"'));
verify("FG receipt blocks non-component posting until production and QC are valid", qualityInspection.includes('code: blockerCode') && qualityInspection.includes('actionable: false') && qualityInspection.includes('blockerCode = "FG_NONCOMP_QC_PENDING"'));
verify("Purchase Suggestion splits Select All by PR category and supplier", purchaseSuggestion.includes('const key = `${prCategory.code}|${supplierCode}`') && purchaseSuggestion.includes("prCategoryLabel: prCategory.label") && purchaseSuggestion.includes("supplierCode,") && purchaseSuggestion.includes("purchaseRequisitions.push"));
verify("Purchase Suggestion exposes all governed PR categories", ["PR-Asset", "PR-Consumable", "PR-Maintenance", "PR-Raw_Material", "PR-Purchase-Part", "PR-Vendor-Proses", "PR-Services", "PR-Other"].every((label) => purchaseSuggestion.includes(label)));
verify("Purchase Suggestion Select All previews category and supplier split", operationsDetail.includes("data-ps-select-all") && operationsDetail.includes("data-pr-suppliers") && operationsDetail.includes("PR Category × Supplier") && operationsDetail.includes("prGroups.size"));
verify("Purchase Suggestion keeps one active document per planning header", purchaseSuggestion.includes("archiveSupersededSuggestionsForRun") && purchaseSuggestion.includes("siblingRunNumbers") && purchaseSuggestion.includes("isCurrentPlan: true"));
verify("Purchase Suggestion enforces confirmed MOQ and order multiple before PR", purchaseSuggestion.includes("normalizedConfirmedQty = roundedPurchaseQty") && purchaseSuggestion.includes("roundedPurchaseQty(allocation.confirmedQty, allocation.moq, allocation.orderMultiple)") && purchaseSuggestion.includes("roundedPurchaseQty(requestedAllocationQty, allocation.moq, allocation.orderMultiple)"));
verify("Purchase Suggestion confirmation opens in a dedicated modal", operationsDetail.includes("openSuggestionConfirmationModal") && operationsDetail.includes("ps-confirmation-modal") && !operationsDetail.includes('class="ps-editor-row d-none"'));
verify("Purchase Suggestion confirmation saves in place without closing or reloading the detail page", operationsDetail.includes("refreshPurchaseSuggestionAfterConfirmation") && operationsDetail.includes("Dialog tetap terbuka") && !operationsDetail.includes('saveSuggestionButton.closest(".ps-confirmation-backdrop")?.remove()'));
verify("All Purchasing details share the Purchase Suggestion visual workspace", operationsDetailView.includes("purchasing-detail-page"));
verify("Purchase Suggestion list remains the standard table-only view", !operationsDashboardView.includes("ps-list-overview") && !operationsDashboardView.includes("purchase-suggestion-list-page"));
verify("Material form and alternate width are confirmed before PR", purchaseSuggestion.includes("confirmedMaterialWidth") && purchaseSuggestion.includes("purchasePackageUomCode") && purchaseSuggestion.includes("materialWidth: materialWidth || null"));
verify("Sheet length is entered manually and propagated to PO", schema.includes("confirmedMaterialLength") && operationsDetail.includes("data-confirm-length") && operationsDetail.includes("data-po-length") && purchaseSuggestion.includes("panjang sheet harus diisi") && purchaseRequisition.includes("materialLength: row.materialLength"));
verify("Purchase Suggestion explains smart backward-scheduled due dates", operationsDetail.includes("data-due-calculation") && operationsDetail.includes("Lead Time Proses BOM") && operationsDetail.includes("Jadwal SO/Forecast paling awal") && purchaseSuggestion.includes("confirmedAllocationLeadTimes") && purchaseSuggestion.includes("recalculatedOrderDate"));
verify("Purchase Suggestion rounds every critical-path process up to a full workday", purchaseSuggestion.includes("countedMpsDetailsByHeader") && purchaseSuggestion.includes("BOM_CRITICAL_PATH_ROUND_EACH_PROCESS_V4") && purchaseSuggestion.includes("WORKING_HOURS_PER_DAY") && purchaseSuggestion.includes("scheduledElapsedDays") && purchaseSuggestion.includes("inhouseScheduledDays") && purchaseSuggestion.includes("criticalChild") && purchaseSuggestion.includes("vendorScheduledDays") && operationsDetail.includes("setiap proses dibulatkan ke atas") && operationsDetail.includes("Due Date Delivery") && operationsDetail.includes("Due Date Pembelian"));
verify("Material PO stays in KG without per-coil or per-sheet conversion input", !operationsDetail.includes("data-confirm-factor") && !operationsDetail.includes("data-split-factor") && !operationsDetail.includes("data-po-factor") && purchaseRequisition.includes("const poQty = row.rawMaterial ? row.sourceQty"));
verify("PR to PO consumes persisted sourcing decisions without reconfirmation", purchaseRequisition.includes("persistedAllocation = requestedAllocationId") && operationsDetail.includes("finalizedPurchaseOrderLines") && operationsDetail.includes('actionButton("edit-sourcing"'));
verify("Incoming detail retains MRP and MPS provenance through PR sources", supplyChainRead.includes("prDetail: { include: { sources:") && operationsDetail.includes("mrpRunNumber"));
verify("Production detail uses Excel-style tables and blocker resolution links", operationsDetailView.includes("production-detail-page") && operationsDetail.includes("production-excel-table") && operationsDetail.includes("blockerReferences"));
verify("Lot naming rules cover incoming and production flows", numberingService.includes('["LOT_INCOMING"') && numberingService.includes('["LOT_PRODUCTION"') && numberingService.includes('["LOT_WIP"') && numberingService.includes('["LOT_VENDOR_PROCESS"') && numberingService.includes('["LOT_ADJUSTMENT"'));
verify("FG receipt generates one configured production lot per QC batch", qualityInspection.includes('ensureDefaultNumberingRule("LOT_PRODUCTION", tx)') && qualityInspection.includes('generateConfiguredNumber("LOT_PRODUCTION"') && qualityInspection.includes("priorFgReceipt?.lotNumber") && fgReceiptView.includes("Otomatis saat simpan"));
verify("Goods Receipt supports multiple supplier lots per PO detail", !incomingController.includes("Satu detail PO hanya boleh dicatat satu kali") && incomingController.includes("receivedInRequest") && incomingForm.includes("data-add-lot"));
verify("Material Issue exposes adjustable lot and quantity allocation", operationsDetail.includes("data-mi-stock-source") && operationsDetail.includes("data-mi-save-lots") && operationsDetail.includes("qtyIssued"));
verify("Material Issue readiness includes reservations owned by its MO or target part", materialIssue.includes("reservedForDetail") && materialIssue.includes('referenceType: "PART_ALLOCATION"') && materialIssue.includes("qtyAvailable || 0) + reservedForDetail"));
verify("Material Issue lot splits preserve the original requested quantity", operationsDetail.includes("Quantity diminta tetap di line utama") && operationsDetail.includes("qtyRequired: isClonedLot ? 0 : sourceRequiredQty") && materialIssue.includes("qtyRequired: Number(detail.qtyRequired || 0)") && materialIssue.includes("qtyRequired: 0"));
verify("DPP raw material issue follows material-code stock lineage", materialIssue.includes("const materialCode = String(noteTokens.material") && materialIssue.includes("{ OR: sourceIdentityFilters }") && materialIssue.includes("!materialCode ? buildIdentityWhere(identity) : null"));
verify("Production Log stores multiple coil phases under one output lot", /model ProductionLogCoilPhase[\s\S]*inputLotNumber\s+String[\s\S]*productionLotNumber\s+String/.test(schema) && productionLog.includes("normalizeProductionCoilPhases") && productionLogForm.includes("collectCoilPhases"));
verify(
  "Production Entry input resolves Part Code, Part Number and Part Name from Daily Plan",
  dailyPlan.includes("partNumber: doc.part?.partNumber || null")
    && dailyPlan.includes("partName: doc.part?.partName || null")
    && productionLogForm.includes('setValue("partNumber", schedule.partNumber || "")')
    && productionLogForm.includes('setValue("partName", schedule.partName || "")'),
);
verify(
  "Approved Production Log generates one configured traceable lot before QC Hold",
  productionLog.includes('ruleKey = stockType === "Finished Goods" ? "LOT_PRODUCTION" : "LOT_WIP"')
    && productionLog.includes("await ensureDefaultNumberingRule(ruleKey, tx)")
    && productionLog.includes("await generateConfiguredNumber(ruleKey")
    && productionLog.includes("productionLogCoilPhase.updateMany")
    && /transactionType:\s*"QC_HOLD"[\s\S]*lotNumber/.test(productionLog),
);
verify("Each production phase stores multiple HMI-backed NG reasons", /model ProductionLogNgReason[\s\S]*hmiRejectionId\s+Int\?[\s\S]*qtyNg\s+Float/.test(schema) && productionLog.includes("hmi_list_rejection") && productionLog.includes("hmi_list_rejection_sub") && productionLogForm.includes("collectNgReasons") && productionLogView.includes("Reason NG Phase"));
verify("Production form consistently presents reject output as NG", productionLogView.includes("Qty NG *") && !productionLogView.includes("Qty Reject *") && productionLogForm.includes("total qty reason harus sama dengan Qty NG"));
verify("Downtime reasons use HMI master hierarchy with manual fallback", productionLog.includes("hmi_list_downtime") && productionLog.includes("hmi_list_downtime_sub") && productionLogForm.includes("hmiDowntimeId") && productionLogView.includes("Alasan Manual"));
verify("QC judgment allocates every NG quantity to rework or final reject", productionNgDisposition.includes("qtyRework + qtyReject") && productionNgDisposition.includes('"PENDING_QC"') && productionNgDisposition.includes('"MIXED"') && operationsDetail.includes("QC Judgment"));
verify("Production approval preserves good output while QC judgment creates rework WO", productionLog.includes("pendingCount") && productionLog.includes("finalizeProductionLogNgDisposition") && productionLog.includes("createProductionReworkWorkOrder") && productionLog.includes("qtyReject"));
verify("QC release does not double-consume Production NG", qualityInspection.includes("const totalNgQty = qtyFailed") && !qualityInspection.includes("const totalNgQty = productionLogNgQty + qtyFailed"));
verify("Production approval creates a visible QC stock release queue", productionLog.includes("ensureProductionQualityInspection") && productionLog.includes('status: selfCheck ? "Completed" : "Draft"') && moduleRegistry.includes('"QC Release Stock"') && operationsDetail.includes("QC OK & Release Stock") && operationsDetail.includes("Warehouse tujuan stok OK") && operationsDetail.includes("passedDestination"));
verify("Approved legacy logs can recover a missing QC release queue", productionLog.includes("exports.ensureQcRelease") && productionLog.includes("Stock movement QC Hold hasil OK tidak ditemukan") && operationsDetail.includes("Buka / Buat QC Release Stock"));
verify("Operator self-check is audited and releases OK stock without separate QC queue", /model ProductionLog[\s\S]*qualityCheckMode\s+String[\s\S]*selfCheckedBy\s+String\?/.test(schema) && productionLog.includes('"OPERATOR_SELF_CHECK"') && productionLog.includes('transactionType: "QUALITY_RELEASE"') && productionLogView.includes("QC dilakukan operator") && productionLogForm.includes("selfCheckNotes"));
verify("QC detail offers FG receipt only for terminal output", qualityInspection.includes("fgReceiptEligible") && qualityInspection.includes("WIP_STOCK_RELEASED") && operationsDetail.includes("Masukkan ke Gudang FG") && operationsDetail.includes("Hasil ini adalah WIP"));
verify("Inventory exposes material issue preparation queue", materialIssue.includes("preparationStatus") && materialIssue.includes("requiredScheduleNumber") && moduleRegistry.includes("Material Preparation Queue") && moduleRegistry.includes("preparationStatus"));
verify("Approved shortfall carries into next-day capacity", productionLog.includes("createProductionShortfallCarryover") && shortfallCarryover.includes("plannedQty: { increment: allocatedQty }") && shortfallCarryover.includes("schedulePriority: 1"));
verify("Shortfall carryover preserves Dies capacity", shortfallCarryover.includes("sourceDiesId") && shortfallCarryover.includes("diesLoadMinutes") && shortfallCarryover.includes("diesId: sourceDiesId"));
verify("Full next-day capacity creates an auditable overflow DPP", /model ProductionLogCarryover[\s\S]*sourceLogId\s+String\s+@unique/.test(schema) && shortfallCarryover.includes("CREATE_OVERFLOW") && shortfallCarryover.includes("CAPACITY-OVERFLOW"));
verify("Vendor shipment waits for completed predecessor and sufficient WIP", vendorProcessOrder.includes("resolveVendorSendReadiness") && vendorProcessOrder.includes('materialReadinessCode: "PREDECESSOR_NOT_READY"') && vendorProcessOrder.includes('status: "Waiting Material"') && vendorProcessOrder.includes("if (!readiness.materialReady)"));
verify("Vendor send button is disabled until material is ready", operationsDetail.includes("record.materialReady === true") && operationsDetail.includes("Menunggu Material"));
verify("Customer shipment requires Finished Goods readiness", deliveryReadiness.includes('const FG_STOCK_TYPES = ["Finished Goods", "FG"]') && deliveryReadiness.includes("WAITING_FG_RECEIPT") && outgoingTransaction.includes("resolveDeliveryReadiness") && outgoingTransaction.includes("if (!readiness.fgReady)"));
verify("Shipment UI waits for FG Receipt", supplyChainRead.includes("resolveDeliveryReadiness") && operationsDetail.includes("record.fgReady === true") && operationsDetail.includes("Menunggu FG Receipt"));

for (const name of checks) console.log(`PASS ${name}`);
