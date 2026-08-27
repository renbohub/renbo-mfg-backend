const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const read = (...segments) => fs.readFileSync(path.join(root, ...segments), "utf8");
const workflow = read("src", "prisma", "controllers", "production", "services", "productionWorkflowService.js");
const dailySchedule = read("src", "prisma", "controllers", "production", "DailyProductionScheduleController.js");
const materialIssue = read("src", "prisma", "controllers", "production", "MaterialIssueController.js");

const checks = [
  [
    dailySchedule.includes("includePartAllocations: true"),
    "DPS availability must opt in to target-part stock allocations",
  ],
  [
    workflow.includes('referenceType: "PART_ALLOCATION"')
      && workflow.includes("targetPartCode: item.partCode"),
    "Production availability must count open reservations for the required raw part",
  ],
  [
    materialIssue.includes('referenceType: "PART_ALLOCATION"')
      && materialIssue.includes("targetPartCode: reservationPartCode"),
    "Material Issue posting must consume the same target-part reservation",
  ],
  [
    materialIssue.includes("for (const reservation of activeReservations)"),
    "Material Issue posting must release all reservation rows used by one stock balance",
  ],
];

for (const [condition, message] of checks) {
  if (!condition) throw new Error(`FAIL ${message}`);
  console.log(`PASS ${message}`);
}
