require("dotenv").config({ quiet: true });
const { prisma } = require("../src/prisma");
const ctrl = require("../src/prisma/controllers/production/ManufacturingOrderController");
function invoke(body) { return new Promise((resolve, reject) => { const req = { body, user: { username: "real-test" } }; const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(v) { resolve({ statusCode: this.statusCode, body: v }); } }; Promise.resolve(ctrl.bulkCreate(req, res, (e) => reject(e))).catch(reject); }); }
(async () => {
  const plans = await prisma.monthlyProductionPlan.findMany({ where: { isDeleted: false, status: "Released" }, include: { details: { where: { isDeleted: false }, orderBy: { lineNumber: "asc" } } }, orderBy: { planNumber: "asc" } });
  const out = [];
  for (const plan of plans) {
    // MO hanya dibuat untuk FG parent; child/process line diproduksi melalui routing parent.
    const items = plan.details.filter((row) => row.lineNumber === 1).map((row) => ({ referenceType: "MonthlyProductionPlan", monthlyProductionPlanNumber: plan.planNumber, monthlyProductionPlanLineNumber: row.lineNumber, qtyPlanned: Number(row.qtyPlanned), plannedStartDate: plan.periodStart.toISOString().slice(0, 10), plannedEndDate: row.requiredDate.toISOString().slice(0, 10), status: "Planned" }));
    const result = await invoke({ items });
    out.push({ planNumber: plan.planNumber, statusCode: result.statusCode, message: result.body?.message, count: result.body?.items?.length, errors: result.body?.errors });
  }
  console.log(JSON.stringify(out, null, 2));
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
