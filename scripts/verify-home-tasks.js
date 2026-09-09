const assert = require("node:assert/strict");
const indexPath = require.resolve("../src/prisma/index");
require.cache[indexPath] = { id: indexPath, filename: indexPath, loaded: true, exports: { prisma: {} } };
const { getHomeTasks } = require("../src/prisma/services/homeTaskService");
const { withBusinessDate } = require("../src/prisma/utils/businessClock");
const user = { id: "me", username: "reviewer", employeeId: "employee", listMenu: [{ resource: "purchase-orders", actions: ["read"] }] };
const request = (id, extra = {}) => ({ id, documentNumber: id, moduleCode: "purchasing", pageCode: "purchase-orders", status: "Pending", requestedByUserId: "other", requestedAt: "2026-09-01", rule: { allowSelfApproval: false, requireSequential: true, steps: [{ stepOrder: 1, approverRoleId: "buyer", requiredApprovals: 1 }] }, actions: [], ...extra });
async function main() {
  let roleReads = 0;
  const db = {
    approvalRequest: { findMany: async () => [request("eligible"), request("self", { requestedByUserId: "me" }), request("wrong-role", { rule: { allowSelfApproval: false, requireSequential: true, steps: [{ stepOrder: 1, approverRoleId: "director", requiredApprovals: 1 }, { stepOrder: 2, approverRoleId: "buyer", requiredApprovals: 1 }] } }), request("already-approved", { actions: [{ stepOrder: 1, action: "Approved", actedByUserId: "me" }] })] },
    userRole: { findMany: async () => { roleReads++; return [{ roleId: "buyer" }]; } },
    employee: { findUnique: async () => ({ departmentId: "dept", status: "Active", isDeleted: false, department: { isDeleted: false } }) },
    mpsRecoveryRequest: { findMany: async () => [{ id: "mine", departmentId: "dept", recipientIds: ["me"], feedbackStatus: "OPEN", planningMonth: "2026-09" }, { id: "not-mine", departmentId: "dept", recipientIds: ["other"], feedbackStatus: "OPEN" }, { id: "done", departmentId: "dept", recipientIds: ["me"], feedbackStatus: "DONE" }] },
    pageComment: { findMany: async () => [{ id: "allowed", moduleCode: "purchasing", pageCode: "purchase-orders", message: "Review" }, { id: "private", moduleCode: "finance", pageCode: "payroll", message: "Private" }] },
    notification: { findMany: async ({ where }) => { assert.deepEqual(where.OR, [{ userId: "me" }, { userId: null }]); assert.equal(where.isRead, false); return [{ id: "notice", userId: "me" }, { id: "broadcast", userId: null }]; }, count: async () => 2 },
  };
  const payload = await withBusinessDate("2026-08-20", () => getHomeTasks(db, user));
  assert.deepEqual(payload.sources.approval.items.map((item) => item.id), ["eligible"]);
  assert.equal(roleReads, 1, "Role reads cached per request");
  assert.deepEqual(payload.sources.recovery.items.map((item) => item.id), ["mine"]);
  assert.deepEqual(payload.sources.comment.items.map((item) => item.id), ["allowed"]);
  assert.equal(payload.sources.notification.items[0].canMarkRead, true);
  assert.equal(payload.sources.notification.items[1].canMarkRead, false);
  assert.equal(payload.currentDate, "2026-08-20");
  db.pageComment.findMany = async () => { throw new Error("offline"); };
  const partial = await getHomeTasks(db, user);
  assert.equal(partial.sources.comment.available, false);
  assert.equal(partial.sources.comment.total, null);
  assert.equal(partial.sources.approval.available, true);
  console.log("Home tasks PASS: approver, sequential steps, self-approval, duplicate, recovery recipient, comment access, private notifications, partial failures, demo date.");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
