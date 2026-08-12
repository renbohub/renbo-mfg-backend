"use strict";

const assert = require("assert");
const {
  normalizeEffectivePriceInput,
  resolveEffectivePrice,
  createEffectiveVersion,
} = require("../src/prisma/services/pricing/effectivePriceService");

async function run() {
  const history = [
    { id: "old", unitPrice: 100, effectiveFrom: new Date("2025-01-01"), effectiveUntil: new Date("2025-12-31T23:59:59.999Z"), isActive: true, isDeleted: false },
    { id: "current", unitPrice: 125, effectiveFrom: new Date("2026-01-01"), effectiveUntil: null, isActive: true, isDeleted: false },
  ];
  assert.equal(resolveEffectivePrice(history, "2025-06-30").unitPrice, 100, "historical BOM must use historical price");
  assert.equal(resolveEffectivePrice(history, "2026-08-11").unitPrice, 125, "current document must use current price");

  const legacy = [
    { pricingYear: 2024, december: 90, isDeleted: false },
    { pricingYear: 2026, january: 130, isDeleted: false },
  ];
  assert.equal(resolveEffectivePrice(legacy, "2024-12-31").unitPrice, 90, "future legacy price must not leak into historical costing");

  const normalized = normalizeEffectivePriceInput({ unitPrice: "150.25", effectiveFrom: "2026-08-11", moq: "200" });
  assert.equal(normalized.pricingYear, 2026);
  assert.equal(normalized.august, 150.25, "new price must project into legacy month adapter");
  assert.equal(normalized.moq, 200);

  const calls = [];
  const delegate = {
    findFirst: async ({ where }) => {
      if (where.effectiveFrom instanceof Date) return null;
      if (where.effectiveFrom?.gt) return { effectiveFrom: new Date("2026-10-01") };
      return null;
    },
    updateMany: async (args) => { calls.push(args); return { count: 1 }; },
    create: async ({ data }) => ({ id: "new", ...data }),
  };
  const created = await createEffectiveVersion({ materialPriceList: delegate }, {
    model: "materialPriceList",
    scopeWhere: { materialId: "M1", supplierId: "S1" },
    data: { unitPrice: 150, effectiveFrom: new Date("2026-08-11"), effectiveUntil: null },
  });
  assert.equal(calls.length, 1, "previous open period must be closed");
  assert.equal(created.effectiveUntil.toISOString(), "2026-09-30T00:00:00.000Z", "new period must stop on the calendar day before a known future price");
  assert.equal(calls[0].data.effectiveUntil.toISOString(), "2026-08-10T00:00:00.000Z", "previous period must end on the calendar day before new start");

  console.log("Effective price history contracts: PASS (10 assertions)");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
