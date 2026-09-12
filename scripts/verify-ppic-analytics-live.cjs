"use strict";
const assert = require("node:assert/strict");
require("dotenv").config({ quiet: true });
const database = new URL(process.env.DATABASE_URL);
if (process.env.NODE_ENV !== "development" || !["localhost", "127.0.0.1", "::1"].includes(database.hostname)) throw new Error("Verified local development required.");
process.env.NODE_ENV = "test";
const { prisma } = require("../src/prisma/index"), service = require("../src/prisma/services/planning/ppicAnalyticsService"), clock = require("../src/prisma/utils/businessClock");
async function main() {
  const businessDate = await clock.readDemoDate(prisma);
  await clock.withBusinessDate(businessDate, async () => {
    for (const page of ["A01", "A02", "A03", "A04", "A05", "A06", "A07", "A08", "A10", "A11"]) {
      const result = await service.snapshot(prisma, { page, month: "2026-08", plant: "ALL" }, { id: "ANALYTICS-READONLY-QA", isSuperAdmin: true });
      assert.equal(result.page, page); assert.equal(result.period.completeness, "PROVISIONAL");
      for (const metric of result.metrics) { assert.ok(metric.grain); assert.ok(metric.source); assert.ok(metric.definition || metric.reason); if (metric.denominator === 0 || metric.numerator == null) assert.equal(metric.value, null); }
      console.log(JSON.stringify({ page, cutoff: result.period.cutoff, sources: result.sources.map(row => ({ id: row.id, count: row.count, approved: row.approved, pending: row.pending })), metrics: result.metrics.map(row => ({ id: row.id, value: row.value, status: row.status })) }));
    }
  });
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
