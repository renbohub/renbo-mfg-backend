require("dotenv").config();
const { prisma } = require("../src/prisma");

const execute = process.argv.includes("--execute");
const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const round = (value) => Math.round((number(value) + Number.EPSILON) * 1e6) / 1e6;

function lineTotal(line, qty) {
  const gross = number(line.unitPrice) * qty;
  const afterDiscount = String(line.discountType || "percent").toLowerCase() === "nominal"
    ? Math.max(gross - number(line.discount), 0)
    : gross * (1 - number(line.discount) / 100);
  return round(afterDiscount * (1 + number(line.tax) / 100));
}

async function main() {
  const details = await prisma.purchaseRequisitionDetail.findMany({
    where: {
      isDeleted: false,
      pr: { isDeleted: false, sourceType: "PURCHASE_SUGGESTION" },
      notes: { contains: "MOQ buffer" },
    },
    include: {
      pr: { select: { prNumber: true, status: true } },
      poDetails: {
        where: { isDeleted: false },
        include: {
          po: {
            include: {
              goodsReceipts: { where: { isDeleted: false }, select: { grNumber: true } },
              purchaseInvoices: { where: { isDeleted: false }, select: { invoiceNumber: true } },
            },
          },
        },
      },
      sourcingAllocations: { where: { isDeleted: false } },
    },
  });

  const candidates = details.flatMap((detail) => {
    if (detail.poDetails.length !== 1) return [];
    const line = detail.poDetails[0];
    const po = line.po;
    const missingQty = round(number(detail.qty) - number(line.qty));
    if (missingQty <= 0 || number(line.qtyReceived) > 0) return [];
    if (po.goodsReceipts.length || po.purchaseInvoices.length) return [];
    return [{ detail, line, po, missingQty, targetQty: round(detail.qty) }];
  });

  console.log(JSON.stringify({
    mode: execute ? "EXECUTE" : "DRY_RUN",
    count: candidates.length,
    rows: candidates.map(({ detail, line, po, missingQty, targetQty }) => ({
      poNumber: po.poNumber,
      lineNumber: line.lineNumber,
      prNumber: detail.prNumber,
      item: detail.materialCode || detail.partCode,
      oldQty: line.qty,
      targetQty,
      restoredMoqRemainder: missingQty,
    })),
  }, null, 2));
  if (!execute || !candidates.length) return;

  await prisma.$transaction(async (tx) => {
    for (const { detail, line, po, missingQty, targetQty } of candidates) {
      await tx.purchaseOrderDetail.update({
        where: { id: line.id },
        data: {
          qty: targetQty,
          totalAmount: lineTotal(line, targetQty),
          notes: [line.notes, `MOQ remainder ${missingQty} ${detail.uomCode || ""} restored from ${detail.prNumber}`].filter(Boolean).join(" | "),
        },
      });
      await tx.purchaseRequisitionDetail.update({ where: { id: detail.id }, data: { orderedQty: targetQty } });
      const linkedAllocation = detail.sourcingAllocations.find((allocation) => allocation.poNumber === po.poNumber)
        || (detail.sourcingAllocations.length === 1 ? detail.sourcingAllocations[0] : null);
      if (linkedAllocation) {
        await tx.purchaseRequisitionSourcingAllocation.update({
          where: { id: linkedAllocation.id },
          data: { commercialQty: targetQty, status: "Ordered", poNumber: po.poNumber },
        });
      }
    }

    for (const poNumber of [...new Set(candidates.map((row) => row.po.poNumber))]) {
      const lines = await tx.purchaseOrderDetail.findMany({ where: { poNumber, isDeleted: false }, select: { totalAmount: true } });
      const totalAmount = round(lines.reduce((sum, line) => sum + number(line.totalAmount), 0));
      const rows = candidates.filter((row) => row.po.poNumber === poNumber);
      await tx.purchaseOrder.update({ where: { poNumber }, data: { totalAmount } });
      await tx.purchaseOrderComment.create({
        data: {
          poNumber,
          type: "moq-remainder-repair",
          message: `Restored MOQ remainder on ${rows.length} line(s); PO quantity now matches approved PR commercial quantity. Demand pegging remains unchanged.`,
          createdBy: "system-repair",
        },
      });
    }

    for (const prNumber of [...new Set(candidates.map((row) => row.detail.prNumber))]) {
      const rows = await tx.purchaseRequisitionDetail.findMany({ where: { prNumber, isDeleted: false }, select: { qty: true, orderedQty: true } });
      const completed = rows.every((row) => number(row.orderedQty) >= number(row.qty) - 0.000001);
      await tx.purchaseRequisition.update({
        where: { prNumber },
        data: { status: completed ? "Completed" : "Partially Ordered" },
      });
    }
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
