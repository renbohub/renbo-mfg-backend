const { prisma } = require("../src/prisma");
const controlTower = require("../src/prisma/controllers/dashboard/ControlTowerController");
const mpsController = require("../src/prisma/controllers/planning/MPSController");
const { buildCapacitySnapshot } = require("../src/prisma/services/planning/capacityPlanningService");
const { getFormulaSet } = require("../src/prisma/services/masterFormulaService");

function responseCapture() {
  return {
    code: 200,
    payload: null,
    status(code) { this.code = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
}

async function call(handler, req) {
  const res = responseCapture();
  await handler(req, res, (error) => { throw error; });
  if (res.code >= 400) throw new Error(res.payload?.message || `HTTP ${res.code}`);
  return res.payload;
}

async function main() {
  const formulaModules = await Promise.all(["planning", "capacity", "purchasing", "inventory", "production"].map(async (moduleCode) => [moduleCode, (await getFormulaSet(prisma, moduleCode)).size]));
  console.log("PASS formula modules", Object.fromEntries(formulaModules));

  const tower = await call(controlTower.list, { query: { page: 1, limit: 1 } });
  console.log("PASS control tower list", { total: tower.total, returned: tower.items.length });
  if (tower.items[0]?.soNumber) {
    const detail = await call(controlTower.get, { params: { soNumber: tower.items[0].soNumber } });
    console.log("PASS control tower detail", detail.soNumber);
  }

  const mps = await prisma.mPS.findFirst({ where: { isDeleted: false }, orderBy: { createdAt: "desc" }, select: { mpsNumber: true, sourceKey: true } });
  console.log("PASS MPS source key schema", mps || { empty: true });
  if (mps?.mpsNumber) {
    const detail = await call(mpsController.get, { params: { mpsNumber: mps.mpsNumber } });
    console.log("PASS MPS readiness", { mpsNumber: mps.mpsNumber, readiness: detail.readiness });
  }

  const date = new Date().toISOString().slice(0, 10);
  const capacity = await buildCapacitySnapshot(prisma, { startDate: date, endDate: date });
  console.log("PASS capacity formula snapshot", capacity.summary);
}

main()
  .catch((error) => { console.error("FAIL P1 readonly smoke", error); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
