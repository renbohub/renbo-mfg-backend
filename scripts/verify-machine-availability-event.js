const assert = require("assert");
const { normalizeMachineEvent } = require("../src/prisma/services/planning/machineAvailabilityEventService");

const event = normalizeMachineEvent({ machineId: "m-1", eventType: "breakdown", startedAt: "2026-08-24T08:00:00+07:00", reason: "Motor trip" }, "operator-a");
assert.strictEqual(event.eventType, "BREAKDOWN");
assert.strictEqual(event.status, "OPEN");
assert.strictEqual(event.reportedBy, "operator-a");
assert(event.startedAt instanceof Date);
assert.throws(() => normalizeMachineEvent({ machineId: "m-1", eventType: "BREAKDOWN", reason: "" }), /reason/i);

console.log("Machine availability event contracts passed.");
