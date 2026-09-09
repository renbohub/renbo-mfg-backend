"use strict";
const assert = require("node:assert/strict");
const { latestBomHeaderIds } = require("../src/prisma/utils/latestBomHeaders");

const headers = [
  { id: "r6", partId: "retainer", revision: 6, effectiveDate: "2026-09-01", createdAt: "2026-09-01" },
  { id: "r7", partId: "retainer", revision: 7, effectiveDate: "2026-08-20", createdAt: "2026-09-02" },
  { id: "old", partId: "duplicate", revision: 1, expiryDate: "2026-08-28", createdAt: "2026-08-28" },
  { id: "new", partId: "duplicate", revision: 1, createdAt: "2026-08-28" },
  { id: "deleted", partId: "retainer", revision: 8, isDeleted: true },
  { id: "unassigned1", revision: 1 }, { id: "unassigned2", revision: 2 },
  { id: "tie1", partId: "tie", revision: 1, createdAt: "2026-08-01" },
  { id: "tie2", partId: "tie", revision: 1, createdAt: "2026-08-02" },
];
const expected = ["r7", "new", "unassigned1", "unassigned2", "tie2"].sort();
assert.deepEqual(latestBomHeaderIds(headers).sort(), expected);
assert.deepEqual(latestBomHeaderIds([...headers].reverse()).sort(), expected);
assert.deepEqual(latestBomHeaderIds([]), []);
console.log("PASS: latest per part, backdated revision, duplicate revision, deleted, null part, deterministic selection");

// Optional read-only integration against the configured application database.
async function integration() {
  const { prisma } = require("../src/prisma");
  const controller = require("../src/prisma/controllers/mbom/BOMController");
  async function list(query) {
    let result;
    await controller.list({ query: { includeDetails: "false", limit: 500, ...query } }, { json: (data) => { result = data; } }, (error) => { throw error; });
    return result;
  }
  try {
    const all = await list({});
    const latest = await list({ revisionScope: "LATEST" });
    const ids = latestBomHeaderIds(await prisma.mBOMHeader.findMany({ where: { isDeleted: false } }));
    assert.equal(latest.total, ids.length);
    assert.deepEqual(latest.items.map((row) => row.id).sort(), ids.sort());
    const parts = latest.items.map((row) => row.partId || row.id);
    assert.equal(new Set(parts).size, latest.total);
    const p1 = await list({ revisionScope: "LATEST", limit: 10, page: 1 });
    const p2 = await list({ revisionScope: "LATEST", limit: 10, page: 2 });
    assert.equal(p1.total, latest.total);
    assert.equal(new Set([...p1.items, ...p2.items].map((row) => row.id)).size, Math.min(20, latest.total));
    for (const old of all.items.filter((row) => !ids.includes(row.id))) {
      const search = await list({ revisionScope: "LATEST", q: old.noReg });
      assert(!search.items.some((row) => row.id === old.id), "Search must not resurrect an old revision");
    }
    console.log(JSON.stringify({ result: "PASS read-only controller integration", all: all.total, latest: latest.total, hidden: all.total - latest.total }));
  } finally { await prisma.$disconnect(); }
}
if (process.argv.includes("--integration")) integration().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
