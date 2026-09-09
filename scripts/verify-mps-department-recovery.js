"use strict";
const assert = require("node:assert/strict");
const { createRequest, listRequests, updateFeedback, validateRequest, canFeedback } = require("../src/prisma/services/planning/mpsRecoveryRequestService");

(async () => {
  const requester = { id: "ppic", username: "planner", listMenu: [{ resource: "mps", actions: ["read", "update"] }] };
  const recipient = { id: "buyer", employeeId: "E1" };
  const outsider = { id: "sales", employeeId: "E2" };
  const employees = { E1: { departmentId: "D1", status: "Active", isDeleted: false, department: { isDeleted: false } }, E2: { departmentId: "D2", status: "Active", isDeleted: false, department: { isDeleted: false } } };
  const requests = []; const notifications = []; const broadcasts = [];
  let clock = 0;
  const db = {
    employee: { findUnique: async ({ where }) => employees[where.employeeId] },
    user: { findMany: async () => [{ id: "buyer", employee: { departmentId: "D1", department: { id: "D1", departmentCode: "PUR", departmentName: "Purchasing" } } }] },
    mPSDetail: { findFirst: async () => ({ partCode: "FG1", mpsNumber: "MPS1", mps: { revision: 2, status: "Calculated", isDeleted: false } }) },
    mpsRecoveryRequest: {
      findUnique: async ({ where }) => requests.find((r) => where.id ? r.id === where.id : Object.entries(where.mpsNumber_mpsRevision_lineId_checkpointCode).every(([k, v]) => r[k] === v)) || null,
      findMany: async ({ where }) => requests.filter((r) => Object.entries(where).every(([k, v]) => r[k] === v)),
      create: async ({ data }) => { const r = { ...data, id: "R1", feedbackStatus: "OPEN", updatedAt: new Date(++clock * 1000) }; requests.push(r); return r; },
      updateMany: async ({ where, data }) => { const r = requests.find((r) => r.id === where.id && r.updatedAt.getTime() === where.updatedAt.getTime()); if (!r) return { count: 0 }; Object.assign(r, data, { updatedAt: new Date(++clock * 1000) }); return { count: 1 }; },
    },
    notification: { create: async ({ data }) => { notifications.push(data); return data; } },
  };
  db.$transaction = async (work) => work(db);
  const input = { lineId: "L1", checkpointCode: "MATERIAL_SUPPLY", departmentId: "D1", notes: "Percepat material", targetDate: "2026-09-07" };
  const assessment = { identity: { lineId: "L1", period: "2026-09", mpsNumber: "MPS1", mpsRevision: 2 }, checks: [{ code: "MATERIAL_READY_BY_START", status: "FAIL", reason: "Shortage 10 KG" }], summary: { status: "NOT_FEASIBLE" } };
  await assert.rejects(createRequest(db, requester, input, { ...assessment, identity: { ...assessment.identity, mpsRevision: 1 } }), /Revisi MPS berubah/);
  const created = await createRequest(db, requester, input, assessment, (n) => broadcasts.push(n));
  assert.equal(created.duplicate, false); assert.equal(created.item.recipientCount, 1);
  assert.equal(notifications[0].userId, "buyer"); assert.equal(broadcasts.length, 1);
  assert.equal(notifications[0].metadata.lineId, "L1"); assert.equal(created.item.sourceSnapshot.checks[0].status, "FAIL");
  assert.equal((await createRequest(db, requester, input, assessment)).duplicate, true);
  assert.equal(requests.length, 1); assert.equal(notifications.length, 1, "retry must not notify again");
  assert.equal((await listRequests(db, outsider, { month: "2026-09" })).length, 0);
  assert.equal((await listRequests(db, recipient, { month: "2026-09" }))[0].canFeedback, true);
  assert.equal(canFeedback(recipient, requests[0], { ...employees.E1, status: "Inactive" }), false);
  await assert.rejects(updateFeedback(db, outsider, "R1", { feedbackStatus: "IN_PROGRESS", updatedAt: requests[0].updatedAt.toISOString() }), /Hanya akun penerima/);
  await assert.rejects(updateFeedback(db, recipient, "R1", { feedbackStatus: "DONE", updatedAt: requests[0].updatedAt.toISOString() }), /Catatan hasil/);
  await assert.rejects(updateFeedback(db, recipient, "R1", { feedbackStatus: "IN_PROGRESS", updatedAt: "2020-01-01T00:00:00.000Z" }), /sudah diperbarui/);
  const finished = await updateFeedback(db, recipient, "R1", { feedbackStatus: "DONE", feedbackNotes: "Supplier konfirmasi jadwal", recoveryOutcome: "FEASIBLE", evidenceReference: "PO1", updatedAt: requests[0].updatedAt.toISOString() });
  assert.equal(finished.feedbackStatus, "DONE"); assert.equal(finished.history.length, 2);
  assert.equal(finished.recoveryOutcome, "FEASIBLE"); assert.equal(finished.history.at(-1).recoveryOutcome, "FEASIBLE");
  assert.equal(finished.sourceSnapshot.summary.status, "NOT_FEASIBLE", "feedback cannot promote MPS or replace assessment");
  assert.equal(notifications.at(-1).userId, "ppic");
  assert.throws(() => validateRequest({ ...input, targetDate: "2026-02-30" }, assessment), /Tanggal target/);
  assert.throws(() => validateRequest(input, { ...assessment, checks: [{ code: "MATERIAL_READY_BY_START", status: "PASS" }] }), /tidak memiliki masalah/);
  await assert.rejects(createRequest(db, outsider, input, assessment), /Akses update/);
  console.log("Department recovery: targeted notifications, idempotence, recipient scope, feedback audit and approval separation PASS");
})().catch((e) => { console.error(e); process.exitCode = 1; });
