"use strict";

const assert = require("node:assert/strict");
const { evaluateLeadTimeWindow } = require("../src/prisma/services/purchasing/etaLeadTimeService");

async function main() {
  const row = Object.freeze({ checkpoint: "MPS_VENDOR", category: "VENDOR", sendDate: "2026-09-04", needDate: "2026-09-07", confirmedLeadTimeDays: 2, eta: "2026-09-04", qty: 999999 });
  const before = JSON.stringify(row);
  const weekend = await evaluateLeadTimeWindow(row);
  assert.equal(weekend.earliestReturnDate, "2026-09-07", "two working days from Friday complete Monday");
  assert.equal(weekend.leadTimeFits, true);
  assert.equal(weekend.diagnostics.engine, "OR_TOOLS_WASM_CP_SAT");
  assert.equal(weekend.diagnostics.solverStatus, "OPTIMAL");

  const late = await evaluateLeadTimeWindow({ ...row, needDate: "2026-09-04" });
  assert.equal(late.leadTimeFits, false, "entered on-time ETA / large qty cannot hide impossible LT");
  assert.equal(late.earliestReturnDate, "2026-09-07");
  assert.equal(late.diagnostics.code, "LEAD_TIME_EXCEEDS_WINDOW");

  const calendar = Object.freeze({ "2026-09-07": "HOLIDAY" });
  const holiday = await evaluateLeadTimeWindow(row, { calendar });
  assert.equal(holiday.earliestReturnDate, "2026-09-08");
  assert.equal(holiday.leadTimeFits, false);
  const workingSaturday = await evaluateLeadTimeWindow(row, { calendar: { "2026-09-05": "WORKING" } });
  assert.equal(workingSaturday.earliestReturnDate, "2026-09-05");
  const weekendRelease = await evaluateLeadTimeWindow({ ...row, sendDate: "2026-09-05", confirmedLeadTimeDays: 1 });
  assert.equal(weekendRelease.earliestReturnDate, "2026-09-07");

  const fractional = await evaluateLeadTimeWindow({ ...row, sendDate: "2026-09-07T06:00:00Z", needDate: "2026-09-07T07:00:00Z", confirmedLeadTimeDays: .25 });
  assert.equal(fractional.diagnostics.earliestReturnAt, "2026-09-07T08:00:00.000Z");
  assert.equal(fractional.leadTimeFits, false, "retain exact successor cutoff within the same day");
  const equality = await evaluateLeadTimeWindow({ ...row, sendDate: "2026-09-07T06:00:00Z", needDate: "2026-09-07T08:00:00Z", confirmedLeadTimeDays: .25 });
  assert.equal(equality.leadTimeFits, true);
  const extendedDay = await evaluateLeadTimeWindow({ ...row, sendDate: "2026-09-07", confirmedLeadTimeDays: .5 }, { hoursPerDay: 16 });
  assert.equal(extendedDay.diagnostics.earliestReturnAt, "2026-09-07T08:00:00.000Z");

  const noSolver = { solveFiniteSchedule: async () => { throw new Error("must not run"); } };
  for (const value of [null, undefined, "", " ", true, [], -1, Infinity, "bad", 3651]) {
    const unknown = await evaluateLeadTimeWindow({ ...row, confirmedLeadTimeDays: value }, noSolver);
    assert.equal(unknown.leadTimeFits, null);
    assert.equal(unknown.diagnostics.code, "INPUT_INCOMPLETE");
  }
  for (const value of [null, undefined, "", "2026-02-30", 0, "invalid"]) {
    const unknown = await evaluateLeadTimeWindow({ ...row, sendDate: value }, noSolver);
    assert.equal(unknown.earliestReturnDate, null, "never substitute today for an unknown start");
    assert.equal(unknown.leadTimeFits, null);
  }
  assert.equal((await evaluateLeadTimeWindow({ ...row, needDate: null }, noSolver)).leadTimeFits, null);
  for (const customer of [{ checkpoint: "MPS_MATERIAL", category: "CUSTOMER" }, { ...row, category: "CUSTOMER" }, {}]) {
    assert.deepEqual(await evaluateLeadTimeWindow(customer, noSolver), { applicable: false, earliestReturnDate: null, leadTimeFits: null, diagnostics: { code: "NOT_APPLICABLE" } });
  }
  const zero = await evaluateLeadTimeWindow({ ...row, sendDate: "2026-09-05", confirmedLeadTimeDays: 0 }, noSolver);
  assert.equal(zero.earliestReturnDate, "2026-09-05");
  assert.equal(zero.leadTimeFits, true);
  assert.equal((await evaluateLeadTimeWindow({ ...row, sendDate: "2026-09-08", confirmedLeadTimeDays: 0 }, noSolver)).leadTimeFits, false);
  assert.equal((await evaluateLeadTimeWindow(row, { hoursPerDay: 0 })).diagnostics.code, "INVALID_WORKING_HOURS");
  const failed = await evaluateLeadTimeWindow(row, { solveFiniteSchedule: async () => { throw new Error("runtime unavailable"); } });
  assert.equal(failed.leadTimeFits, null);
  assert.equal(failed.diagnostics.code, "SOLVER_UNAVAILABLE");
  for (const status of ["UNKNOWN", "INFEASIBLE", "FEASIBLE"]) {
    const unavailable = await evaluateLeadTimeWindow(row, { solveFiniteSchedule: async () => ({ status, feasible: status === "FEASIBLE", tasks: [] }) });
    assert.equal(unavailable.leadTimeFits, null);
    assert.equal(unavailable.earliestReturnDate, null);
  }
  const invalid = await evaluateLeadTimeWindow(row, { solveFiniteSchedule: async () => ({ status: "OPTIMAL", feasible: true, tasks: [] }) });
  assert.equal(invalid.diagnostics.code, "SOLVER_RESULT_INVALID");
  assert.equal(JSON.stringify(row), before, "input row remains unchanged");
  await verifyStoreIntegration();
  console.log("PASS ETA LT window: actual CP-SAT, weekends, holidays, working overrides, fractional LT, timestamp deadlines, zero LT, unknown inputs, customer isolation and solver failure.");
}

