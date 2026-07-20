"use strict";

const { prisma, disconnectDatabase } = require("../src/prisma");

function buildRoutingUpdates(details = []) {
  const detailById = new Map(details.map((detail, detailIndex) => [detail.id, { detail, detailIndex }]));
  const operationsByDetail = new Map(); const roots = [];
  details.forEach((detail, detailIndex) => {
    const operations = (detail.mbomProcesses || []).filter((item) => !item.isDeleted)
      .map((process, processIndex) => ({ process, processIndex, detailIndex, children: [] }))
      .sort((a, b) => Number(a.process.sequence || 0) - Number(b.process.sequence || 0) || a.processIndex - b.processIndex);
    operationsByDetail.set(detail.id, operations);
  });
  const ancestorOperation = (detail) => { const visited = new Set(); let parentId = detail.parentDetailId; while (parentId && !visited.has(parentId)) { visited.add(parentId); const operations = operationsByDetail.get(parentId) || []; if (operations.length) return operations[operations.length - 1]; parentId = detailById.get(parentId)?.detail?.parentDetailId || null; } return null; };
  details.forEach((detail) => { const operations = operationsByDetail.get(detail.id) || []; if (!operations.length) return; for (let index = 1; index < operations.length; index += 1) operations[index - 1].children.push(operations[index]); const ancestor = ancestorOperation(detail); if (ancestor) ancestor.children.push(operations[0]); else roots.push(operations[0]); });
  const compare = (a, b) => a.detailIndex - b.detailIndex || Number(a.process.sequence || 0) - Number(b.process.sequence || 0) || a.processIndex - b.processIndex; const updates = []; const visited = new Set();
  const numberOperation = (operation, major, branches = []) => { if (!operation || visited.has(operation)) return; visited.add(operation); const routingNumber = [major, ...branches].join("."); updates.push({ id: operation.process.id, routingNumber }); operation.children.sort(compare); if (operation.children.length === 1) numberOperation(operation.children[0], major + 1, branches); else operation.children.forEach((child, index) => numberOperation(child, major + 1, [...branches, index + 1])); };
  roots.sort(compare); if (roots.length === 1) numberOperation(roots[0], 1); else roots.forEach((root, index) => numberOperation(root, 1, [index + 1])); return updates;
}

async function main() {
  const headers = await prisma.mBOMHeader.findMany({
    where: { isDeleted: false },
    select: {
      noReg: true,
      details: {
        where: { isDeleted: false },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          parentDetailId: true,
          mbomProcesses: {
            where: { isDeleted: false },
            orderBy: [{ sequence: "asc" }, { createdAt: "asc" }],
          },
        },
      },
    },
  });
  let updated = 0;
  for (const header of headers) {
    const updates = buildRoutingUpdates(header.details);
    if (updates.length) await prisma.$transaction(updates.map((item) => prisma.mBOMProcess.update({ where: { id: item.id }, data: { routingNumber: item.routingNumber } })));
    updated += updates.length;
    console.log(`${header.noReg}: ${updates.length} routing process`);
  }
  console.log(`Selesai: ${updated} routing process pada ${headers.length} MBOM.`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => disconnectDatabase());
