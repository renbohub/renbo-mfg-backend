const assert = require("node:assert/strict");
const clock = require("../src/prisma/utils/businessClock");
const { classifyProcurementWindow } = require("../src/prisma/services/planning/procurementSchedulingService");

async function main() {
  for (const invalid of [undefined, "", "2026-02-29", "2026-04-31", "2026-13-01", "26-01-01", "2026-01-01T00:00:00Z", "<script>", 123]) {
    assert.throws(() => clock.validateDate(invalid), { status: 400 });
  }
  assert.equal(clock.validateDate("2028-02-29"), "2028-02-29");
  assert.equal(clock.validateDate(null), null);
  const realBefore = Date.now();
  const values = await Promise.all(["2026-01-19", "2027-12-31"].map((date) => clock.withBusinessDate(date, async () => {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(clock.businessNow().toISOString().slice(0, 10), date);
    const copy = clock.businessNow(); copy.setFullYear(2000);
    assert.equal(clock.businessNow().toISOString().slice(0, 10), date);
    assert.ok(new Date().getTime() >= realBefore);
    return date;
  })));
  assert.equal(values.length, 2);
  assert.ok(clock.businessNow().getTime() >= realBefore);
  const early = clock.withBusinessDate("2026-01-01", () => classifyProcurementWindow({ materialRequiredDate: "2026-02-01", latestPrDate: "2026-01-15" }));
  const late = clock.withBusinessDate("2026-03-01", () => classifyProcurementWindow({ materialRequiredDate: "2026-02-01", latestPrDate: "2026-01-15" }));
  assert.notDeepEqual(early, late, "Procurement classification must follow demo date");

  let row = null;
  const db = { systemSetting: {
    findUnique: async () => row,
    upsert: async ({ create, update }) => { row = row ? { ...row, ...update } : create; return row; },
  } };
  const indexPath = require.resolve("../src/prisma/index");
  require.cache[indexPath] = { id: indexPath, filename: indexPath, loaded: true, exports: { prisma: db } };
  const controller = require("../src/prisma/controllers/SystemSettingController");
  const { authorize } = require("../src/prisma/middleware/auth");
  const guard = authorize("systemSettings", "update");
  for (const [user, expected] of [[undefined, 401], [{}, 403], [{ isSuperAdmin: true }, 200]]) {
    let status = 200;
    let allowed = false;
    const authRes = { status(value) { status = value; return this; }, json() {} };
    guard({ user, headers: {}, method: "PATCH", originalUrl: "/api/system/settings/current-date", get() { return undefined; } }, authRes, () => { allowed = true; });
    assert.equal(status, expected);
    assert.equal(allowed, expected === 200);
  }
  let body;
  const res = { json(value) { body = value; return this; }, set() { return this; } };
  const next = (err) => { if (err) throw err; };
  await controller.updateCurrentDate({ body: { demoDate: "2028-02-29" }, user: { username: "demo-admin" } }, res, next);
  assert.equal(row.updatedBy, "demo-admin");
  await controller.getCurrentDate({}, res, next);
  assert.deepEqual(body, { demoDate: "2028-02-29", enabled: true });
  await clock.clockMiddleware(db)({}, {}, () => assert.equal(clock.businessNow().toISOString().slice(0, 10), "2028-02-29"));
  await controller.updateCurrentDate({ body: { demoDate: null }, user: { username: "demo-admin" } }, res, next);
  assert.equal(await clock.readDemoDate(db), null);
  assert.deepEqual(body, { demoDate: null, enabled: false });
  console.log("Demo clock: validation, async isolation, real audit time, procurement, persistence and reset passed.");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
