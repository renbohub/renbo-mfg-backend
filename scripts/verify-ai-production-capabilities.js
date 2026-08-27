"use strict";
const assert = require("assert");
const { createProductionCapabilityDefinitions } = require("../src/prisma/services/ai/capabilities/productionCapabilities");

const schedule = { id: "dps-1", scheduleNumber: "DPS-001", scheduleDate: new Date("2026-09-01"), machineId: "machine-1", machineCode: "M-050", woNumber: "WO-01", partCode: "WIP-WELD", processId: "process-1", processCode: "WELD-1", plannedQty: 100, plannedEndTime: "15:00", fgRequiredDate: new Date("2026-09-02"), deliveryPhaseId: "phase-1", lateRisk: "WARNING", productionLogs: [{ id: "log-1", logNumber: "LOG-1", qtyGood: 60, qtyReject: 10, qtyProduced: 70, downtime: 15, downtimeLogs: [{ id: "dt-1", downtimeNumber: "DT-1", durationMinutes: 45, reason: "Breakdown" }], qualityInspections: [{ id: "qc-1", inspectionNumber: "QC-1", qtyFailed: 10, decision: "Pending" }] }] };
let draftData;
const prisma = { dailyProductionSchedule: { findMany: async () => [schedule] }, aiDraft: { create: async ({ data }) => { draftData = data; return { id: "draft-1", ...data }; } } };
(async () => {
  const defs = createProductionCapabilityDefinitions();
  assert.deepStrictEqual(defs.map((row) => row.code), ["production.get_daily_progress", "production.analyze_ng_and_downtime", "production.create_recovery_draft"]);
  const progress = await defs[0].execute({ prisma, input: { scheduleDate: "2026-09-01" } });
  assert.strictEqual(progress.items[0].goodQty, 60);
  assert.strictEqual(progress.items[0].ngQty, 10);
  assert.strictEqual(progress.items[0].remainingQty, 40, "NG tidak boleh dianggap output good");
  assert.strictEqual(progress.items[0].downtimeMinutes, 60);
  assert.strictEqual(progress.items[0].downstreamImpact.fgRequiredDate, "2026-09-02");
  assert.strictEqual(progress.items[0].downstreamImpact.openNgDispositionQty, 10);
  const analysis = await defs[1].execute({ prisma, input: { scheduleDate: "2026-09-01" } });
  assert.strictEqual(analysis.items[0].riskStatus, "AT_RISK");
  assert.ok(analysis.sources.some((row) => row.entityType === "FG_DELIVERY_PHASE"));
  const draft = await defs[2].execute({ prisma, user: { id: "u-1" }, input: { conversationId: "c-1", requestId: "r-1", scheduleId: "dps-1", owner: "PPIC", revisionNote: "Pindahkan sisa", targetMachineId: "machine-2", targetShift: "2", targetDate: "2026-09-01", allowedMachineIds: ["machine-2"], allowedShifts: ["2"], allowedDates: ["2026-09-01"] } });
  assert.strictEqual(draft.status, "WAITING_CONFIRMATION");
  assert.deepStrictEqual(Object.keys(draftData.payload).sort(), ["owner", "revisionNote", "sourceReferences", "targetDate", "targetMachineId", "targetShift"].sort());
  assert.ok(!JSON.stringify(draftData.payload).match(/release|status/i));
  console.log("AI production capabilities: OK");
})().catch((error) => { console.error(error); process.exitCode = 1; });
