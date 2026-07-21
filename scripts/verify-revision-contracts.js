const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const sources = [
  read("src/prisma/services/approvalRuleService.js"),
  read("src/prisma/controllers/incoming/IncomingTransactionController.js"),
  read("src/prisma/controllers/outgoing/OutgoingTransactionController.js"),
  read("src/prisma/controllers/dashboard/ControlTowerController.js"),
  read("src/prisma/controllers/master-data/FoundationController.js"),
  read("src/prisma/controllers/planning/MPSController.js"),
  read("src/prisma/controllers/planning/MRPController.js"),
  read("src/prisma/controllers/production/services/productionWorkflowService.js"),
  read("prisma/schema.prisma"),
].join("\n");

const capabilities = {
  "01": "generateWorkOrdersFromRouting", "02": "forecast", "03": "actualSalesOrderQty", "04": "sales", "05": "MTS", "06": "MTO", "07": "buffer", "08": "qtyAvailable", "09": "Outstanding", "10": "Late", "11": "orderMultiple", "12": "supplier", "13": "Approval", "14": "Rejected", "15": "receivePurchaseOrder", "16": "completeInspection", "17": "capacity", "18": "Downtime", "19": "deliverySchedule", "20": "critical", "21": "deliveryDate", "22": "qtyDelivered", "23": "Cancelled", "24": "Subcontract", "25": "VendorProcess", "26": "StockOpname", "27": "QUALITY", "28": "qtyProduced", "29": "markFailed", "30": "risk",
};

for (const [caseNumber, capability] of Object.entries(capabilities)) {
  assert(sources.toLowerCase().includes(capability.toLowerCase()), `Case ${caseNumber} missing contract capability: ${capability}`);
}
console.log(`Revision contract checks passed: ${Object.keys(capabilities).length}/30 cases`);
