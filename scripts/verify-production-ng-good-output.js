const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const read = (...segments) => fs.readFileSync(path.join(root, ...segments), "utf8");
const productionLog = read("src", "prisma", "controllers", "production", "ProductionLogController.js");
const ngDisposition = read("src", "prisma", "controllers", "production", "ProductionNgDispositionController.js");
const detailUi = read("..", "renbo-mfg-frontend", "public", "js", "operations-detail.js");

const checks = [
  [
    productionLog.includes("async function finalizeProductionLogNgDisposition")
      && productionLog.includes("pendingCount"),
    "NG disposition finalization is independent from good-output approval",
  ],
  [
    !productionLog.includes("reason NG masih menunggu judgment QC. Selesaikan di QC Rework Judgment terlebih dahulu."),
    "Pending NG judgment no longer blocks Production Entry approval",
  ],
  [
    productionLog.includes("await finalizeProductionLogNgDisposition(")
      && ngDisposition.includes("finalizeProductionLogNgDisposition"),
    "NG reject/rework automation runs after approval or after the last judgment",
  ],
  [
    detailUi.includes("Approve Qty OK")
      && detailUi.includes("NG tetap menunggu judgment QC"),
    "Production Entry UI clearly separates good-output approval from NG judgment",
  ],
];

for (const [condition, message] of checks) {
  if (!condition) throw new Error(`FAIL ${message}`);
  console.log(`PASS ${message}`);
}
