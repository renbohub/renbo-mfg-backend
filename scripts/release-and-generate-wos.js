require("dotenv").config({ quiet: true });
const { prisma } = require("../src/prisma");
const ctrl = require("../src/prisma/controllers/production/ManufacturingOrderController");

function invoke(fn, moNumber, body = {}) {
  return new Promise((resolve, reject) => {
    const req = { params: { moNumber }, body, user: { username: "system" } };
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(v) { resolve({ statusCode: this.statusCode, body: v }); } };
    Promise.resolve(fn(req, res, (error) => reject(error))).catch(reject);
  });
}

(async () => {
  const mos = await prisma.manufacturingOrder.findMany({ where: { isDeleted: false }, select: { moNumber: true, status: true }, orderBy: { moNumber: "asc" } });
  const out = [];
  for (const mo of mos) {
    let release = { statusCode: 200, body: { status: mo.status } };
    if (mo.status !== "Released") release = await invoke(ctrl.release, mo.moNumber, { allowShortage: true, skipReservation: true });
    let generated = null;
    if (release.statusCode < 300) generated = await invoke(ctrl.generateWorkOrders, mo.moNumber);
    out.push({ moNumber: mo.moNumber, release: { statusCode: release.statusCode, message: release.body?.message, status: release.body?.manufacturingOrder?.status }, generated: generated && { statusCode: generated.statusCode, message: generated.body?.message, workOrders: generated.body?.workOrders?.map((wo) => wo.woNumber) } });
  }
  console.log(JSON.stringify(out, null, 2));
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
