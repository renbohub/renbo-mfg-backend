"use strict";
const assert = require("node:assert/strict"), { randomUUID } = require("node:crypto");
require("dotenv").config({ quiet: true });
const database = new URL(process.env.DATABASE_URL);
if (process.env.NODE_ENV !== "development" || !["localhost", "127.0.0.1", "::1"].includes(database.hostname)) throw new Error("Verified local development required.");
process.env.NODE_ENV = "test";
const { prisma } = require("../src/prisma/index"), service = require("../src/prisma/services/planning/ppicAnalyticsService"), clock = require("../src/prisma/utils/businessClock");
const fixture = `PPIC-ANALYTICS-${randomUUID()}`, rollback = new Error("EXPECTED_ROLLBACK"), actor = { id: "ROLLBACK-READER", isSuperAdmin: true }, at = new Date("2099-01-10T00:00:00Z");
async function main() {
  let checks = 0;
  try { await prisma.$transaction(async tx => {
    const [warehouse, currency] = await Promise.all([tx.warehouse.findFirst({ where: { isDeleted: false } }), tx.currency.findFirst({ where: { isDeleted: false } })]);
    assert.ok(warehouse && currency);
    const mo = await tx.manufacturingOrder.create({ data: { moNumber: `${fixture}-MO`, qtyPlanned: 100 } });
    const schedule = await tx.dailyProductionSchedule.create({ data: { scheduleNumber: `${fixture}-DPS`, scheduleDate: at, shift: "QA", partCode: fixture, processId: "PRESS", plannedQty: 100, uomCode: "PCS", status: "Released" } });
    const baseLog = { moId: mo.id, dpsId: schedule.id, shift: "QA", operatorName: "Rollback fixture", machineCode: fixture, processCode: "PRESS", status: "Approved", logDate: at };
    const first = await tx.productionLog.create({ data: { ...baseLog, logNumber: `${fixture}-LOG1`, qtyProduced: 100, qtyGood: 90, qtyReject: 10, qtyRework: 5, startTime: new Date("2099-01-10T01:00:00Z"), endTime: new Date("2099-01-10T03:00:00Z"), downtime: 30 } });
    const second = await tx.productionLog.create({ data: { ...baseLog, logNumber: `${fixture}-LOG2`, qtyProduced: 10, qtyGood: 10, qtyReject: 0, startTime: new Date("2099-01-10T02:00:00Z"), endTime: new Date("2099-01-10T04:00:00Z"), downtime: 30 } });
    await tx.productionLog.createMany({ data: [
      { ...baseLog, logNumber: `${fixture}-CROSS`, qtyProduced: 999, qtyGood: 999, logDate: new Date("2098-12-31T16:00:00Z"), startTime: new Date("2098-12-31T16:00:00Z"), endTime: new Date("2098-12-31T18:00:00Z"), downtime: 0 },
      { ...baseLog, logNumber: `${fixture}-PENDING`, qtyProduced: 999, qtyGood: 999, status: "Submitted" },
    ] });
    await tx.downtimeLog.createMany({ data: [
      { downtimeNumber: `${fixture}-D1`, moId: mo.id, productionLogId: first.id, startTime: new Date("2099-01-10T02:00:00Z"), endTime: new Date("2099-01-10T02:30:00Z"), durationMinutes: 30, reason: "Setup", status: "Closed" },
      { downtimeNumber: `${fixture}-D2`, moId: mo.id, productionLogId: second.id, startTime: new Date("2099-01-10T02:15:00Z"), endTime: new Date("2099-01-10T02:45:00Z"), durationMinutes: 30, reason: "Machine stop", status: "Closed" },
    ] });
    const so = await tx.salesOrderHeader.create({ data: { soNumber: `${fixture}-SO`, soDate: at, status: "Confirmed", currencyCode: currency.currencyCode } });
    const line = await tx.salesOrderDetail.create({ data: { soNumber: so.soNumber, lineNumber: 1, qty: 100 } });
    const sent = await tx.deliverySchedule.create({ data: { scheduleNumber: `${fixture}-SENT`, soNumber: so.soNumber, plannedDate: at, shippedAt: new Date("2099-01-10T02:00:00Z"), status: "In Transit" } });
    await tx.deliverySchedule.create({ data: { scheduleNumber: `${fixture}-FUTURE-SHIP`, soNumber: so.soNumber, plannedDate: new Date("2099-01-31T00:00:00Z"), shippedAt: new Date("2099-02-01T02:00:00Z"), status: "In Transit" } });
    const detail = await tx.deliveryScheduleDetail.create({ data: { scheduleNumber: sent.scheduleNumber, soDetailId: line.id, lineNumber: 1, qty: 100, qtyDelivered: 60 } });
    await tx.vendorProcessOrder.create({ data: { orderNumber: `${fixture}-VO`, moId: mo.id, moNumber: mo.moNumber, dueDate: at, outputPartCode: fixture, qtyReceived: 100, qtyAccepted: 50, uomCode: "PCS" } });
    await tx.stockBalance.create({ data: { warehouseCode: warehouse.warehouseCode, partCode: fixture, lotNumber: fixture, uomCode: "PCS", stockType: "WIP", qtyOnHand: 100, qtyAvailable: 30, qtyReserved: 20, qtyQC: 50 } });
    const readView = new Proxy(tx, { get(target, key) { if (key === "$executeRaw") return async strings => { assert.equal(strings[0], "SET TRANSACTION READ ONLY"); return 0; }; const value = target[key]; return typeof value === "function" ? value.bind(target) : value; } });
    const read = (page, extra = {}) => clock.withBusinessDate("2099-02-02", () => service.snapshot({ $transaction: fn => fn(readView) }, { page, month: "2099-01", q: fixture, ...extra }, actor));
    const production = await read("A03");
    assert.equal(production.data.attainment.rows.length, 1); assert.equal(production.data.attainment.rows[0].actualGoodQty, 100); assert.equal(production.data.attainment.rows[0].attainment, 100); checks++;
    assert.equal(production.data.production.rows.length, 2); assert.equal(production.data.production.quality[0].goodQty, 100); assert.equal(production.data.production.quality[0].rejectQty, 10); assert.equal(production.data.production.quality[0].rejectRate, 9.090909); checks++;
    const machine = production.data.production.capacity[0]; assert.equal(machine.occupiedMinutes, 240); assert.equal(machine.downtimeMinutes, 45); assert.equal(machine.runtimeMinutes, 195); assert.equal(machine.oee, null); checks++;
    const baseline = await read("A03", { basis: "BASELINE" }); assert.equal(baseline.data.attainment.rows[0].plannedQty, null); assert.equal(baseline.data.attainment.rows[0].attainment, null); checks++;
    const shipment = await read("A02"); assert.equal(shipment.data.service.rows.length, 2); assert.equal(shipment.data.service.metrics[0].value, 50); assert.equal(shipment.data.service.rows.find(r => r.scheduleNumber.includes("FUTURE-SHIP")).shippedAt, null); assert.equal(shipment.data.service.metrics[1].value, null); checks++;
    await tx.deliveryScheduleDetail.update({ where: { id: detail.id }, data: { qtyDelivered: 70 } });
    const childChanged = await read("A02"); assert.notEqual(childChanged.sourceFingerprint, shipment.sourceFingerprint); checks++;
    const inventory = await read("A05"); assert.equal(inventory.data.inventory.rows[0].qtyQC, 50); assert.equal(inventory.data.inventory.rows[0].ageDays, null); checks++;
    const vendor = await read("A06"); assert.equal(vendor.data.subcontract.rows[0].acceptedQty, 50); assert.equal(vendor.data.subcontract.rows[0].acceptedAt, null); checks++;
    throw rollback;
  }, { timeout: 120000 }); } catch (error) { if (error !== rollback) throw error; }
  const persisted = await Promise.all([prisma.manufacturingOrder.count({ where: { moNumber: { startsWith: fixture } } }), prisma.dailyProductionSchedule.count({ where: { scheduleNumber: { startsWith: fixture } } }), prisma.productionLog.count({ where: { logNumber: { startsWith: fixture } } }), prisma.salesOrderHeader.count({ where: { soNumber: { startsWith: fixture } } }), prisma.stockBalance.count({ where: { lotNumber: fixture } }), prisma.vendorProcessOrder.count({ where: { orderNumber: { startsWith: fixture } } })]);
  assert.deepEqual(persisted, [0, 0, 0, 0, 0, 0]); checks++;
  console.log(JSON.stringify({ analyticsFixtureChecks: checks, rolledBack: true, persistedFixtureCount: 0 }));
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
