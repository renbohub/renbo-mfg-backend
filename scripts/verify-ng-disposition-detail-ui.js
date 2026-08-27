const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const read = (...segments) => fs.readFileSync(path.join(root, ...segments), "utf8");
const detail = read("..", "frontend", "views", "operations", "detail.ejs");
const script = read("..", "frontend", "public", "js", "operations-detail.js");
const css = read("..", "frontend", "public", "css", "production-ng-disposition-detail.css");

const checks = [
  [
    detail.includes("production-ng-disposition-detail.css")
      && detail.includes("ng-disposition-workbench"),
    "NG disposition detail loads its dedicated workbench style",
  ],
  [
    script.includes("isNgDispositionPage")
      && script.includes("renderNgDispositionFields")
      && script.includes("renderNgDispositionCollections"),
    "NG disposition uses a purpose-built decision summary instead of the generic production table",
  ],
  [
    script.includes("Total NG")
      && script.includes("Belum dialokasikan")
      && script.includes("Rework + Final Reject"),
    "Decision summary makes the QC quantity equation explicit",
  ],
  [
    css.includes(".ng-disposition-workbench")
      && css.includes(".ngd-quantity-strip")
      && css.includes(".ngd-trace-grid"),
    "QC workbench has dedicated responsive visual hierarchy",
  ],
];

for (const [condition, message] of checks) {
  if (!condition) throw new Error(`FAIL ${message}`);
  console.log(`PASS ${message}`);
}
