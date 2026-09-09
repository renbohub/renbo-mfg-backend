const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { monitoringPeriod, downtimeDuration, aggregateMachine, aggregateSummary, buildOeeMonitoring } = require("../src/prisma/services/oeeMonitoringService");

const machine = { id: "machine-p1", machineCode: "P1", machineName: "Press 110 T", status: "Active", cycleTime: 2 };
const makeLog = (overrides = {}) => ({
  id: "log-1", logNumber: "LOG-20260908-001", logDate: new Date("2026-09-08T00:00:00Z"),
  machineCode: "P1", woId: "wo-1", shift: "1A", operatorName: "Acep", status: "Submitted",
  qtyPlanned: 6000, qtyProduced: 5000, qtyGood: 4900, qtyReject: 90, qtyRework: 10,
  startTime: new Date("2026-09-08T00:00:00Z"), endTime: new Date("2026-09-08T08:00:00Z"),
  runningMinutes: 480, downtime: 80, downtimeLogs: [],
  updatedAt: new Date("2026-09-08T08:01:00Z"), createdAt: new Date("2026-09-08T00:00:00Z"),
  manufacturingOrder: { moNumber: "MO-1", part: { partCode: "BR-1", partNumber: "11054-0075", partName: "Bracket" } },
  workOrder: { woNumber: "WO-1", cycleTime: 4, machine },
  ...overrides,
});
const makeDowntime = (overrides = {}) => ({
  id: "dt-1", reason: "Dandori dies", category: "SETUP", durationMinutes: 30,
  machineCode: "P1", shift: "1A", status: "Closed", downtimeDate: new Date("2026-09-08T00:00:00Z"),
  startTime: new Date("2026-09-08T01:00:00Z"), endTime: new Date("2026-09-08T01:30:00Z"),
  ...overrides,
});

test("Jakarta business date uses a half-open day independent of host timezone", () => {
  const day = monitoringPeriod({ date: "2026-09-08" });
  assert.equal(day.start.toISOString(), "2026-09-07T17:00:00.000Z");
  assert.equal(day.end.toISOString(), "2026-09-08T17:00:00.000Z");
  assert.equal(monitoringPeriod({}, new Date("2026-09-07T17:00:00Z")).date, "2026-09-08");
  assert.equal(monitoringPeriod({}, new Date("2026-09-07T16:59:59Z")).date, "2026-09-07");
  assert.equal(monitoringPeriod({ date: "2024-02-29" }).date, "2024-02-29");
});

test("invalid dates and query structures fail before querying the database", async () => {
  for (const date of ["2026-02-29", "2026-09-31", "2026-13-01", "2026-00-10", "2026-9-8", "invalid", "2026-09-08T00:00:00Z", ["2026-09-08"]]) {
    assert.throws(() => monitoringPeriod({ date }), error => error.statusCode === 400, String(date));
  }
  for (const query of [{ shift: ["1A"] }, { shift: {} }, { shift: "A".repeat(21) }, { machineId: {} }]) {
    await assert.rejects(buildOeeMonitoring({}, { date: "2026-09-08", ...query }), error => error.statusCode === 400);
  }
});

test("OEE uses actual recorded duration, standard CT and good output", () => {
  const result = aggregateMachine(machine, [makeLog()]);
  assert.equal(result.metrics.plannedMinutes, 480);
  assert.equal(result.metrics.runtimeMinutes, 400);
  assert.equal(result.metrics.availability, 83.33);
  assert.equal(result.metrics.performance, 83.33);
  assert.equal(result.metrics.quality, 98);
  assert.equal(result.metrics.oee, 68.06);
  assert.equal(result.metrics.achievementRate, 81.67);
  assert.equal(result.metrics.rejectRate, 1.8);
  assert.equal(result.metrics.idealCycleTimeSeconds, 4);
  assert.equal(result.production.partNumber, "11054-0075");
  assert.equal(result.status, "recorded");
  assert.equal(result.isRealtime, false);
  assert.match(result.dataQuality.join(" "), /bukan seluruh waktu shift/);
});

