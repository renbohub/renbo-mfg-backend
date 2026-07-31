require("dotenv").config({ quiet: true });
const { prisma } = require("../src/prisma");
const ctrl = require("../src/prisma/controllers/production/ManufacturingOrderController");
function invoke(fn, moNumber, body = {}) { return new Promise((resolve, reject) => { const req = { params: { moNumber }, body, user: { username: "system" } }; const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(v) { resolve({ statusCode: this.statusCode, body: v }); } }; Promise.resolve(fn(req, res, reject)).catch(reject); }); }
(async () => {
  const mos = await prisma.manufacturingOrder.findMany({ where: { isDeleted: false, status: "Released" }, select: { moNumber: true, qtyPlanned: true } });
  const warehouse = await prisma.warehouse.findFirst({ where: { isDeleted: false, isActive: true }, select: { warehouseCode: true } });
  const rack = warehouse ? await prisma.rack.findFirst({ where: { isDeleted: false, isActive: true, warehouseCode: warehouse.warehouseCode }, select: { rackCode: true } }) : null;
  const output = [];
  for (const mo of mos) {
    const started = await invoke(ctrl.start, mo.moNumber);
    if (started.statusCode >= 300) throw new Error(`Start ${mo.moNumber} gagal: ${started.body?.message}`);
    const completed = await invoke(ctrl.complete, mo.moNumber, { qtyProduced: mo.qtyPlanned, qtyGood: mo.qtyPlanned, qtyReject: 0, allowIncompleteWorkOrders: false, allowOpenMaterialIssues: true, allowOpenQc: false, allowRejectedQc: false, allowZeroGood: false, allowUnderPlannedQty: false, receiveFinishedGoods: false, warehouseCode: warehouse?.warehouseCode, rackCode: rack?.rackCode });
    if (completed.statusCode >= 300) throw new Error(`Complete ${mo.moNumber} gagal: ${completed.body?.message}`);
    output.push({ moNumber: mo.moNumber, status: completed.body?.status || completed.body?.manufacturingOrder?.status });
  }
  console.log(JSON.stringify(output, null, 2));
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
