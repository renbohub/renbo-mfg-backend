/* eslint-disable no-console */
require("dotenv").config({ quiet: true });
const { prisma } = require("../src/prisma");
const ctrl = require("../src/prisma/controllers/planning/MonthlyProductionPlanController");
function invoke(fn, { body = {}, params = {}, user = { username: "system" } } = {}) {
  return new Promise((resolve, reject) => {
    const req = { body, params, user };
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { resolve({ statusCode: this.statusCode, body: value }); return this; } };
    fn(req, res, (error) => reject(error));
  });
}
(async () => {
  const plans = await prisma.monthlyProductionPlan.findMany({ where: { isDeleted: false }, orderBy: { planMonth: "asc" }, select: { planNumber: true, status: true } });
  const results = [];
  for (const plan of plans) {
    const override = await invoke(ctrl.capacityOverride, { params: { planNumber: plan.planNumber }, body: { reason: "Override test run dua bulan; overload dipantau dan dijadwalkan ulang oleh PPIC." } });
    const released = await invoke(ctrl.release, { params: { planNumber: plan.planNumber }, body: {} });
    results.push({ planNumber: plan.planNumber, override, released });
  }
  console.log(JSON.stringify(results, null, 2));
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
