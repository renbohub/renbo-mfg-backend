const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "../..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const inventory = read("frontend/public/js/module-report.js");
const inventoryView = read("frontend/views/modules/report.ejs");
const mrpUi = read("frontend/public/js/ppic-detail.js");
const mrpController = read("backend/src/prisma/controllers/planning/MRPController.js");
const reservationController = read("backend/src/prisma/controllers/inventory/StockReservationController.js");
const reservationForm = read("frontend/public/js/stock-reservation-form.js");
const autoPartAllocation = read("backend/src/prisma/controllers/inventory/utils/autoPartAllocation.js");
const stockMovementController = read("backend/src/prisma/controllers/inventory/StockMovementController.js");
const incomingController = read("backend/src/prisma/controllers/incoming/IncomingTransactionController.js");
const purchaseOrderController = read("backend/src/prisma/controllers/purchasing/PurchaseOrderController.js");

const checks = [
  [inventory.includes('const rootFgOnHand = Math.round(uomStock(fg.fgStock, "pcs", "qtyOnHand"))') && inventory.includes("root.fgOnHand += rootFgOnHand"), "FG matrix must use physical on-hand, not available"],
  [inventory.includes('matrixQty(row.materialAvailable'), "Material Free must use authoritative qtyAvailable"],
  [!inventory.includes("row.materialAvailable - row.materialAllocated"), "Historical GR pegging must not reduce current free stock"],
  [inventory.includes('"TOTAL PHYSICAL"'), "Inventory matrix must expose Material/WIP/FG totals"],
  [inventory.includes('"FG On Hand", "FG Reserved", "FG Free"'), "FG on-hand/reserved/free must be separated"],
  [inventoryView.includes("Free = On Hand - Reserved - QC"), "UI must explain reconciliation rule"],
  [mrpUi.includes('["management", "Management Matrix"]'), "MRP must expose Management Matrix tab"],
  [mrpUi.includes("PO Ordered") && mrpUi.includes("PO Received") && mrpUi.includes("PO Outstanding"), "MRP matrix must expose PO progress"],
  [mrpUi.includes("FG-WIP Coverage") && mrpUi.includes("Material-PO Coverage"), "MRP XLSX must contain management coverage sheets"],
  [mrpController.includes("purchaseOrders: row.poDetails.map"), "MRP API must trace PR lines to PO progress"],
  [mrpController.includes("poDetailId: detail.id"), "PO lines must carry stable IDs for de-duplication"],
  [reservationController.includes('referenceType: "PART_ALLOCATION"'), "Manual stock reservation must persist a target-part allocation"],
  [reservationController.includes("qtyAvailable: Math.max(number(stock.qtyAvailable) - totalQty, 0)"), "Manual reservation must reduce free stock atomically"],
  [mrpController.includes("buildTargetedReservationPool") && mrpController.includes("targetedReservedUsed"), "MRP netting must restore targeted reservation only to its matching part"],
  [reservationForm.includes("state.allocations.map") && reservationForm.includes("remainingFreeStock"), "Reservation form must support multiple target parts within free stock"],
  [reservationController.includes('itemType: "RAW"') && reservationController.includes('rawType: "MATERIAL"'), "Reservation target options must be RAW MATERIAL parts"],
  [reservationController.includes("materialId: stock.materialId"), "Reservation target must share the selected stock material identity"],
  [autoPartAllocation.includes("targetParts.length !== 1"), "Automatic material allocation must run only for exactly one RAW target part"],
  [autoPartAllocation.includes("Math.min(requestedQty") && autoPartAllocation.includes("qtyAvailable: Math.max(number(stock.qtyAvailable) - qty, 0)"), "Automatic allocation must reserve only the newly received free quantity"],
  [autoPartAllocation.includes('referenceType: "PART_ALLOCATION"') && autoPartAllocation.includes("targetPartCode: target.partCode"), "Automatic allocation must remain target-aware for MRP netting"],
  [[stockMovementController, incomingController, purchaseOrderController].every((source) => source.includes("autoAllocateMaterialReceipt")), "All material receipt paths must invoke single-part auto allocation"],
  [reservationForm.includes("state.parts.length === 1") && reservationForm.includes("state.parts.length} part RAW MATERIAL"), "Reservation form must auto-select only a single related RAW part"],
];

checks.forEach(([condition, message]) => assert.ok(condition, message));
console.log(`Inventory/MRP management matrix checks passed: ${checks.length}/${checks.length}`);
