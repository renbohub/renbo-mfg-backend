"use strict";
const assert = require("node:assert/strict");
const { explodeMBOM } = require("../src/prisma/controllers/planning/MRPController").__test;
(async () => {
  let criteria;
  const tx = { mBOMHeader: { findFirst: async (query) => { criteria = query.where; return null; } } };
  await assert.rejects(explodeMBOM(tx, "TEST", "EXPIRED-BOM", 100, new Date("2026-09-08"), 1), (e) => e.code === "MRP_BOM_NOT_EFFECTIVE" && e.statusCode === 409);
  assert.equal(criteria.id, "EXPIRED-BOM");
  assert.equal(criteria.isDeleted, false);
  assert.equal(JSON.stringify(criteria).includes("expiryDate"), true);
  const empty = await explodeMBOM({ mBOMHeader: { findFirst: async () => ({ details: [] }) } }, "TEST", "EMPTY", 100, new Date("2026-09-08"), 1);
  assert.deepEqual(empty.requirements, []);
  console.log("MRP expired/missing BOM: fails explicitly instead of silently dropping material requirements PASS");
})().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
