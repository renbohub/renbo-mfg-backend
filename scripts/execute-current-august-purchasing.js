require("dotenv").config({ quiet: true });

const { prisma } = require("../src/prisma");
const suggestionController = require("../src/prisma/controllers/purchasing/PurchaseSuggestionController");
const prController = require("../src/prisma/controllers/purchasing/PurchaseRequisitionController");
const poController = require("../src/prisma/controllers/purchasing/PurchaseOrderController");
const incomingController = require("../src/prisma/controllers/incoming/IncomingTransactionController");

const ACTOR = "codex-e2e-20260806";
const RUN_NUMBER = "MRP-20260805-002";

function invoke(handler, request = {}) {
  return new Promise((resolve, reject) => {
    const req = {
      params: {},
      query: {},
      body: {},
      user: { username: ACTOR, email: `${ACTOR}@local` },
      ...request,
    };
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ statusCode: this.statusCode, body }); },
    };
    Promise.resolve(handler(req, res, reject)).catch(reject);
  });
}

async function expectOk(label, promise) {
  const result = await promise;
  if (result.statusCode >= 300) {
    throw new Error(`${label}: ${result.body?.message || `HTTP ${result.statusCode}`}`);
  }
  return result.body;
}

async function progressPo(poNumber) {
  const transitions = [
    ["Draft", poController.submitChecking, "submit checking"],
    ["Submitted", poController.approve, "approve"],
    ["Approved", poController.send, "send"],
    ["Sent", poController.confirm, "confirm"],
  ];
  for (const [status, handler, label] of transitions) {
    const current = await prisma.purchaseOrder.findUnique({ where: { poNumber }, select: { status: true } });
    if (current?.status === status) {
      await expectOk(`${label} ${poNumber}`, invoke(handler, { params: { poNumber } }));
    }
  }
}

async function receiveAndPutaway(poNumber, warehouseCode, rackCode) {
  await progressPo(poNumber);
  const po = await prisma.purchaseOrder.findUnique({
    where: { poNumber },
    include: { details: { where: { isDeleted: false }, orderBy: { lineNumber: "asc" } } },
  });
  const outstanding = po.details.filter((row) => Number(row.qty) > Number(row.qtyReceived || 0) + 0.000001);
  let grNumber = null;
  let inspectionNumber = null;
  if (outstanding.length) {
    const gr = await expectOk(`receive ${poNumber}`, invoke(incomingController.receivePurchaseOrder, {
      body: {
        poNumber,
        warehouseCode,
        deliveryNoteNumber: `DN-${poNumber}`,
        details: outstanding.map((row) => ({
          poDetailId: row.id,
          qtyReceived: Number(row.qty) - Number(row.qtyReceived || 0),
          rackCode,
          lotNumber: `LOT-${poNumber.replace(/[^A-Z0-9]/gi, "-")}-${row.lineNumber}`,
          supplierLotNumber: `SUP-${poNumber}-${row.lineNumber}`,
        })),
      },
    }));
    grNumber = gr.grNumber;
    const inspection = await expectOk(`create IQC ${grNumber}`, invoke(incomingController.createInspection, { body: { grNumber } }));
    inspectionNumber = inspection.inspectionNumber;
    // createInspection initializes qtyInspected to zero. Decisions use the
    // actual GR quantity, not that initial UI field.
    const iqc = await prisma.incomingInspection.findUnique({
      where: { inspectionNumber },
      include: { gr: { include: { details: true } }, details: true },
    });
    await expectOk(`complete IQC ${inspectionNumber}`, invoke(incomingController.completeInspection, {
      params: { inspectionNumber },
      body: {
        decisions: iqc.details.map((row) => ({
          grDetailId: row.grDetailId,
          qtyAccepted: Number(iqc.gr.details.find((detail) => detail.id === row.grDetailId)?.qtyReceived || 0),
          qtyRejected: 0,
        })),
      },
    }));
    await expectOk(`putaway ${inspectionNumber}`, invoke(incomingController.putawayAccepted, { params: { inspectionNumber } }));
  }
  return { poNumber, grNumber, inspectionNumber };
}

