/* eslint-disable no-console */
require("dotenv").config({ quiet: true });
const { prisma } = require("../src/prisma");
const ctrl = require("../src/prisma/controllers/sales/SalesOrderController");

function invoke(fn, { body = {}, params = {}, user = { username: "system" } } = {}) {
  return new Promise((resolve, reject) => {
    const req = { body, params, user };
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { resolve({ statusCode: this.statusCode, body: value }); return this; } };
    fn(req, res, (error) => reject(error));
  });
}

(async () => {
  const body = {
    soNumber: "SO-2026-001",
    soDate: "2026-07-27",
    customerCode: "C001",
    customerName: "PT. Mitsuba Indonesia Pipe Parts",
    currencyCode: "IDR",
    status: "Draft",
    details: [
      { partCode: "C001-C002-000", partNumber: "B5D-F4364-00", partName: "STAY B5D", uomCode: "pcs", qty: 12000, deliveryDate: "2026-08-31", unitPrice: 0 },
      { partCode: "C001-C002-000", partNumber: "B5D-F4364-00", partName: "STAY B5D", uomCode: "pcs", qty: 15000, deliveryDate: "2026-09-30", unitPrice: 0 },
    ],
  };
  const created = await invoke(ctrl.create, { body });
  if (created.statusCode >= 300) throw new Error(`SO create: ${JSON.stringify(created.body)}`);
  const confirmed = await invoke(ctrl.confirm, { params: { soNumber: "SO-2026-001" } });
  if (confirmed.statusCode >= 300) throw new Error(`SO confirm: ${JSON.stringify(confirmed.body)}`);
  console.log(JSON.stringify({ created: created.body, confirmed: confirmed.body }, null, 2));
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
