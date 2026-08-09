const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const po = read("src/prisma/controllers/purchasing/PurchaseOrderController.js");
const pr = read("src/prisma/controllers/purchasing/PurchaseRequisitionController.js");
const mrp = read("src/prisma/controllers/planning/MRPController.js");
const poRoutes = read("src/prisma/routes/purchasing/purchase-orders.js");
const invoiceRoutes = read("src/prisma/routes/purchasing/purchase-invoices.js");
const reports = read("src/prisma/controllers/reporting/P2ReportingController.js");
const frontendDetail = read("../frontend/public/js/operations-detail.js");
const frontendPrForm = read("../frontend/public/js/purchasing-pr-form.js");
const frontendPrView = read("../frontend/views/purchasing/pr-form.ejs");
const frontendModuleRoutes = read("../frontend/src/routes/modules.js");
const frontendSupplyForm = read("../frontend/public/js/supply-chain-form.js");
const frontendSupplyView = read("../frontend/views/operations/supply-chain-form.ejs");
const frontendInventoryForm = read("../frontend/public/js/inventory-form.js");
const frontendInventoryView = read("../frontend/views/inventory/form.ejs");
const incoming = read("src/prisma/controllers/incoming/IncomingTransactionController.js");
const inventoryMovement = read("src/prisma/controllers/inventory/StockMovementController.js");
const rackController = read("src/prisma/controllers/inventory/RackController.js");
const schema = read("prisma/schema.prisma");
const frontendMasterRegistry = read("../frontend/src/masterDataRegistry.js");