async function main() {
  const suggestion = await prisma.purchaseSuggestion.findFirst({
    where: { runNumber: RUN_NUMBER, isDeleted: false },
    orderBy: { createdAt: "desc" },
    include: { items: { where: { isDeleted: false }, orderBy: [{ materialRequiredDate: "asc" }, { materialCode: "asc" }, { partCode: "asc" }] } },
  });
  if (!suggestion) throw new Error(`Purchase Suggestion ${RUN_NUMBER} tidak ditemukan.`);
  const supplier = await prisma.supplier.findFirst({ where: { supplierCode: "S001", isDeleted: false, status: "Active" } });
  if (!supplier) throw new Error("Supplier aktif S001 tidak ditemukan.");

  for (const item of suggestion.items.filter((row) => row.status !== "Converted to PR")) {
    const qty = Number(item.recommendedPurchaseQty || 0);
    if (qty <= 0) continue;
    await expectOk(`confirm suggestion ${item.materialCode || item.partCode}`, invoke(suggestionController.updateItem, {
      params: { suggestionNumber: suggestion.suggestionNumber, itemId: item.id },
      body: {
        confirmationStatus: "Confirmed",
        confirmedQty: qty,
        confirmedDeliveryDate: item.materialRequiredDate,
        alternativeSupplierCode: supplier.supplierCode,
        supplierAllocations: [{
          supplierCode: supplier.supplierCode,
          supplierName: supplier.supplierName,
          confirmationStatus: "Confirmed",
          offeredQty: qty,
          confirmedQty: qty,
          deliveryDate: item.materialRequiredDate,
          leadTimeDays: item.purchasingLeadTimeDays,
          unitPrice: item.estimatedUnitPrice,
          currencyCode: item.currencyCode || "IDR",
          supplierRemark: "Confirmed for August forecast execution",
        }],
      },
    }));
  }

  const readySuggestion = await prisma.purchaseSuggestion.findUnique({
    where: { suggestionNumber: suggestion.suggestionNumber },
    include: { items: { where: { isDeleted: false } } },
  });
  let prNumbers = [...new Set(readySuggestion.items.map((row) => row.prNumber).filter(Boolean))];
  const readyItems = readySuggestion.items.filter((row) => ["Ready for PR", "Partially Ready", "Partially Converted to PR"].includes(row.status));
  if (readyItems.length) {
    const converted = await expectOk(`convert ${suggestion.suggestionNumber} to PR`, invoke(suggestionController.convertToPr, {
      params: { suggestionNumber: suggestion.suggestionNumber },
      body: { items: readyItems.map((row) => ({ itemId: row.id, qty: Number(row.confirmedQty || row.recommendedPurchaseQty) - Number(row.qtyConvertedToPr || 0) })) },
    }));
    prNumbers = [...new Set([...prNumbers, ...(converted.prNumbers || [])])];
  }

  const poNumbers = [];
  for (const prNumber of prNumbers) {
    let pr = await prisma.purchaseRequisition.findUnique({ where: { prNumber }, include: { details: { where: { isDeleted: false }, orderBy: { lineNumber: "asc" } } } });
    if (pr.status === "Draft") await expectOk(`submit ${prNumber}`, invoke(prController.submit, { params: { prNumber } }));
    pr = await prisma.purchaseRequisition.findUnique({ where: { prNumber }, include: { details: { where: { isDeleted: false }, orderBy: { lineNumber: "asc" } } } });
    if (pr.status === "Submitted") await expectOk(`approve ${prNumber}`, invoke(prController.approve, { params: { prNumber } }));
    pr = await prisma.purchaseRequisition.findUnique({ where: { prNumber }, include: { details: { where: { isDeleted: false }, orderBy: { lineNumber: "asc" } } } });
    const outstanding = pr.details.filter((row) => Number(row.qty) > Number(row.orderedQty || 0) + 0.000001);
    if (outstanding.length) {
      const converted = await expectOk(`convert ${prNumber} to PO`, invoke(prController.convertToPO, {
        params: { prNumber },
        body: {
          supplierCode: supplier.supplierCode,
          currencyCode: "IDR",
          lines: outstanding.map((row) => {
            const sourceQty = Number(row.qty) - Number(row.orderedQty || 0);
            return row.materialCode
              ? { prDetailId: row.id, sourceQty, supplierCode: supplier.supplierCode, purchasePackageUomCode: "COIL", purchasePackageQty: 1, conversionUomCode: row.uomCode || "KG", conversionFactor: sourceQty }
              : { prDetailId: row.id, sourceQty, supplierCode: supplier.supplierCode, orderQty: sourceQty, orderUomCode: row.uomCode || "PCS" };
          }),
        },
      }));
      poNumbers.push(...(converted.purchaseOrders || []).map((row) => row.poNumber));
    } else {
      const links = await prisma.purchaseOrderPR.findMany({ where: { prNumber }, select: { poNumber: true } });
      poNumbers.push(...links.map((row) => row.poNumber));
    }
  }

  const warehouse = await prisma.warehouse.findFirst({
    where: { isDeleted: false, isActive: true, availableForProduction: true },
    orderBy: { warehouseCode: "asc" },
  });
  if (!warehouse) throw new Error("Warehouse production aktif tidak ditemukan.");
  const rack = await prisma.rack.findFirst({
    where: { isDeleted: false, isActive: true, warehouseCode: warehouse.warehouseCode, rackCode: { notIn: ["QC-HOLD", "REJECT", "SCRAP"] } },
    orderBy: { rackCode: "asc" },
  });
  if (!rack) throw new Error(`Rack aktif untuk ${warehouse.warehouseCode} tidak ditemukan.`);

  const receipts = [];
  for (const poNumber of [...new Set(poNumbers)]) receipts.push(await receiveAndPutaway(poNumber, warehouse.warehouseCode, rack.rackCode));

  const finalSuggestion = await prisma.purchaseSuggestion.findUnique({ where: { suggestionNumber: suggestion.suggestionNumber }, select: { status: true } });
  const stock = await prisma.stockBalance.findMany({
    where: { isDeleted: false, qtyAvailable: { gt: 0 }, OR: [{ materialCode: { not: null } }, { partCode: { in: readySuggestion.items.map((row) => row.partCode).filter(Boolean) } }] },
    select: { materialCode: true, partCode: true, qtyOnHand: true, qtyAvailable: true, uomCode: true, warehouseCode: true, rackCode: true, lotNumber: true },
    orderBy: [{ materialCode: "asc" }, { partCode: "asc" }, { lotNumber: "asc" }],
  });
  process.stdout.write(JSON.stringify({ suggestionNumber: suggestion.suggestionNumber, suggestionStatus: finalSuggestion.status, prNumbers, poNumbers: [...new Set(poNumbers)], receipts, stock }, null, 2));
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
