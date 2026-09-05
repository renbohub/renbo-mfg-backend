"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const routes = read("src/prisma/routes/planning/mps.js");
const controller = read("src/prisma/controllers/planning/MPSController.js");
const workbench = read("src/prisma/services/planning/mpsWorkbenchService.js");

assert.match(routes, /router\.get\("\/workbench\/lines\/:lineId\/feasibility"/);
assert.match(routes, /authorize\("mps", "read"\), ctrl\.workbenchFeasibility/);
assert.doesNotMatch(routes, /feasibility\/recalculate/);
assert.doesNotMatch(controller, /recalculateWorkbenchFeasibility/);
assert.match(controller, /includeFeasibilityDetail: true/);
assert.match(controller, /normalizedLineId\.split\("::"\)\[0\]/);
assert.match(controller, /phase\?\.scheduleFeasibility/);
assert.match(workbench, /checklistSummary/);
assert.match(workbench, /includeFeasibilityDetail \? \{ scheduleFeasibility/);
assert.match(workbench, /aggregateMpsFeasibilityAssessments/);
assert.match(workbench, /statuses: \["FEASIBLE", "FEASIBLE_WITH_RISK", "NOT_FEASIBLE", "NOT_EVALUATED", "NA"\]/);
assert.doesNotMatch(workbench, /FEASIBLE_WITH_ACTION/);

console.log("MPS schedule feasibility API contract verification passed.");
