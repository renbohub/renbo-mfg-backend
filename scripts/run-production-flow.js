require("dotenv").config({ quiet: true });
const { prisma } = require("../src/prisma");
const logCtrl = require("../src/prisma/controllers/production/ProductionLogController");
const qcCtrl = require("../src/prisma/controllers/production/QualityInspectionController");

function invoke(fn, req = {}) {
  return new Promise((resolve, reject) => {
    const request = { params: {}, body: {}, query: {}, user: { username: "system", email: "system@local" }, ...req };
    const response = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(v) { resolve({ statusCode: this.statusCode, body: v }); } };
    Promise.resolve(fn(request, response, (error) => reject(error))).catch(reject);
  });
}

(async () => {
  const [machine, dies, warehouse] = await Promise.all([
    prisma.machine.findFirst({ where: { isDeleted: false, status: "Active" }, select: { id: true, machineCode: true } }),
    prisma.dies.findFirst({ where: { isDeleted: false, status: "Active" }, select: { id: true, diesCode: true } }),
    prisma.warehouse.findFirst({ where: { isDeleted: false, isActive: true }, select: { warehouseCode: true } }),
  ]);
  if (!machine || !dies || !warehouse) throw new Error("Master machine, dies, dan warehouse aktif wajib tersedia.");
  const rack = await prisma.rack.findFirst({ where: { isDeleted: false, isActive: true, warehouseCode: warehouse.warehouseCode }, select: { rackCode: true } });
  const rackCode = rack?.rackCode || null;
  const mos = await prisma.manufacturingOrder.findMany({ where: { isDeleted: false, status: "Released" }, select: { id: true, moNumber: true, qtyPlanned: true, uomCode: true }, orderBy: { moNumber: "asc" } });
  const output = [];
  for (const mo of mos) {
    const wos = await prisma.workOrder.findMany({ where: { moId: mo.id, isDeleted: false }, orderBy: { sequence: "asc" }, select: { id: true, woNumber: true, sequence: true, plannedQty: true, processId: true, outputPartCode: true } });
    await prisma.workOrder.updateMany({ where: { id: { in: wos.map((wo) => wo.id) } }, data: { machineId: machine.id, diesId: dies.id, shift: "1A", operatorName: "system", status: "In Production", startTime: new Date() } });
    const moResult = { moNumber: mo.moNumber, workOrders: [] };
    for (const [index, wo] of wos.entries()) {
      const qty = Number(wo.plannedQty || mo.qtyPlanned || 0);
      const created = await invoke(logCtrl.create, { body: { moId: mo.id, woId: wo.id, shift: "1A", operatorName: "system", processCode: null, machineCode: machine.machineCode, qtyPlanned: qty, qtyProduced: qty, qtyGood: qty, qtyReject: 0, logDate: new Date().toISOString(), startTime: new Date().toISOString(), endTime: new Date(Date.now() + 3600000).toISOString(), notes: `Flow test dua bulan ${mo.moNumber}` } });
      if (created.statusCode >= 300) throw new Error(`Create Production Log ${wo.woNumber} gagal: ${created.body?.message}`);
      const logNumber = created.body.logNumber;
      const submitted = await invoke(logCtrl.submit, { params: { logNumber }, body: {} });
      if (submitted.statusCode >= 300) throw new Error(`Submit Log ${logNumber} gagal: ${submitted.body?.message}`);
      const approved = await invoke(logCtrl.approve, { params: { logNumber }, body: { goodDestination: { warehouseCode: warehouse.warehouseCode, rackCode, lotNumber: `WIP-${mo.moNumber}-${wo.sequence}` } } });
      if (approved.statusCode >= 300) throw new Error(`Approve Log ${logNumber} gagal: ${approved.body?.message}`);
      const qc = await invoke(qcCtrl.create, { body: { productionLogId: created.body.id, moId: mo.id, woId: wo.id, qtyInspected: qty, qtyPassed: qty, qtyFailed: 0, inspectedBy: "system", notes: `QC flow test ${mo.moNumber}` } });
      if (qc.statusCode >= 300) throw new Error(`Create QC ${wo.woNumber} gagal: ${qc.body?.message}`);
      const completed = await invoke(qcCtrl.complete, { params: { inspectionNumber: qc.body.inspectionNumber }, body: { decision: "Passed", approvedBy: "system", passedDestination: { warehouseCode: warehouse.warehouseCode, rackCode, qty } } });
      if (completed.statusCode >= 300) throw new Error(`Complete QC ${qc.body.inspectionNumber} gagal: ${completed.body?.message}`);
      let fgReceipt = null;
      if (index === wos.length - 1) {
        fgReceipt = await invoke(qcCtrl.receiveFg, { params: { inspectionNumber: qc.body.inspectionNumber }, body: { qty, warehouseCode: warehouse.warehouseCode, rackCode, lotNumber: `FG-${mo.moNumber}` } });
        if (fgReceipt.statusCode >= 300) throw new Error(`FG Receipt ${qc.body.inspectionNumber} gagal: ${fgReceipt.body?.message}`);
      }
      moResult.workOrders.push({ woNumber: wo.woNumber, logNumber, inspectionNumber: qc.body.inspectionNumber, fgReceipt: fgReceipt?.body?.fgMovementNumber || null });
    }
    output.push(moResult);
  }
  console.log(JSON.stringify({ machine: machine.machineCode, dies: dies.diesCode, warehouse: warehouse.warehouseCode, rackCode, output }, null, 2));
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