const contracts = [
  ["Direct PO is Draft", /status:\s*PO_STATUS\.DRAFT/.test(po)],
  ["Direct PO from PR is blocked", po.includes("PO dari Purchase Requisition wajib dibuat melalui konsolidasi PR")],
  ["PO approval has explicit authorization", poRoutes.includes('authorize("purchaseOrder", "approve"), purchaseOrderApproval')],
  ["PO approval no longer uses static check flow", !po.includes("PO_CHECK_FLOW")],
  ["PO confirmation requires Sent", po.includes('existing.status !== "Sent"')],
  ["Linked PR PO details are locked", po.includes("Detail PO yang berasal dari PR dikunci")],
  ["Legacy conversion delegates to safe consolidation", pr.includes("return exports.consolidateToPO(req, res, next)")],
  ["Raw material only allows supplier forms", pr.includes('["SHEET", "COIL", "PCS"].includes(purchasePackageUomCode)')],
  ["Supplier conversion is persisted atomically", pr.includes('supplierProposalSource: "PURCHASING"')],
  ["PR delete checks linked PO", pr.includes("PR sudah terhubung ke Purchase Order")],
  ["PR summary is grouped by UOM", pr.includes("qtyByUom") && pr.includes("mixedUom")],
  ["Purchase Invoice CRUD/workflow route exists", invoiceRoutes.includes("/:invoiceNumber/approve") && invoiceRoutes.includes("/:invoiceNumber/pay")],
  ["Purchasing report is analytical", reports.includes("exports.purchasing") && reports.includes("receiptCoveragePercent")],
  ["Supplier conversion uses structured modal", frontendDetail.includes("ops-purchase-conversion-form")],
  ["PR to PO is one frontend transaction", !frontendDetail.includes('/confirm-suppliers`, { method: "PATCH"')],
  ["Draft MRP PR remains editable", frontendDetail.includes('prEditLink.classList.toggle("d-none", !editableStatus)')],
  ["MRP PR edit preserves source and planned-order trace", frontendPrForm.includes('sourceType: state.record?.sourceType || "MANUAL"') && frontendPrForm.includes("plannedOrderNumber: source.plannedOrderNumber || null")],
  ["MRP material PR advisory lock does not deserialize PostgreSQL void", mrp.includes("tx.$executeRaw`SELECT pg_advisory_xact_lock") && !mrp.includes("tx.$queryRaw`SELECT pg_advisory_xact_lock")],
  ["MRP material PR keeps one detail per Planned Order", mrp.includes("part.material.id || part.material.materialCode, order.orderNumber") && mrp.includes('incoming.plannedOrderNumber || ""') && mrp.includes('row.plannedOrderNumber || ""')],
  ["PR editor supports Coil Sheet Pcs conversion", frontendPrForm.includes('option value="COIL"') && frontendPrForm.includes('option value="SHEET"') && frontendPrForm.includes('option value="PCS"') && frontendPrForm.includes("line-conversion-factor")],
  ["Manual PR category switch rerenders compatible detail form", frontendPrView.includes('id="pr-category"') && frontendPrForm.includes("function applyDocumentCategory") && frontendPrForm.includes("resetLines: true, updateUrl: true") && frontendPrForm.includes("addLine({ procurementCategory: state.currentCategory })")],
  ["PR demand remains separate from purchase conversion", pr.includes("const qty = requestedQty") && pr.includes("tidak mengubah demand awal")],
  ["PR quantity accepts integer and decimal values", frontendPrForm.includes('class="form-control line-qty" type="number" min="0.000001" step="any"')],
  ["PR category filter does not hide Purchase Orders", frontendModuleRoutes.includes('const purchaseCategory = isPurchaseRequisition') && frontendModuleRoutes.includes(": null;")],
  ["Sent PO can open a preselected Goods Receipt", frontendDetail.includes("data-create-goods-receipt") && frontendSupplyForm.includes('new URLSearchParams(location.search).get("poNumber")') && frontendSupplyForm.includes("await loadSource()")],
  ["Goods Receipt accepts only receiving PO statuses", incoming.includes('["Sent", "Confirmed", "Partial Receipt"].includes(po.status)') && incoming.includes("Warehouse penerimaan tidak aktif")],
  ["Goods Receipt accepts under and over receipt variance", !incoming.includes("Receipt quantity exceeds the outstanding PO") && incoming.includes("overReceivedQty") && frontendSupplyForm.includes("Boleh kurang / lebih")],
  ["Small shortage can close PO while large shortage stays partial", incoming.includes("AUTO_CLOSE_SHORTAGE_PERCENT") && incoming.includes('poStatus = poCompleted ? "Completed" : "Partial Receipt"') && frontendSupplyForm.includes('shortagePercent <= AUTO_CLOSE_SHORTAGE_PERCENT ? "Close PO" : "Partial Receipt"')],
  ["Goods Receipt can manually consume an eligible PO", frontendSupplyView.includes("Pilih PO secara manual") && frontendSupplyView.includes("Pilih PO untuk dikonsumsi") && frontendSupplyForm.includes('$("sourceNumber").addEventListener("change"')],
  ["Goods Receipt generates internal lot and keeps supplier lot manual", incoming.includes('ensureDefaultNumberingRule("LOT_INCOMING", tx)') && incoming.includes('generateConfiguredNumber("LOT_INCOMING"') && incoming.includes("supplierLotNumber") && frontendSupplyForm.includes("data-supplier-lot") && frontendSupplyForm.includes("supplierLotNumber: row.supplierLot") && !frontendSupplyForm.includes("lotNumber: row.lot")],
  ["Incoming IQC uses a simplified operator input workspace", frontendDetail.includes("renderIncomingInspectionCollections") && frontendDetail.includes("data-iqc-accept-all") && frontendDetail.includes("Qty Diterima Baik") && frontendDetail.includes("Qty Reject") && frontendDetail.includes("updateIncomingInspectionSummary")],
  ["Incoming IQC only sends reject disposition when reject exists", frontendDetail.includes('rejectedDisposition: qtyRejected > 0') && frontendDetail.includes('dispositionReference: qtyRejected > 0') && frontendDetail.includes("Referensi retur wajib diisi")],
  ["Manual Complete uses warehouse and rack dropdowns", frontendDetail.includes("collectManualCompleteLocation") && frontendDetail.includes("data-manual-warehouse") && frontendDetail.includes("data-manual-rack") && !frontendDetail.includes('window.prompt("Warehouse tujuan untuk sisa penerimaan:')],
  ["Stock Movement uses master-backed dropdowns", frontendInventoryView.includes('<select id="warehouseCode" required>') && frontendInventoryView.includes('<select id="itemCode" required>') && frontendInventoryView.includes('<select id="lotNumber">') && frontendInventoryForm.includes("/master-data/api/parts?start=0&length=500") && frontendInventoryForm.includes("/master-data/api/uom?start=0&length=500")],
  ["Rack master belongs to Warehouse", schema.includes('warehouseCode String? @map("warehouse_code")') && rackController.includes("where.warehouseCode") && frontendMasterRegistry.includes('label: "Rack Warehouse"')],
  ["Material Stock Movement uses Material Master", frontendInventoryForm.includes("/master-data/api/materials?start=0&length=500") && frontendInventoryForm.includes('stockType === "Material"') && inventoryMovement.includes("Master Material wajib dipilih")],
  ["Goods Receipt carries rack and material identity to inventory", frontendSupplyForm.includes("rackCode: row.rack") && incoming.includes("materialCode: identity.materialCode") && incoming.includes("tx.lotMaster.upsert")],
];

let failed = 0;
for (const [name, ok] of contracts) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  if (!ok) failed += 1;
}
if (failed) {
  console.error(`${failed} Purchasing contract(s) failed.`);
  process.exit(1);
}
