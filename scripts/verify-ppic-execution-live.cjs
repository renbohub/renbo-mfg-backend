"use strict";
// Fixtures exist only inside a development transaction, always rolled back.
const assert = require("node:assert/strict"), { randomUUID } = require("node:crypto");
require("dotenv").config({ quiet: true });
const url = new URL(process.env.DATABASE_URL);
if (process.env.NODE_ENV !== "development" || !["localhost", "127.0.0.1", "::1"].includes(url.hostname)) throw new Error("Verified local development database required.");
process.env.NODE_ENV = "test";
const { prisma } = require("../src/prisma/index"), service = require("../src/prisma/services/planning/ppicExecutionWorkspaceService");
const fixture = `PPIC-ROLLBACK-${randomUUID()}`, rollback = new Error("EXPECTED_ROLLBACK"), actor = { id: "PPIC-ROLLBACK-TEST", isSuperAdmin: true };
async function main() {
  let checks = 0;
  try { await prisma.$transaction(async tx => {
    const mo = await tx.manufacturingOrder.create({ data: { moNumber: `${fixture}-MO`, qtyPlanned: 100 } });
    const schedule = await tx.dailyProductionSchedule.create({ data: { scheduleNumber: `${fixture}-DPS`, scheduleDate: new Date("2099-01-15T00:00:00Z"), shift: "QA", partCode: fixture, moId: mo.id, moNumber: mo.moNumber, plannedQty: 100, actualQty: 999, uomCode: "PCS", plannedStartTime: "08:00", plannedEndTime: "16:00", status: "Released" } });
    await tx.productionLog.createMany({ data: [{ logNumber: `${fixture}-APPROVED`, moId: mo.id, dpsId: schedule.id, logDate: new Date("2099-01-15T03:00:00Z"), shift: "QA", operatorName: "Rollback fixture", status: "Approved", qtyProduced: 90, qtyGood: 80, qtyReject: 10, startTime: new Date("2099-01-15T01:00:00Z"), endTime: new Date("2099-01-15T03:00:00Z") }, { logNumber: `${fixture}-PENDING`, moId: mo.id, dpsId: schedule.id, shift: "QA", operatorName: "Rollback fixture", status: "Submitted", qtyGood: 1000, qtyProduced: 1000 }] });
    const warehouse = await tx.warehouse.findFirst({ where: { isDeleted: false } });
    assert.ok(warehouse, "Existing development warehouse required for physical WIP fixture.");
    await tx.stockBalance.create({ data: { warehouseCode: warehouse.warehouseCode, partCode: fixture, lotNumber: fixture, uomCode: "PCS", stockType: "WIP", qtyOnHand: 80, qtyAvailable: 70, qtyReserved: 5, qtyQC: 5 } });
    await tx.stockMovement.create({ data: { movementNumber: `${fixture}-MOV`, movementDate: new Date("2099-01-15T03:00:00Z"), movementType: "IN", transactionType: "QC_HOLD", warehouseCode: warehouse.warehouseCode, partCode: fixture, lotNumber: fixture, uomCode: "PCS", stockType: "WIP", qty: 80, referenceType: "PRODUCTION_LOG", referenceNumber: `${fixture}-APPROVED` } });
    // A nested read-only transaction cannot follow fixture writes on the same connection.
    // Suppress only that mode declaration; all production snapshot queries run against the real DB.
    const readView = new Proxy(tx, { get(target, key) { if (key === "$executeRaw") return async template => { assert.equal(template[0], "SET TRANSACTION READ ONLY"); return 0; }; const value = target[key]; return typeof value === "function" ? value.bind(target) : value; } });
    const result = await service.snapshot({ $transaction: fn => fn(readView) }, { date: "2099-01-15", q: fixture, plant: "ALL" }, actor);
    assert.equal(result.operations.length, 1); checks++;
    assert.equal(result.operations[0].goodQty, 80); assert.equal(result.operations[0].rejectQty, 10); assert.equal(result.operations[0].remainingQty, 20); checks++;
    assert.equal(result.operations[0].current.startAt, "2099-01-15T01:00:00.000Z"); assert.equal(result.operations[0].actual.endAt, "2099-01-15T03:00:00.000Z"); checks++;
    assert.equal(result.operations[0].baseline, null); assert.equal(result.operations[0].forecast, null); assert.equal(result.operations[0].readinessStatus, "BLOCKER"); checks++;
    assert.equal(result.wip.lots.length, 1); assert.equal(result.wip.lots[0].qtyOnHand, 80); assert.equal(result.wip.lots[0].qualityStatus, "HOLD"); checks++;
    assert.equal(result.wip.movements.length, 1); assert.equal(result.wip.movements[0].referenceNumber, `${fixture}-APPROVED`); checks++;
    assert.deepEqual(result.summary.goodByUom, [{ uom: "PCS", qty: 80 }]); assert.equal(result.summary.quantityGrain, "OPERATION"); checks++;
    throw rollback;
  }, { timeout: 120000 }); } catch (error) { if (error !== rollback) throw error; }
  const persisted = await Promise.all([prisma.dailyProductionSchedule.count({ where: { scheduleNumber: { startsWith: fixture } } }), prisma.manufacturingOrder.count({ where: { moNumber: { startsWith: fixture } } }), prisma.productionLog.count({ where: { logNumber: { startsWith: fixture } } }), prisma.stockBalance.count({ where: { lotNumber: fixture } }), prisma.stockMovement.count({ where: { lotNumber: fixture } })]);
  assert.deepEqual(persisted, [0, 0, 0, 0, 0]); checks++;
  console.log(JSON.stringify({ executionIntegrationChecks: checks, rolledBack: true, persistedFixtureCount: 0 }));
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
