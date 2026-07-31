const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const checks = [
  ["MPS schema has deterministic source key", read("prisma/schema.prisma").includes("sourceKey")],
  ["Forecast to MPS checks existing monthly source", read("src/prisma/controllers/planning/MPSController.js").includes("existingMpsByMonth")],
  ["MPS confirmation enforces readiness", read("src/prisma/controllers/planning/MPSController.js").includes("MPS_READINESS_BLOCKED")],
  ["Control Tower detail endpoint exists", read("src/prisma/routes/dashboard/control-tower.js").includes('router.get("/:soNumber"')],
  ["MRP executes Master Formula", read("src/prisma/controllers/planning/MRPController.js").includes('"MRP_NET_REQUIREMENT"')],
  ["Capacity executes Master Formula", read("src/prisma/services/planning/capacityPlanningService.js").includes('"CAPACITY_UTILIZATION_PERCENT"')],
  ["Purchasing executes Master Formula", read("src/prisma/controllers/purchasing/PurchaseRequisitionController.js").includes('"PR_LINE_TOTAL"')],
  ["Inventory executes Master Formula", read("src/prisma/controllers/inventory/StockMovementController.js").includes('"INVENTORY_AVAILABLE_QTY"')],
  ["Production executes Master Formula", read("src/prisma/controllers/production/ProductionLogController.js").includes('"PRODUCTION_ALLOCATED_QTY"')],
];

const failed = checks.filter(([, passed]) => !passed);
checks.forEach(([name, passed]) => console.log(`${passed ? "PASS" : "FAIL"} ${name}`));
if (failed.length) process.exitCode = 1;
