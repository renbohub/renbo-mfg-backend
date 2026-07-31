require("dotenv").config({ quiet: true });
const { prisma } = require("../src/prisma");
(async () => { const rows = await prisma.stockMovement.findMany({ where: { referenceType: "QUALITY_INSPECTION", transactionType: "PRODUCTION", movementType: "IN", stockType: "Finished Goods", isDeleted: false }, select: { movementNumber: true, referenceNumber: true, qty: true, partCode: true, notes: true } }); console.log(JSON.stringify(rows, null, 2)); })().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
