require("dotenv").config({ quiet: true });
const { prisma } = require("../src/prisma");

(async () => {
  const [forecasts, parts, mboms, materials, warehouses, suppliers] = await Promise.all([
    prisma.forecast.findMany({ where: { isDeleted: false }, include: { details: { where: { isDeleted: false }, orderBy: { lineNumber: "asc" } } }, orderBy: { periodStart: "asc" } }),
    prisma.part.findMany({ where: { isDeleted: false }, select: { partCode: true, partName: true, partNumber: true, itemType: true, rawType: true, hasDrawing: true, materialId: true, bufferStock: true, baseUomCode: true, partType: true, status: true } }),
    prisma.mBOMHeader.findMany({ where: { isDeleted: false }, select: { noReg: true, partId: true, revision: true, effectiveDate: true, part: { select: { partCode: true, partName: true, itemType: true, rawType: true } }, details: { where: { isDeleted: false }, select: { id: true, partId: true, qty: true, levelComponent: true, parentDetailId: true, part: { select: { partCode: true, partName: true, itemType: true, rawType: true, materialId: true } } } } }, orderBy: { updatedAt: "desc" } }),
    prisma.material.findMany({ where: { isDeleted: false }, select: { materialCode: true, materialName: true, materialType: true, materialForm: true } }),
    prisma.warehouse.findMany({ where: { isDeleted: false, isActive: true }, select: { warehouseCode: true, warehouseName: true } }),
    prisma.supplier.findMany({ where: { isDeleted: false }, select: { supplierCode: true, supplierName: true } }),
  ]);
  console.log(JSON.stringify({ forecasts, parts, mboms, materials, warehouses, suppliers }, null, 2));
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
