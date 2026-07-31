/* eslint-disable no-console */
require("dotenv").config({ quiet: true });
const { prisma } = require("../src/prisma");
const ctrl = require("../src/prisma/controllers/planning/MRPController");

function invoke(fn, { body = {}, params = {}, user = { username: "system" } } = {}) {
  return new Promise((resolve, reject) => {
    const req = { body, params, user };
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { resolve({ statusCode: this.statusCode, body: value }); return this; } };
    fn(req, res, (error) => reject(error));
  });
}

(async () => {
  const runs = await prisma.mRPRun.findMany({ where: { isDeleted: false, status: "Completed" }, orderBy: { runDate: "asc" }, select: { runNumber: true, mpsNumber: true } });
  const plans = [];
  for (const run of runs) {
    const result = await invoke(ctrl.createProductionPlanOutput, { params: { runNumber: run.runNumber }, body: { productionPercent: 100 } });
    if (result.statusCode >= 300) throw new Error(`MPP ${run.runNumber}: ${JSON.stringify(result.body)}`);
    plans.push(result.body);
  }
  console.log(JSON.stringify(plans, null, 2));
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
