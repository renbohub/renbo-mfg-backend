const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const read = (...segments) => fs.readFileSync(path.join(root, ...segments), "utf8");
const form = read("..", "frontend", "public", "js", "production-log-form.js");
const view = read("..", "frontend", "views", "production", "log-form.ejs");
const css = read("..", "frontend", "public", "css", "production-log.css");

const checks = [
  [
    form.includes('const ACTIVE_SCHEDULE_STATUSES = ["Draft", "Released", "In Progress"]'),
    "Machine selector loads active DPS statuses instead of only In Progress",
  ],
  [
    !form.includes("status=In%20Progress"),
    "Machine selector request does not hide Draft and Released machine assignments",
  ],
  [
    form.includes("renderScheduleGate") && form.includes("Buka Daily Plan"),
    "Blocked machine selection explains the workflow and links to its Daily Plan",
  ],
  [
    view.includes('id="production-log-schedule-gate"')
      && css.includes(".production-log-schedule-gate"),
    "Production Entry renders a styled schedule readiness gate",
  ],
];

for (const [condition, message] of checks) {
  if (!condition) throw new Error(`FAIL ${message}`);
  console.log(`PASS ${message}`);
}
