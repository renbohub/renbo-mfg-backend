"use strict";

const { prisma, disconnectDatabase } = require("../src/prisma");

async function main() {
  const details = await prisma.mBOMDetail.findMany({
    where: { isDeleted: false, part: { itemType: "RAW", rawType: "MATERIAL", isDeleted: false } },
    select: {
      id: true,
      part: { select: { partCode: true, materialId: true, material: { select: { thickness: true, width: true, density: true } } } },
      parentDetail: { select: { part: { select: { partBases: { where: { baseOn: "Actual" }, orderBy: { createdAt: "desc" }, take: 1 } } } } },
    },
  });
  let updated = 0; let unlinked = 0; let incomplete = 0;
  for (const detail of details) {
    const material = detail.part?.material; const base = detail.parentDetail?.part?.partBases?.[0] || {};
    if (!detail.part?.materialId || !material) { unlinked += 1; console.log(`UNLINKED ${detail.part?.partCode || detail.id}`); continue; }
    const thickness = Number(material.thickness || 0); const width = Number(material.width || 0); const pitch = Number(base.length || 0); const cavity = Math.max(1, Number(base.cavity || 1)); const density = Number(material.density || 0);
    const grossWeight = thickness > 0 && width > 0 && pitch > 0 && density > 0 ? thickness * width * pitch * density / cavity : 0;
    if (!(grossWeight > 0)) incomplete += 1;
    await prisma.mBOMDetail.update({ where: { id: detail.id }, data: { materialThickness: thickness || null, materialWidth: width || null, materialPitch: pitch || null, materialCavity: cavity, materialDensity: density || null, grossWeight } });
    updated += 1;
  }
  console.log(JSON.stringify({ total: details.length, updated, unlinked, incomplete }));
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => disconnectDatabase());
