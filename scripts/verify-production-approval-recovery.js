const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { canResumeCompletedApproval } = require("../src/prisma/services/approvalRuleService");

const productionLogController = fs.readFileSync(path.join(__dirname, "../src/prisma/controllers/production/ProductionLogController.js"), "utf8");

const submittedAt = new Date("2026-08-26T01:00:00.000Z");
const approvedAt = new Date("2026-08-26T01:05:00.000Z");
const approvedRequest = { status: "Approved", completedAt: approvedAt };

assert.equal(canResumeCompletedApproval({
  document: { status: "Submitted", updatedAt: submittedAt },
  request: approvedRequest,
  documentStatuses: ["Submitted"],
}), true, "completed approval must resume posting for the same submitted document version");

assert.equal(canResumeCompletedApproval({
  document: { status: "Submitted", updatedAt: new Date("2026-08-26T01:10:00.000Z") },
  request: approvedRequest,
  documentStatuses: ["Submitted"],
}), false, "document edited after approval must be submitted again");

assert.equal(canResumeCompletedApproval({
  document: { status: "Approved", updatedAt: submittedAt },
  request: approvedRequest,
  documentStatuses: ["Submitted"],
}), false, "an already posted document must not replay approval");

assert.equal(canResumeCompletedApproval({
  document: { status: "Submitted", updatedAt: submittedAt },
  request: { status: "Rejected", completedAt: approvedAt },
  documentStatuses: ["Submitted"],
}), false, "a rejected request must not authorize approval posting");

assert.match(
  productionLogController,
  /PRODUCTION_APPROVAL_TRANSACTION_OPTIONS\s*=\s*\{\s*maxWait:\s*10000,\s*timeout:\s*30000\s*\}/,
  "Production Log approval must have enough time for stock, carry-over, and QC posting",
);
assert.match(
  productionLogController,
  /prisma\.\$transaction\(async \(tx\) => \{[\s\S]*?PRODUCTION_APPROVAL_TRANSACTION_OPTIONS\);/,
  "Production Log approval transaction must use the extended timeout options",
);

console.log("Production approval recovery checks passed: safe retry and 30-second posting transaction");
