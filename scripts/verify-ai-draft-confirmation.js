"use strict";
const assert = require("assert");
const { createAiDraftService } = require("../src/prisma/services/ai/aiDraftService");
let draft = { id: "d1", userId: "u1", status: "WAITING_CONFIRMATION", expiresAt: new Date("2026-09-01"), draftType: "CAPACITY_SIMULATION", moduleCode: "planning-ppic", pageCode: "capacity-planning" };
let updates = 0;
const prisma = { aiDraft: { findUnique: async () => draft, update: async ({ data }) => { updates += 1; draft = { ...draft, ...data }; return draft; }, create: async ({ data }) => data } };
(async () => {
  const service = createAiDraftService({ prisma, now: () => new Date("2026-08-25") });
  await assert.rejects(() => service.validateDraftForOfficial({ draftId: "d1", actor: { id: "other" } }), /tidak ditemukan/i);
  await service.validateDraftForOfficial({ draftId: "d1", actor: { id: "u1" }, draftType: "CAPACITY_SIMULATION", moduleCode: "planning-ppic", pageCode: "capacity-planning" });
  const confirmed = await service.markAiDraftConfirmed({ draftId: "d1", userId: "u1", officialEntityType: "CAPACITY_PRESET", officialEntityId: "preset-1" });
  assert.strictEqual(confirmed.status, "CONFIRMED");
  await service.markAiDraftConfirmed({ draftId: "d1", userId: "u1", officialEntityType: "CAPACITY_PRESET", officialEntityId: "preset-1" });
  assert.strictEqual(updates, 1, "retry harus idempotent");
  console.log("AI draft confirmation contracts: OK");
})().catch((error) => { console.error(error); process.exitCode = 1; });
