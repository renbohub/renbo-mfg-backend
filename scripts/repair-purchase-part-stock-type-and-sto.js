const { prisma } = require("../src/prisma");

const execute = process.argv.includes("--execute");
const targetStoNo = process.argv.find((value) => value.startsWith("--sto="))?.slice(6) || "STO-20260813-0002";

const detailData = (headerId, balance) => ({
  stoHeaderId: headerId,
  stockBalanceId: balance.id,
  partCode: balance.partCode,
  partNumber: balance.partNumber,
  partName: balance.partName || balance.materialName,
  materialId: balance.materialId,
  materialCode: balance.materialCode,
  materialName: balance.materialName,
  materialType: balance.materialType,
  productId: balance.productId,
  description: balance.description || balance.materialCode,
  spec: balance.spec || balance.materialType,
  thickness: balance.thickness,
  width: balance.width,
  CSP: balance.CSP,
  stockType: "Purchase Part",
  warehouseCode: balance.warehouseCode,
  rackCode: balance.rackCode,
  lotNumber: balance.lotNumber,
  uomCode: balance.uomCode,
  systemQty: balance.qtyOnHand,
});

async function main() {
  const purchaseParts = await prisma.part.findMany({
    where: { isDeleted: false, itemType: "RAW", rawType: "PURCHASE_PART" },
    select: { partCode: true },
  });
  const partCodes = purchaseParts.map((row) => row.partCode);
  const legacyBalances = await prisma.stockBalance.findMany({
    where: { isDeleted: false, stockType: "Part", partCode: { in: partCodes } },
    select: { id: true, warehouseCode: true, partCode: true, lotNumber: true, qtyOnHand: true },
  });
  const header = await prisma.stockOpnameHeader.findFirst({
    where: { stoNo: targetStoNo, isDeleted: false },
    include: { details: { where: { isDeleted: false }, select: { stockBalanceId: true } } },
  });
  if (header && header.status !== "DRAFT") {
    throw new Error(`${targetStoNo} berstatus ${header.status}; sinkronisasi scope hanya aman saat DRAFT.`);
  }

  const previewBalances = await prisma.stockBalance.findMany({
    where: {
      warehouseCode: header?.warehouseCode || "WH-001",
      isDeleted: false,
      OR: [
        { stockType: "Purchase Part" },
        { stockType: "Part", partCode: { in: partCodes } },
      ],
    },
    orderBy: [{ partCode: "asc" }, { rackCode: "asc" }, { lotNumber: "asc" }],
  });
  const existingIds = new Set((header?.details || []).map((row) => row.stockBalanceId).filter(Boolean));
  const missing = previewBalances.filter((balance) => !existingIds.has(balance.id));

  console.log(JSON.stringify({
    mode: execute ? "EXECUTE" : "DRY_RUN",
    purchasePartMasters: partCodes.length,
    legacyBalances: legacyBalances.length,
    targetStoNo,
    currentStoLines: header?.details.length || 0,
    missingStoLines: missing.length,
    finalStoLines: (header?.details.length || 0) + missing.length,
    missing: missing.map((row) => ({ partCode: row.partCode, lotNumber: row.lotNumber, qtyOnHand: row.qtyOnHand })),
  }, null, 2));

  if (!execute) return;
  await prisma.$transaction(async (tx) => {
    await tx.stockBalance.updateMany({
      where: { isDeleted: false, stockType: "Part", partCode: { in: partCodes } },
      data: { stockType: "Purchase Part" },
    });
    await tx.stockMovement.updateMany({
      where: { isDeleted: false, stockType: "Part", partCode: { in: partCodes } },
      data: { stockType: "Purchase Part" },
    });
    await tx.goodsReceipt.updateMany({
      where: { isDeleted: false, stockType: "Part", poType: "Part" },
      data: { stockType: "Purchase Part" },
    });
    if (header && missing.length) {
      await tx.stockOpnameDetail.createMany({ data: missing.map((balance) => detailData(header.id, balance)) });
    }
  });
  console.log("Repair selesai.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
