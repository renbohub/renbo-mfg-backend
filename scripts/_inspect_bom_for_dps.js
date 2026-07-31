const { prisma } = require('../src/prisma');
(async () => {
  const headers = await prisma.mBOMHeader.findMany({
    where: { isDeleted: false, part: { partCode: { in: ['C001-C002-000', 'C001-0002-010', 'C001-0002-020', 'C001-0002-000'] } } },
    select: { noReg: true, revision: true, part: { select: { partCode: true, partName: true } } },
    orderBy: [{ updatedAt: 'desc' }],
  });
  for (const header of headers) {
    const details = await prisma.mBOMDetail.findMany({
      where: { noReg: header.noReg, isDeleted: false },
      select: {
        id: true, parentDetailId: true, levelComponent: true, category: true, qty: true, uomCode: true,
        part: { select: { partCode: true, partNumber: true, partName: true, itemType: true, rawType: true } },
        parentDetail: { select: { part: { select: { partCode: true, partName: true } } } },
        mbomProcesses: { where: { isDeleted: false }, select: { sequence: true, routingNumber: true, process: { select: { processCode: true, processName: true } } }, orderBy: { sequence: 'asc' } },
      },
      orderBy: [{ levelComponent: 'asc' }, { createdAt: 'asc' }],
    });
    console.log(JSON.stringify({ header, details }, null, 2));
  }
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