test("downtime detail replaces subtotal and duplicates cannot be counted twice", () => {
  const a = makeDowntime();
  const b = makeDowntime({ id: "dt-2", durationMinutes: 20 });
  const result = aggregateMachine(machine, [makeLog({ downtime: 99, downtimeLogs: [a, a, b] })]);
  assert.equal(result.metrics.downtimeMinutes, 50);
  assert.equal(result.metrics.runtimeMinutes, 430);
  assert.equal(result.downtimeHistory.length, 2);
  assert.equal(result.downtimeReasons[0].count, 2);
  assert.equal(result.downtimeReasons[0].durationMinutes, 50);
  assert.match(result.dataQuality.join(" "), /subtotal production log berbeda/);
});

test("summary-only downtime history never invents event timestamps", () => {
  const result = aggregateMachine(machine, [makeLog({ downtimeReason: "Material belum siap" })]);
  assert.equal(result.downtimeHistory[0].source, "production_log_summary");
  assert.equal(result.downtimeHistory[0].startTime, null);
  assert.equal(result.downtimeHistory[0].endTime, null);
  assert.equal(result.downtimeHistory[0].durationMinutes, 80);
});

test("unlinked downtime is visible but does not subtract twice from recorded runtime", () => {
  const result = aggregateMachine(machine, [makeLog()], [makeDowntime()]);
  assert.equal(result.metrics.downtimeMinutes, 110);
  assert.equal(result.metrics.loggedDowntimeMinutes, 80);
  assert.equal(result.metrics.unlinkedDowntimeMinutes, 30);
  assert.equal(result.metrics.runtimeMinutes, 400);
  assert.equal(result.metrics.oee, 68.06);
  assert.match(result.dataQuality.join(" "), /belum dapat dialokasikan/);
});

test("empty machines have unknown OEE, not an invented zero or machine state", () => {
  const result = aggregateMachine(machine);
  assert.equal(result.status, "no_data");
  assert.equal(result.metrics.oee, null);
  assert.equal(result.metrics.availability, null);
  assert.equal(result.metrics.quality, null);
  assert.equal(result.metrics.runtimeMinutes, null);
  assert.equal(result.metrics.targetOutput, null);
  assert.equal(result.metrics.totalProduced, 0);
  assert.equal(result.production, null);
  assert.equal(result.lastUpdatedAt, null);
  assert.deepEqual(result.downtimeHistory, []);
});

test("a fully stopped recorded span gives zero availability and OEE; missing CT stays unknown", () => {
  const stopped = aggregateMachine(machine, [makeLog({ qtyProduced: 0, qtyGood: 0, qtyReject: 0, qtyRework: 0, downtime: 480 })]);
  assert.equal(stopped.metrics.availability, 0);
  assert.equal(stopped.metrics.oee, 0);
  assert.equal(stopped.metrics.quality, null);
  const noCt = aggregateMachine({ ...machine, cycleTime: null }, [makeLog({ workOrder: null })]);
  assert.equal(noCt.metrics.performance, null);
  assert.equal(noCt.metrics.oee, null);
  assert.equal(noCt.metrics.quality, 98);
});

test("missing or inconsistent durations cannot produce misleading percentages", () => {
  for (const fields of [
    { runningMinutes: null, startTime: null, endTime: null },
    { runningMinutes: -1, startTime: null, endTime: null },
    { downtime: null },
    { downtime: 500 },
    { runningMinutes: null, startTime: "2026-09-08T08:00:00Z", endTime: "2026-09-08T00:00:00Z" },
  ]) {
    const result = aggregateMachine(machine, [makeLog(fields)]);
    assert.equal(result.metrics.runtimeMinutes, null);
    assert.equal(result.metrics.oee, null);
  }
  const badOutput = aggregateMachine(machine, [makeLog({ qtyGood: 5001 })]);
  assert.equal(badOutput.metrics.quality, null);
  assert.equal(badOutput.metrics.oee, null);
});

