const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const frontendRoot = path.resolve(root, "..", "frontend");
const readFrontend = (file) =>
  fs.readFileSync(path.join(frontendRoot, file), "utf8");

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
    "Capacity UI compares Normal and Max scenarios",
    readFrontend("public/js/ppic-capacity.js").includes(
      "renderScenarioComparison",
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
