const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  planningMonthKey,
  utcMonthStart,
  utcMonthEnd,
  nextPlanningMonthKey,
} = require("../src/prisma/utils/planningMonth");

const legacyJulyJakarta = new Date("2026-06-30T17:00:00.000Z");
const normalizedJulyUtc = new Date("2026-07-01T00:00:00.000Z");

assert.strictEqual(planningMonthKey(legacyJulyJakarta), "2026-07");
assert.strictEqual(planningMonthKey(normalizedJulyUtc), "2026-07");
assert.strictEqual(utcMonthStart(legacyJulyJakarta).toISOString(), "2026-07-01T00:00:00.000Z");
assert.strictEqual(utcMonthEnd(legacyJulyJakarta).toISOString(), "2026-07-31T00:00:00.000Z");
assert.strictEqual(nextPlanningMonthKey(legacyJulyJakarta), "2026-08");

const exportRoutePath = path.join(__dirname, "../src/prisma/routes/export.js");
const exportRouteSource = fs.readFileSync(exportRoutePath, "utf8");
const integrationRoutes = exportRouteSource
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => /^router\.(get|post)\("/.test(line))
  .filter((line) => !/\/generate-token|\/revoke-token|\/tokens/.test(line));

assert.ok(integrationRoutes.length > 0, "Export integration routes tidak ditemukan.");
for (const route of integrationRoutes) {
  assert.ok(
    route.includes("authExportToken"),
    `Export route belum dilindungi authExportToken: ${route}`,
  );
}

async function verifyRuntimeExportGuard() {
  const express = require("express");
  const exportRouter = require("../src/prisma/routes/export");
  const app = express();
  app.use("/api/export", exportRouter);
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/export/parts`);
    assert.strictEqual(response.status, 401, "Export API tanpa token harus ditolak.");
    const body = await response.json();
    assert.match(String(body.message || ""), /token/i);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

verifyRuntimeExportGuard()
  .then(() => {
    console.log(
      `P0 contracts passed: month bucket Asia/Jakarta stabil dan ${integrationRoutes.length} export route terlindungi.`,
    );
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