test("open downtime default zero is unknown, completed elapsed timestamps are usable", () => {
  assert.equal(downtimeDuration(makeDowntime({ durationMinutes: 0, status: "Open", endTime: null })), null);
  assert.equal(downtimeDuration(makeDowntime({ durationMinutes: 0 })), 30);
  assert.equal(downtimeDuration(makeDowntime({ durationMinutes: 0, startTime: null, endTime: null })), 0);
});

test("overlapping machine logs block time aggregation, adjacent logs remain valid", () => {
  const first = makeLog();
  const overlap = makeLog({ id: "log-2" });
  assert.equal(aggregateMachine(machine, [first, overlap]).metrics.oee, null);
  const adjacent = makeLog({ id: "log-2", startTime: "2026-09-08T08:00:00Z", endTime: "2026-09-08T16:00:00Z" });
  const result = aggregateMachine(machine, [first, adjacent]);
  assert.equal(result.metrics.oee, 68.06);
  assert.equal(result.metrics.plannedMinutes, 960);
  assert.equal(result.metrics.targetOutput, 6000);
});

test("multi-log targets count each DPS once and latest production follows run time", () => {
  const schedule = { id: "dps-1", plannedQty: 8000 };
  const first = makeLog({ dailyProductionSchedule: schedule, updatedAt: "2026-09-09T00:00:00Z" });
  const second = makeLog({ id: "log-2", logNumber: "LOG-002", qtyPlanned: 3000, dailyProductionSchedule: schedule,
    startTime: "2026-09-08T08:00:00Z", endTime: "2026-09-08T16:00:00Z", workOrder: { cycleTime: 2, outputPartName: "Bracket RHS" } });
  const result = aggregateMachine(machine, [first, second]);
  assert.equal(result.metrics.targetOutput, 8000);
  assert.equal(result.metrics.idealCycleTimeSeconds, 3);
  assert.equal(result.production.logNumber, "LOG-002");
  assert.equal(result.production.partName, "Bracket RHS");
  assert.equal(result.lastUpdatedAt, "2026-09-09T00:00:00.000Z");
});

test("fleet OEE is weighted by recorded duration, excluding no-data assets", () => {
  const first = aggregateMachine(machine, [makeLog({ runningMinutes: 100, downtime: 0, qtyProduced: 600, qtyGood: 600, qtyReject: 0, qtyRework: 0,
    workOrder: { cycleTime: 10 } })]);
  const second = aggregateMachine({ ...machine, id: "P2" }, [makeLog({ runningMinutes: 300, downtime: 0, qtyProduced: 900, qtyGood: 900, qtyReject: 0, qtyRework: 0,
    workOrder: { cycleTime: 10 } })]);
  const summary = aggregateSummary([first, second, aggregateMachine({ ...machine, id: "P3" })]);
  assert.equal(summary.oee, 62.5);
  assert.equal(summary.performance, 62.5);
  assert.equal(summary.machineCount, 3);
  assert.equal(summary.machinesWithData, 2);
  assert.equal(summary.goodOutput, 1500);
});

function fakePrisma(logs, downtimes = []) {
  const calls = [];
  const create = (name, result) => ({ findMany: async query => { calls.push({ name, query }); return result; } });
  return { calls,
    machine: create("machine", [machine, { ...machine, id: "machine-p2", machineCode: "P2", status: "Maintenance" }]),
    productionLog: create("productionLog", logs), downtimeLog: create("downtimeLog", downtimes),
  };
}

