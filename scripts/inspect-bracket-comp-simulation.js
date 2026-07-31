const { prisma } = require("../src/prisma");

const requestedPartNumbers = [
  "1498",
  "1287",
  "1288",
  "1289",
  "1290",
  "1291",
  "1292",
  "NUT-M6",
  "1766",
  "0697",
  "0698",
];

async function main() {
  const parts = await prisma.part.findMany({
    where: {
      isDeleted: false,
      OR: requestedPartNumbers.flatMap((value) => [
        { partNumber: { contains: value, mode: "insensitive" } },
        { partName: { contains: value, mode: "insensitive" } },
      ]),
    },
    select: {
      id: true,
      partCode: true,
      partNumber: true,
      partName: true,
      itemType: true,
      rawType: true,
      partType: true,
      baseUomCode: true,
      stockUomCode: true,
      material: {
        select: {
          id: true,
          materialCode: true,
          materialName: true,
          materialType: true,
          materialGrade: true,
          thickness: true,
          width: true,
          density: true,
          materialDensityRef: { select: { densityKgMm3: true } },
        },
      },
      partBases: {
        select: {
          baseOn: true,
          thickness: true,
          width: true,
          length: true,
          cavity: true,
          netWeight: true,
          scrapWeight: true,
          grossWeight: true,
        },
      },
    },
    orderBy: [{ partNumber: "asc" }, { partCode: "asc" }],
  });

  const target = parts.find((part) => /1498/i.test(part.partNumber || ""))
    || parts.find((part) => /BRACKET.?COMP/i.test(part.partName || ""));
  const boms = target ? await prisma.mBOMHeader.findMany({
    where: { partId: target.id, isDeleted: false },
    select: {
      noReg: true,
      revision: true,
      effectiveDate: true,
      expiryDate: true,
      details: {
        where: { isDeleted: false },
        select: {
          id: true,
          parentDetailId: true,
          levelComponent: true,
          qty: true,
          uomCode: true,
          category: true,
          materialThickness: true,
          materialWidth: true,
          materialPitch: true,
          materialCavity: true,
          materialDensity: true,
          grossWeight: true,
          materialScheme: true,
          alternateGrossWeight: true,
          part: {
            select: {
              partCode: true,
              partNumber: true,
              partName: true,
              itemType: true,
              rawType: true,
              material: {
                select: {
                  materialCode: true,
                  materialName: true,
                  materialType: true,
                  materialGrade: true,
                },
              },
            },
          },
        },
        orderBy: [{ levelComponent: "asc" }, { createdAt: "asc" }],
      },
    },
    orderBy: [{ revision: "desc" }, { updatedAt: "desc" }],
  }) : [];

  const partCodes = parts.map((part) => part.partCode);
  const stocks = await prisma.stockBalance.findMany({
    where: {
      isDeleted: false,
      OR: [
        { partCode: { in: partCodes } },
        ...requestedPartNumbers.map((value) => ({ partNumber: { contains: value, mode: "insensitive" } })),
      ],
    },
    select: {
      warehouseCode: true,
      rackCode: true,
      lotNumber: true,
      partCode: true,
      partNumber: true,
      partName: true,
      materialCode: true,
      uomCode: true,
      stockType: true,
      qtyOnHand: true,
      qtyReserved: true,
      qtyQC: true,
      qtyAvailable: true,
    },
    orderBy: [{ partNumber: "asc" }, { warehouseCode: "asc" }],
  });

  console.log(JSON.stringify({ target, parts, boms, stocks }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
