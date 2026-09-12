"use strict";
// Development-only fixture transaction. All inserts are rolled back, including on assertion failure.
const assert = require("node:assert/strict"), { randomUUID } = require("node:crypto");
require("dotenv").config({ quiet: true });
const url = new URL(process.env.DATABASE_URL);
if (process.env.NODE_ENV !== "development" || !["localhost", "127.0.0.1", "::1"].includes(url.hostname)) throw new Error("Verified local development database required.");
process.env.NODE_ENV = "test";
const { prisma } = require("../src/prisma/index"), service = require("../src/prisma/services/planning/ppicExecutionFollowupService"), eta = require("../src/prisma/services/purchasing/etaConfirmationStore");
const fixture = `PPIC-FOLLOWUP-${randomUUID()}`, rollback = new Error("EXPECTED_ROLLBACK"), actor = { id: "TEST-READER", isSuperAdmin: true }, at = new Date("2099-01-15T00:00:00Z");
async function main() {
  let checks = 0;
  try { await prisma.$transaction(async tx => {
    const [warehouse, currency] = await Promise.all([tx.warehouse.findFirst({ where: { isDeleted: false } }), tx.currency.findFirst({ where: { isDeleted: false } })]);
    assert.ok(warehouse && currency, "Development warehouse and currency required.");
    const mo = await tx.manufacturingOrder.create({ data: { moNumber: `${fixture}-MO`, qtyPlanned: 100 } });
    const vendor = await tx.vendorProcessOrder.create({ data: { orderNumber: `${fixture}-VO`, orderDate: at, moId: mo.id, moNumber: mo.moNumber, vendorCode: "TEST-VENDOR", outputPartCode: fixture, qtyPlanned: 100, qtySent: 100, qtyReceived: 80, qtyAccepted: 60, qtyReject: 5, qtyRework: 3, qtyScrap: 2, uomCode: "PCS", dueDate: at, sentAt: new Date("2099-01-10T03:00:00Z"), status: "Partial Received" } });
    await tx.etaConfirmation.create({ data: { requestId: `${fixture}-ETA`, sourceKey: `VO:${vendor.id}`, sourceType: "VENDOR", sourceNumber: vendor.orderNumber, sourceFingerprint: eta.fingerprint(service.vendorSource(vendor)), sourceSnapshot: {}, partnerCode: "TEST-VENDOR", qty: 100, eta: at, confirmationReference: "Rollback fixture", confirmedBy: actor.id } });
    const so = await tx.salesOrderHeader.create({ data: { soNumber: `${fixture}-SO`, soDate: at, status: "Confirmed", currencyCode: currency.currencyCode } });
    const line = await tx.salesOrderDetail.create({ data: { soNumber: so.soNumber, lineNumber: 1, qty: 100, status: "Pending" } });
    await tx.demandDeliveryTarget.create({ data: { sourceType: "SALES_ORDER", sourceNumber: so.soNumber, sourceLineId: line.id, soDetailId: line.id, phaseNumber: 1, partCode: fixture, targetDate: at, qty: 100, uomCode: "PCS" } });
    const ship = await tx.deliverySchedule.create({ data: { scheduleNumber: `${fixture}-SHIP`, soNumber: so.soNumber, plannedDate: at, status: "In Transit", shippedAt: new Date("2099-01-15T03:00:00Z") } });
    await tx.deliveryScheduleDetail.create({ data: { scheduleNumber: ship.scheduleNumber, soDetailId: line.id, lineNumber: 1, qty: 100, qtyDelivered: 60 } });
    const revision = await tx.dailyPlanRevision.create({ data: { revisionNumber: `${fixture}-REV`, planDate: at, version: 1, status: "Draft" } });
    await tx.dailyProductionSchedule.create({ data: { scheduleNumber: `${fixture}-DPS`, scheduleDate: at, shift: "QA", dailyPlanRevisionId: revision.id, partCode: fixture, plannedQty: 100, uomCode: "PCS" } });
    await tx.demandException.create({ data: { exceptionNumber: `${fixture}-EX`, identityKey: fixture, periodYear: 2099, periodMonth: 1, sourceMode: "LIVE", partCode: fixture, demandQty: 100, uomCode: "PCS", exceptionType: "MATERIAL_SHORTAGE", severity: "CRITICAL", title: `${fixture} material shortage`, description: "Rollback fixture" } });
    await tx.mpsRecoveryRequest.create({ data: { mpsNumber: `${fixture}-MPS`, mpsRevision: 1, lineId: fixture, checkpointCode: "MPS_MATERIAL", planningMonth: "2099-01", partCode: fixture, title: `${fixture} recovery`, departmentId: fixture, departmentName: "Test department", recipientIds: [], sourceSnapshot: {}, history: [], notes: "Rollback fixture", requestedBy: actor.id } });
    await tx.productionLog.create({ data: { logNumber: `${fixture}-LOG`, logDate: new Date("2098-12-31T20:00:00Z"), moId: mo.id, shift: "QA", operatorName: "Rollback fixture", status: "Submitted" } });
    const stock = await tx.stockOpnameHeader.create({ data: { stoNo: `${fixture}-STO`, stoType: "FG", warehouseCode: warehouse.warehouseCode, stoDate: at, status: "COUNTING" } });
    await tx.stockOpnameDetail.create({ data: { stoHeaderId: stock.id, warehouseCode: warehouse.warehouseCode, partCode: fixture, systemQty: 100, actualQty: null, varianceQty: 0, uomCode: "PCS" } });
    const view = new Proxy(tx, { get(target, key) { if (key === "$executeRaw") return async template => { assert.equal(template[0], "SET TRANSACTION READ ONLY"); return 0; }; const value = target[key]; return typeof value === "function" ? value.bind(target) : value; } });
    const read = page => service.snapshot({ $transaction: fn => fn(view) }, page, { month: "2099-01", q: fixture }, actor);
    const e06 = await read("subcontract-control"); assert.equal(e06.items.length, 1); assert.equal(e06.items[0].pendingQcQty, 15); assert.equal(e06.items[0].notReturnedQty, 20); assert.equal(e06.items[0].confirmationStatus, "CONFIRMED"); checks++;
    await tx.vendorProcessOrder.update({ where: { id: vendor.id }, data: { qtyPlanned: 110 } });
    const changed = await read("subcontract-control"); assert.equal(changed.items[0].confirmationStatus, "STALE"); assert.equal(changed.items[0].eta, null); checks++;
    const e07 = await read("delivery-fulfillment"); assert.equal(e07.items.length, 1); assert.equal(e07.items[0].committedQty, 100); assert.equal(e07.items[0].shippedQty, null); assert.equal(e07.related.length, 1); assert.equal(e07.related[0].deliveredPositionQty, 60); assert.equal(e07.related[0].lineRemainingQty, 40); assert.equal(e07.related[0].shippedAt, "2099-01-15T03:00:00.000Z"); checks++;
    const e08 = await read("exceptions-recovery"); assert.equal(e08.items.length, 1); assert.equal(e08.related.length, 1); assert.equal(e08.related[0].sourceValidity, "UNKNOWN"); checks++;
    const e09 = await read("change-control"); assert.equal(e09.items.length, 1); assert.equal(e09.items[0].schedules.length, 1); assert.equal(e09.items[0].schedules[0].plannedQty, 100); assert.equal(e09.items[0].comparisonStatus, "UNKNOWN"); checks++;
    const e10 = await read("reconciliation-closure"); assert.equal(e10.items.find(r => r.type === "STOCK_COUNT").varianceQty, null); assert.equal(e10.items.find(r => r.type === "PRODUCTION_LOG").status, "BLOCKER"); assert.equal(e10.items.find(r => r.type === "PRODUCTION_LOG").date, "2099-01-01"); assert.equal(e10.readiness.canClose, false); assert.equal(e10.readiness.status, "BLOCKER"); checks++;
    throw rollback;
  }, { timeout: 120000 }); } catch (error) { if (error !== rollback) throw error; }
  const persisted = await Promise.all([prisma.vendorProcessOrder.count({ where: { orderNumber: { startsWith: fixture } } }), prisma.salesOrderHeader.count({ where: { soNumber: { startsWith: fixture } } }), prisma.dailyPlanRevision.count({ where: { revisionNumber: { startsWith: fixture } } }), prisma.demandException.count({ where: { identityKey: fixture } }), prisma.productionLog.count({ where: { logNumber: { startsWith: fixture } } }), prisma.stockOpnameHeader.count({ where: { stoNo: { startsWith: fixture } } })]);
  assert.deepEqual(persisted, [0, 0, 0, 0, 0, 0]); checks++;
  console.log(JSON.stringify({ followupIntegrationChecks: checks, rolledBack: true, persistedFixtureCount: 0 }));
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
