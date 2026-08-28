const assert = require("assert");
const fs = require("fs");
const path = require("path");

const schema = fs.readFileSync(path.join(__dirname, "../prisma/schema.prisma"), "utf8");

function modelBody(name) {
  const match = schema.match(new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`));
  assert(match, `${name} model must exist`);
  return match[1];
}

assert.match(modelBody("DailyPlanRevision"), /planDate\s+DateTime/);
assert.match(modelBody("DailyPlanRevision"), /version\s+Int/);
assert.match(modelBody("DailyPlanRevision"), /status\s+String/);
assert.match(modelBody("DailyPlanRevision"), /Partially Released/);
assert.match(modelBody("DailyProductionSchedule"), /dailyPlanRevisionId\s+String\?/);
assert.match(modelBody("DailyPlanningException"), /suggestions\s+Json\?/);
assert.match(modelBody("MachineAvailabilityEvent"), /eventType\s+String/);

console.log("Daily plan revision schema contracts passed.");
