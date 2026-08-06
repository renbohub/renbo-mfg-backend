const { prisma, disconnectDatabase } = require("../src/prisma");

const prNumber = String(process.argv[2] || "").trim();

function quantity(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function round(value) {
  return Math.round((quantity(value) + Number.EPSILON) * 1e6) / 1e6;
}

async function main() {
  if (!prNumber) {
    throw new Error("Gunakan: node scripts/split-draft-material-pr-demand-lines.js <PR-NUMBER>");
  }

  const result = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`SPLIT-MATERIAL-PR|${prNumber}`}))`;
    const pr = await tx.purchaseRequisition.findFirst({
      where: { prNumber, isDeleted: false },
      include: {
        details: {
          where: { isDeleted: false },
          orderBy: { lineNumber: "asc" },
          include: {
            sources: { where: { isDeleted: false }, orderBy: { createdAt: "asc" } },
            sourcingAllocations: { where: { isDeleted: false } },
            poDetails: { where: { isDeleted: false }, select: { id: true } },
          },
        },
      },
    });
    if (!pr) throw new Error(`PR ${prNumber} tidak ditemukan.`);
    if (pr.status !== "Draft") throw new Error(`PR ${prNumber} harus Draft untuk dipecah. Status saat ini ${pr.status}.`);

    let nextLine = pr.details.reduce((max, detail) => Math.max(max, quantity(detail.lineNumber)), 0) + 1;
    const created = [];
    const updated = [];

    for (const detail of pr.details) {
      if (String(detail.procurementCategory || "").toUpperCase() !== "MATERIAL") continue;
      const sourceGroups = new Map();
      for (const source of detail.sources) {
        const key = String(source.plannedOrderNumber || "").trim();
        if (!key) continue;
        if (!sourceGroups.has(key)) sourceGroups.set(key, []);
        sourceGroups.get(key).push(source);
      }
      if (sourceGroups.size <= 1) continue;
      if (detail.poDetails.length || detail.sourcingAllocations.length || quantity(detail.orderedQty) > 0) {
        throw new Error(`Detail line ${detail.lineNumber} sudah memiliki PO/alokasi supplier dan tidak aman dipecah otomatis.`);
      }

      const groups = [...sourceGroups.entries()];
      const allocationRows = Array.isArray(detail.lotAllocations) ? detail.lotAllocations : [];
      const groupValues = (plannedOrderNumber, sources) => {
        const qty = round(sources.reduce((sum, source) => sum + quantity(source.qty), 0));
        const sourcePartCode = sources.find((source) => source.partCode)?.partCode || detail.partCode;
        const allocations = allocationRows.filter((allocation) =>
          String(allocation?.plannedOrderNumber || "") === plannedOrderNumber);
        return {
          partCode: sourcePartCode,
          qty,
          totalAmount: round(qty * quantity(detail.estimatedPrice)),
          plannedOrderNumber,
          sourcePlannedOrderNumbers: [plannedOrderNumber],
          lotAllocations: allocations.length ? allocations : null,
          notes: `${detail.notes || ""} | Demand line ${plannedOrderNumber}`.replace(/^\s*\|\s*/, ""),
        };
      };

      const [firstNumber, firstSources] = groups[0];
      await tx.purchaseRequisitionDetail.update({
        where: { id: detail.id },
        data: groupValues(firstNumber, firstSources),
      });
      updated.push({ id: detail.id, lineNumber: detail.lineNumber, plannedOrderNumber: firstNumber });

      for (const [plannedOrderNumber, sources] of groups.slice(1)) {
        const {
          id, createdAt, updatedAt, sources: _sources, sourcingAllocations: _allocations,
          poDetails: _poDetails, ...copy
        } = detail;
        const createdDetail = await tx.purchaseRequisitionDetail.create({
          data: { ...copy, lineNumber: nextLine, ...groupValues(plannedOrderNumber, sources) },
        });
        await tx.purchaseRequisitionSource.updateMany({
          where: { id: { in: sources.map((source) => source.id) } },
          data: { prDetailId: createdDetail.id },
        });
        created.push({
          id: createdDetail.id,
          lineNumber: nextLine,
          plannedOrderNumber,
          qty: createdDetail.qty,
        });
        nextLine += 1;
      }
    }

    const totals = await tx.purchaseRequisitionDetail.aggregate({
      where: { prNumber, isDeleted: false },
      _sum: { totalAmount: true },
    });
    await tx.purchaseRequisition.update({
      where: { prNumber },
      data: { totalAmount: quantity(totals._sum.totalAmount) },
    });
    return { prNumber, updated, created };
  });

  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => disconnectDatabase());
