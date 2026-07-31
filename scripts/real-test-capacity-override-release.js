require("dotenv").config({ quiet: true });
const { prisma } = require("../src/prisma");
const ctrl = require("../src/prisma/controllers/planning/MonthlyProductionPlanController");
function invoke(fn, planNumber, body = {}) { return new Promise((resolve, reject) => { const req = { params: { planNumber }, body, user: { username: "real-test" } }; const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(v) { resolve({ statusCode: this.statusCode, body: v }); } }; Promise.resolve(fn(req, res, (e) => reject(e))).catch(reject); }); }
(async () => {
  const plans = await prisma.monthlyProductionPlan.findMany({ where: { isDeleted: false, status: { in: ["Confirmed", "Draft"] } }, select: { planNumber: true, status: true }, orderBy: { planNumber: "asc" } });
  const out = [];
  for (const plan of plans) {
    const confirmed = await invoke(ctrl.confirm, plan.planNumber, {});
    const override = confirmed.statusCode < 300 ? await invoke(ctrl.capacityOverride, plan.planNumber, { reason: "REAL TEST: allow capacity shortage for controlled partial production and reschedule." }) : confirmed;
    const released = override.statusCode < 300 ? await invoke(ctrl.release, plan.planNumber, {}) : override;
    out.push({ planNumber: plan.planNumber, confirm: { statusCode: confirmed.statusCode, message: confirmed.body?.message }, override: { statusCode: override.statusCode, message: override.body?.message }, release: { statusCode: released.statusCode, message: released.body?.message, status: released.body?.status } });
  }
  console.log(JSON.stringify(out, null, 2));
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
