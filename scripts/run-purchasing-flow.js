require("dotenv").config({ quiet: true });
const { prisma } = require("../src/prisma");
const prCtrl = require("../src/prisma/controllers/purchasing/PurchaseRequisitionController");
const poCtrl = require("../src/prisma/controllers/purchasing/PurchaseOrderController");
const incomingCtrl = require("../src/prisma/controllers/incoming/IncomingTransactionController");

function invoke(fn, req = {}) {
  return new Promise((resolve, reject) => {
    const request = { params: {}, body: {}, query: {}, user: { username: "system", email: "system@local" }, ...req };
    const response = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(v) { resolve({ statusCode: this.statusCode, body: v }); } };
    Promise.resolve(fn(request, response, (error) => reject(error))).catch(reject);
  });
}

(async () => {
  const pr = await prisma.purchaseRequisition.findFirst({ where: { prNumber: "PR-MRP-20260727-001", isDeleted: false }, include: { details: { where: { isDeleted: false }, orderBy: { lineNumber: "asc" } } } });
  if (!pr) throw new Error("PR-MRP-20260727-001 tidak ditemukan");
  if (pr.status === "Draft") {
    const submitted = await invoke(prCtrl.submit, { params: { prNumber: pr.prNumber }, body: {} });
    if (submitted.statusCode >= 300) throw new Error(`PR submit gagal: ${submitted.body?.message}`);
  }
  const afterSubmit = await prisma.purchaseRequisition.findUnique({ where: { prNumber: pr.prNumber }, include: { details: { where: { isDeleted: false }, orderBy: { lineNumber: "asc" } } } });
  if (afterSubmit.status === "Submitted") {
    const approved = await invoke(prCtrl.approve, { params: { prNumber: pr.prNumber }, body: {} });
    if (approved.statusCode >= 300) throw new Error(`PR approve gagal: ${approved.body?.message}`);
  }
  const current = await prisma.purchaseRequisition.findUnique({ where: { prNumber: pr.prNumber }, include: { details: { where: { isDeleted: false }, orderBy: { lineNumber: "asc" } } } });
  const lines = current.details.filter((d) => Number(d.qty) > Number(d.orderedQty || 0)).map((d) => {
    const outstanding = Number(d.qty) - Number(d.orderedQty || 0);
    if (d.materialCode) {
      return { prDetailId: d.id, sourceQty: outstanding, supplierCode: "S001", purchasePackageUomCode: "COIL", purchasePackageQty: 2, conversionUomCode: d.uomCode || "KG", conversionFactor: outstanding / 2 };
    }
    return { prDetailId: d.id, sourceQty: outstanding, supplierCode: "S001", orderQty: outstanding, orderUomCode: d.uomCode || "PCS" };
  });
  const poResult = await invoke(prCtrl.convertToPO, { params: { prNumber: pr.prNumber }, body: { supplierCode: "S001", lines, currencyCode: "IDR" } });
  if (poResult.statusCode >= 300) throw new Error(`PR convert PO gagal: ${poResult.body?.message}`);
  const poNumbers = poResult.body?.purchaseOrders?.map((po) => po.poNumber) || [];
  for (const poNumber of poNumbers) {
    for (const [fn, label] of [[poCtrl.submitChecking, "submit PO"], [poCtrl.approve, "approve PO"], [poCtrl.send, "send PO"], [poCtrl.confirm, "confirm PO"]]) {
      const result = await invoke(fn, { params: { poNumber }, body: {} });
      if (result.statusCode >= 300) throw new Error(`${label} ${poNumber} gagal: ${result.body?.message}`);
    }
    const po = await prisma.purchaseOrder.findUnique({ where: { poNumber }, include: { details: { where: { isDeleted: false }, orderBy: { lineNumber: "asc" } } } });
    const warehouse = await prisma.warehouse.findFirst({ where: { isDeleted: false, isActive: true }, select: { warehouseCode: true } });
    const rack = await prisma.rack.findFirst({ where: { isDeleted: false, isActive: true, warehouseCode: warehouse.warehouseCode }, select: { rackCode: true } });
    if (!warehouse) throw new Error("Tidak ada warehouse aktif");
    const received = await invoke(incomingCtrl.receivePurchaseOrder, { body: { poNumber, warehouseCode: warehouse.warehouseCode, details: po.details.map((d) => ({ poDetailId: d.id, qtyReceived: d.qty, rackCode: rack?.rackCode || null, lotNumber: `LOT-${poNumber}-${d.lineNumber}`, supplierLotNumber: `SUP-${d.lineNumber}` })) } });
    if (received.statusCode >= 300) throw new Error(`GR ${poNumber} gagal: ${received.body?.message}`);
    const grNumber = received.body.grNumber;
    const inspected = await invoke(incomingCtrl.createInspection, { body: { grNumber } });
    if (inspected.statusCode >= 300) throw new Error(`IQC ${grNumber} gagal: ${inspected.body?.message}`);
    const decisions = inspected.body.details.map((d) => ({ grDetailId: d.grDetailId, qtyAccepted: d.qtyInspected || po.details.find((p) => p.id === d.grDetailId)?.qty || 0, qtyRejected: 0 }));
    const completed = await invoke(incomingCtrl.completeInspection, { params: { inspectionNumber: inspected.body.inspectionNumber }, body: { decisions } });
    if (completed.statusCode >= 300) throw new Error(`Complete IQC gagal: ${completed.body?.message}`);
    const putaway = await invoke(incomingCtrl.putawayAccepted, { params: { inspectionNumber: inspected.body.inspectionNumber }, body: {} });
    if (putaway.statusCode >= 300) throw new Error(`Putaway gagal: ${putaway.body?.message}`);
    console.log(JSON.stringify({ poNumber, grNumber, inspectionNumber: inspected.body.inspectionNumber, putaway: putaway.body }, null, 2));
  }
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
