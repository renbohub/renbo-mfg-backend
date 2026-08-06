const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const frontendRoot = path.resolve(root, "..", "frontend");
const readFrontend = (file) =>
  fs.readFileSync(path.join(frontendRoot, file), "utf8");
const capacityController = read("src/prisma/controllers/planning/CapacityPlanningController.js");
const capacityRoutes = read("src/prisma/routes/planning/capacity-planning.js");

const checks = [
  [
    "Planned order exposes supplier readiness",
    read("src/prisma/controllers/planning/MRPController.js").includes(
      "supplierReadiness",
    ),
  ],
  [
    "MRP supply breakdown exposes covered demand",
    read("src/prisma/controllers/planning/MRPController.js").includes(
      "coveredDemandQty",
    ),
  ],
  [
    "mBOM costing report endpoint exists",
    read("src/prisma/routes/reporting.js").includes('"/mbom-costing"'),
  ],
  [
    "Inventory aging report endpoint exists",
    read("src/prisma/routes/reporting.js").includes('"/inventory"'),
  ],
  [
    "Sales revenue and margin report endpoint exists",
    read("src/prisma/routes/reporting.js").includes('"/sales-margin"'),
  ],
  [
    "Monthly Plan legacy URL redirects to canonical page",
    readFrontend("src/routes/modules.js").includes(
      'res.redirect(308, "/modules/planning-ppic/monthly-production-plans")',
    ),
  ],
  [
    "Shared table utility is used by operations and module lists",
    readFrontend("public/js/operations-dashboard.js").includes(
      "SharedDataTable",
    ) &&
      readFrontend("public/js/module-list.js").includes("SharedDataTable"),
  ],
  [
    "Capacity UI compares two persisted custom scenarios with Gantt and calendar",
    ["renderCustomScenarioComparison", "loadSharedScenarios", "renderGantt", "renderCalendar"].every(
      (contract) => readFrontend("public/js/ppic-capacity.js").includes(contract),
    ) && capacityController.includes("prisma.systemSetting.upsert") && capacityRoutes.includes('router.put("/scenarios/:scenarioKey"'),
  ],
  [
    "MPS MRP and MPP use three grouping levels with Parent FG Forecast",
    readFrontend("public/js/ppic-detail.js").includes('data-ppic-group="3"') &&
      readFrontend("public/js/ppic-detail.js").includes("Parent FG Forecast") &&
      readFrontend("public/js/ppic-detail.js").includes("parentFgPartCode") &&
      readFrontend("public/js/ppic-detail.js").includes(
        'ppic-grouping:${tab}`) || "[\\"customer\\",\\"month\\",\\"part\\"]"',
      ),
  ],
  [
    "Report UI renders KPI, chart, detail and CSV",
    ["renderSummary", "renderChart", "renderRows", "downloadCsv"].every(
      (contract) =>
        readFrontend("public/js/module-report.js").includes(contract),
    ),
  ],
];

const failed = checks.filter(([, passed]) => !passed);
checks.forEach(([name, passed]) =>
  console.log(`${passed ? "PASS" : "FAIL"} ${name}`),
);
if (failed.length) process.exitCode = 1;