async function verifyStoreIntegration() {
  const store = require("../src/prisma/services/purchasing/etaConfirmationStore");
  const monitor = require("../src/prisma/services/purchasing/etaMonitorService");
  const confirmation = require("../src/prisma/services/purchasing/etaConfirmationService");
  const fixtures = ["2026-09-04", "2026-09-07"].map((needDate, index) => Object.freeze({
    id: `MPSV:fixture:phase:${index}`, source: "MPS-FIXTURE", mpsNumber: "MPS-FIXTURE", mpsRevision: 1,
    checkpoint: "MPS_VENDOR", category: "VENDOR", partnerCode: "VENDOR-FIXTURE", code: "PART-FIXTURE", process: "PLATING",
    qty: 10, requiredQty: 10, uom: "PCS", sendDate: "2026-09-04", needDate, targetArrivalDate: needDate, leadTime: 1,
  }));
  const records = [];
  // No Prisma/client/stock delegate: all persistence in this test is in memory.
  const db = { etaConfirmation: {
    findUnique: async ({ where }) => records.find((record) => record.requestId === where.requestId) || null,
    findMany: async ({ where }) => records.filter((record) => where.sourceKey.in.includes(record.sourceKey)),
    create: async ({ data }) => { const record = { ...data, id: `fixture-${records.length}`, confirmedAt: new Date("2026-09-01") }; records.push(record); return record; },
  } };
  const originalList = monitor.list;
  monitor.list = async (tx, source, month, mpsNumber) => {
    assert.equal(source, "mps"); assert.equal(month, "2026-09"); assert.equal(mpsNumber, "MPS-FIXTURE");
    return { items: await store.attach(tx, fixtures) };
  };
  try {
    for (const [index, fixture] of fixtures.entries()) {
      const input = { id: fixture.id, mpsNumber: fixture.mpsNumber, month: "2026-09", sourceFingerprint: store.fingerprint(fixture),
        requestId: `vendor-window-fixture-${index}`, qty: 10, eta: fixture.needDate, leadTimeDays: 2, reference: "In-memory vendor answer" };
      const saved = await confirmation.confirm(db, "mps", input, { username: "fixture-purchasing" });
      assert.equal(saved.item.leadTimeFits, index === 1, "confirm response must include the evaluated LT window");
      assert.equal(saved.item.readiness.ready, index === 1, "on-time entered ETA cannot bypass impossible LT on save");
      assert.equal(saved.item.earliestReturnDate, "2026-09-07");
      const refreshed = (await store.attach(db, [fixture]))[0];
      assert.equal(refreshed.leadTimeFits, saved.item.leadTimeFits);
      assert.deepEqual(store.readiness(refreshed), saved.item.readiness, "read/refresh gate must agree with confirmation response");
      assert.equal(refreshed.sourceFingerprint, input.sourceFingerprint);
      assert.equal(refreshed.leadTime, 1, "baseline LT remains unchanged");
      assert.equal(refreshed.qty, 10, "no fabricated coverage qty");
      assert.equal((await confirmation.confirm(db, "mps", input, { username: "fixture-purchasing" })).duplicate, true);
    }
    assert.equal(records.length, 2, "duplicate retries create no extra confirmations");
    const ready = (await store.attach(db, [fixtures[1]]))[0];
    for (const leadTimeFits of [false, null, undefined]) assert.equal(store.readiness({ ...ready, leadTimeFits }).ready, false);
    const unknown = await store.withLeadTime({ ...ready, sendDate: null });
    assert.equal(unknown.leadTimeFits, null);
    assert.equal(unknown.earliestReturnDate, null);
    assert.equal(store.readiness(unknown).ready, false);
    const stale = (await store.attach(db, [{ ...fixtures[1], mpsRevision: 2 }]))[0];
    assert.equal(store.readiness(stale).ready, false);
    assert.equal(stale.confirmedLeadTimeDays, null);
    const customer = await store.withLeadTime({ checkpoint: "MPS_MATERIAL", category: "CUSTOMER", confirmedLeadTimeDays: 2, needDate: "2026-09-07" });
    assert.equal(customer.earliestReturnDate, undefined, "customer start and return must not be invented by decoration");
    assert.equal(customer.purchaseMaxDate, undefined);
    console.log("PASS ETA vendor integration: confirm + attach + readiness, impossible/feasible/unknown windows, stale revision, idempotence and customer isolation (in-memory only).");
  } finally {
    monitor.list = originalList;
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
