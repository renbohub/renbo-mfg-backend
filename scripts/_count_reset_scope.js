const { prisma } = require('../src/prisma');
(async () => {
  const delegates = ['incomingInspectionDetail','incomingInspection','goodsReceiptDetail','goodsReceipt','purchaseInvoicePayment','purchaseInvoiceDetail','purchaseInvoicePO','purchaseInvoice','purchaseOrderComment','purchaseOrderPR','purchaseOrderDetail','purchaseOrder','purchaseRequisitionSource','purchaseRequisitionDetail','purchaseRequisition','qualityInspectionDetail','qualityInspection','downtimeLog','materialIssueDetail','materialIssue','productionLog','dailyProductionSchedule','wIPEntry','vendorProcessOrder','manufacturingOrderSourceWip','workOrder','manufacturingOrder','diesUsage','stockReservation','stockMovement','stockBalance','approvalAction','approvalRequest'];
  const out = {};
  for (const name of delegates) out[name] = await prisma[name].count();
  out.stockMovementByReference = await prisma.stockMovement.groupBy({ by: ['referenceType'], _count: { _all: true } });
  console.log(JSON.stringify(out, null, 2));
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
