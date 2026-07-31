require("dotenv").config({ quiet: true });
const { prisma } = require("../src/prisma");
const prCtrl = require("../src/prisma/controllers/purchasing/PurchaseRequisitionController");
const poCtrl = require("../src/prisma/controllers/purchasing/PurchaseOrderController");
const incomingCtrl = require("../src/prisma/controllers/incoming/IncomingTransactionController");
function invoke(fn, req = {}) { return new Promise((resolve, reject) => { const request = { params: {}, body: {}, query: {}, user: { username: "real-test", email: "real-test@local" }, ...req }; const response = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(v) { resolve({ statusCode: this.statusCode, body: v }); } }; Promise.resolve(fn(request, response, (e) => reject(e))).catch(reject); }); }
(async () => {
  const prs = await prisma.purchaseRequisition.findMany({ where: { isDeleted: false, status: "Draft", sourceType: "MRP" }, include: { details: { where: { isDeleted: false }, orderBy: { lineNumber: "asc" } } }, orderBy: { prNumber: "asc" } });
  const warehouse = await prisma.warehouse.findFirst({ where: { isDeleted: false, isActive: true }, select: { warehouseCode: true } });
  const rack = warehouse ? await prisma.rack.findFirst({ where: { isDeleted: false, isActive: true, warehouseCode: warehouse.warehouseCode }, select: { rackCode: true } }) : null;
  const out = [];
  for (const pr of prs) {
    const submitted = await invoke(prCtrl.submit, { params: { prNumber: pr.prNumber } });
    const approved = submitted.statusCode < 300 ? await invoke(prCtrl.approve, { params: { prNumber: pr.prNumber } }) : submitted;
    const current = await prisma.purchaseRequisition.findUnique({ where: { prNumber: pr.prNumber }, include: { details: { where: { isDeleted: false }, orderBy: { lineNumber: "asc" } } } });
    const lines = current.details.filter((d) => Number(d.qty) > Number(d.orderedQty || 0)).map((d) => ({ prDetailId: d.id, sourceQty: Number(d.qty) - Number(d.orderedQty || 0), supplierCode: "S001", orderQty: Number(d.qty) - Number(d.orderedQty || 0), orderUomCode: d.uomCode || "PCS", purchasePackageUomCode: d.materialCode ? "COIL" : undefined, purchasePackageQty: d.materialCode ? 1 : undefined, conversionUomCode: d.materialCode ? (d.uomCode || "KG") : undefined, conversionFactor: d.materialCode ? Number(d.qty) : undefined }));
    const converted = approved.statusCode < 300 ? await invoke(prCtrl.convertToPO, { params: { prNumber: pr.prNumber }, body: { supplierCode: "S001", lines, currencyCode: "IDR" } }) : approved;
    const poNumbers = converted.body?.purchaseOrders?.map((po) => po.poNumber) || [];
    const receipts = [];
    for (const poNumber of poNumbers) {
      let ok = true; for (const fn of [poCtrl.submitChecking, poCtrl.approve, poCtrl.send, poCtrl.confirm]) { const r = await invoke(fn, { params: { poNumber } }); if (r.statusCode >= 300) { ok = false; break; } }
      if (!ok || !warehouse) continue;
      const po = await prisma.purchaseOrder.findUnique({ where: { poNumber }, include: { details: { where: { isDeleted: false }, orderBy: { lineNumber: "asc" } } } });
      const received = await invoke(incomingCtrl.receivePurchaseOrder, { body: { poNumber, warehouseCode: warehouse.warehouseCode, details: po.details.map((d) => ({ poDetailId: d.id, qtyReceived: d.qty, rackCode: rack?.rackCode || null, lotNumber: `LOT-${poNumber}-${d.lineNumber}`, supplierLotNumber: `SUP-${d.lineNumber}` })) } });
      if (received.statusCode >= 300) { receipts.push({ poNumber, statusCode: received.statusCode, message: received.body?.message }); continue; }
      const inspection = await invoke(incomingCtrl.createInspection, { body: { grNumber: received.body.grNumber } });
      if (inspection.statusCode >= 300) { receipts.push({ poNumber, statusCode: inspection.statusCode, message: inspection.body?.message }); continue; }
      const decisions = (inspection.body.details || []).map((d) => ({ grDetailId: d.grDetailId, qtyAccepted: d.qtyInspected || 0, qtyRejected: 0 }));
      const completed = await invoke(incomingCtrl.completeInspection, { params: { inspectionNumber: inspection.body.inspectionNumber }, body: { decisions } });
      const putaway = completed.statusCode < 300 ? await invoke(incomingCtrl.putawayAccepted, { params: { inspectionNumber: inspection.body.inspectionNumber }, body: {} }) : completed;
      receipts.push({ poNumber, grNumber: received.body.grNumber, inspectionNumber: inspection.body.inspectionNumber, statusCode: putaway.statusCode, message: putaway.body?.message });
    }
    out.push({ prNumber: pr.prNumber, submit: submitted.statusCode, approve: approved.statusCode, convertToPO: converted.statusCode, poNumbers, receipts });
  }
  console.log(JSON.stringify(out, null, 2));
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