test("report keeps all assets and day shifts while applying exact selected shift", async () => {
  const db = fakePrisma([makeLog(), makeLog({ id: "shift-2", shift: "2A" })]);
  const result = await buildOeeMonitoring(db, { date: "2026-09-08", shift: "1A" });
  assert.deepEqual(result.shifts, ["1A", "2A"]);
  assert.equal(result.machines.length, 2);
  assert.equal(result.machines[0].logCount, 1);
  assert.equal(result.machines[1].status, "no_data");
  const logQuery = db.calls.find(call => call.name === "productionLog").query;
  assert.equal(logQuery.where.logDate.gte.toISOString(), "2026-09-07T17:00:00.000Z");
  assert.equal(logQuery.where.logDate.lt.toISOString(), "2026-09-08T17:00:00.000Z");
  assert.equal(logQuery.where.status.not, "Cancelled");
  assert.equal(logQuery.where.isDeleted, false);
  assert.equal(logQuery.take, undefined);
  assert.deepEqual(logQuery.select.downtimeLogs.where, { isDeleted: false, status: { not: "Cancelled" } });
  assert.equal(db.calls.find(call => call.name === "downtimeLog").query.where.productionLogId, null);
});

test("machine filtering, missing machines, legacy codes and no machine references remain explicit", async () => {
  const result = await buildOeeMonitoring(fakePrisma([makeLog({ machineCode: "LEGACY", workOrder: null }), makeLog({ id: "unknown", machineCode: null, workOrder: null })]), { date: "2026-09-08" });
  assert.equal(result.machines.find(row => row.machineCode === "LEGACY").logCount, 1);
  assert.match(result.dataQuality.join(" "), /tidak memiliki referensi mesin/);
  const filtered = await buildOeeMonitoring(fakePrisma([makeLog()]), { date: "2026-09-08", machineId: "machine-p2" });
  assert.equal(filtered.machines.length, 1);
  await assert.rejects(buildOeeMonitoring(fakePrisma([]), { date: "2026-09-08", machineId: "missing" }), error => error.statusCode === 404);
});

test("route is read-only, protected by auth and report permission", () => {
  const index = fs.readFileSync(path.join(__dirname, "../src/prisma/routes/index.js"), "utf8");
  assert.match(index, /api\.use\("\/production\/production-reports", auth, productionReportsRouter\)/);
  const route = fs.readFileSync(path.join(__dirname, "../src/prisma/routes/production/production-reports.js"), "utf8");
  assert.match(route, /router\.get\("\/oee-monitoring", authorize\("productionReports", "read"\), ctrl\.oeeMonitoring\)/);
});

test("real route middleware rejects unauthorized readers and controller returns validation errors", async () => {
  const databaseModule = require.resolve("../src/prisma/index");
  const previous = require.cache[databaseModule];
  const db = fakePrisma([makeLog()]);
  require.cache[databaseModule] = { id: databaseModule, filename: databaseModule, loaded: true, exports: { prisma: db } };
  try {
    const { auth } = require("../src/prisma/middleware/auth");
    const router = require("../src/prisma/routes/production/production-reports");
    const handlers = router.stack.find(layer => layer.route?.path === "/oee-monitoring").route.stack.map(layer => layer.handle);
    const response = () => ({ statusCode: 200, body: null,
      status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
    const req = { originalUrl: "/api/production/production-reports/oee-monitoring", headers: {}, query: { date: "2026-09-08" } };
    const notAuthenticated = response();
    await auth(req, notAuthenticated, () => assert.fail("Unauthenticated access must stop"));
    assert.equal(notAuthenticated.statusCode, 401);
    const noPermission = response();
    handlers[0]({ ...req, user: { listMenu: [] } }, noPermission, () => assert.fail("Missing permission must stop"));
    assert.equal(noPermission.statusCode, 403);
    const allowed = { ...req, user: { listMenu: [{ resource: "productionReports", actions: ["read"] }] } };
    let authorized = false;
    handlers[0](allowed, response(), () => { authorized = true; });
    assert.equal(authorized, true);
    const result = response();
    await handlers[1](allowed, result, error => { throw error; });
    assert.equal(result.body.summary.machinesWithData, 1);
    const countBeforeInvalid = db.calls.length;
    let validationError;
    await handlers[1]({ ...allowed, query: { date: "2026-02-29" } }, response(), error => { validationError = error; });
    assert.equal(validationError.statusCode, 400);
    assert.equal(db.calls.length, countBeforeInvalid);
  } finally {
    if (previous) require.cache[databaseModule] = previous;
    else delete require.cache[databaseModule];
  }
});
