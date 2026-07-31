/* eslint-disable no-console */
require("dotenv").config({ quiet: true });
const { prisma } = require("../src/prisma");
const mps = require("../src/prisma/controllers/planning/MPSController");
const mrp = require("../src/prisma/controllers/planning/MRPController");

function invoke(fn, { body = {}, params = {}, query = {}, user = { username: "system" } } = {}) {
  return new Promise((resolve, reject) => {
    const req = { body, params, query, user };
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { resolve({ statusCode: this.statusCode, body: value }); return this; } };
    fn(req, res, (error) => reject(error));
  });
}

async function main() {
  const mpsRows = await prisma.mPS.findMany({ where: { isDeleted: false }, orderBy: { periodStart: "asc" }, select: { mpsNumber: true, periodStart: true, status: true } });
  const confirmed = [];
  for (const row of mpsRows) {
    const result = row.status === "Draft" ? await invoke(mps.confirm, { params: { mpsNumber: row.mpsNumber } }) : { statusCode: 200, body: row };
    if (result.statusCode >= 300) throw new Error(`MPS confirm ${row.mpsNumber}: ${JSON.stringify(result.body)}`);
    confirmed.push(result.body);
  }
  const runs = [];
  for (const row of mpsRows) {
    const result = await invoke(mrp.runMRP, { body: { mpsNumber: row.mpsNumber, planHorizon: 90 } });
    if (result.statusCode >= 300) throw new Error(`MRP ${row.mpsNumber}: ${JSON.stringify(result.body)}`);
    runs.push(result.body);
  }
  console.log(JSON.stringify({ confirmed, runs }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => prisma.$disconnect());
