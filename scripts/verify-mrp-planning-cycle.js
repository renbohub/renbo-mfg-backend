"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const controller = require("../src/prisma/controllers/planning/MRPController");
const { prisma } = require("../src/prisma");

const {
  explicitSalesOrderNumbersForMpsDetail,
  consumeSalesOrdersAlreadyRepresentedByMps,
} = controller.__test;

const detail = {
  partCode: "FG-01",
  endDate: new Date("2026-09-29T00:00:00.000Z"),
  _deliveryPhaseId: "phase-september",
  demandSources: [{ sourceType: "SALES_ORDER", sourceNumber: "SO-2026-001" }],
};
assert.deepStrictEqual([...explicitSalesOrderNumbersForMpsDetail(detail)], ["SO-2026-001"]);

const demand = {
  "FG-01": [
    { sourceNumber: "SO-2026-001#1", dueDate: new Date("2026-09-30T00:00:00.000Z"), remainingQty: 300 },
    { sourceNumber: "SO-OTHER#1", dueDate: new Date("2026-09-28T00:00:00.000Z"), remainingQty: 50 },
  ],
};
const consumed = consumeSalesOrdersAlreadyRepresentedByMps(demand, detail, 0);
assert.strictEqual(consumed.consumedQty, 300, "SO yang sudah ada di MPS harus dikonsumsi walau original due berbeda satu hari");
assert.strictEqual(demand["FG-01"][0].remainingQty, 0, "SO terwakili MPS tidak boleh menjadi demand tambahan");
assert.strictEqual(demand["FG-01"][1].remainingQty, 50, "SO lain tidak boleh ikut dikonsumsi oleh phase ini");

const mrpSource = fs.readFileSync(path.resolve(__dirname, "../src/prisma/controllers/planning/MRPController.js"), "utf8");
const uiSource = fs.readFileSync(path.resolve(__dirname, "../../frontend/public/js/ppic-dashboard.js"), "utf8");
assert(mrpSource.includes('code: "MPS_CYCLE_INCOMPLETE"'), "Backend harus menolak subset planning cycle");
assert(mrpSource.includes("expectedMpsNumbers"), "Error cycle parsial harus menjelaskan MPS yang diharapkan");
assert(!uiSource.includes('document.status === "Confirmed" ? `<button data-run-mrp="${esc(mpsNumber)}">Run MRP</button>`'), "Cell bulanan tidak boleh memiliki tombol Run MRP");
assert(uiSource.includes('Run MRP Cycle (${cycleNumbers.length} bulan)'), "Planning cycle harus mempunyai satu tombol Run MRP");
assert(uiSource.includes('Monthly Production Plan</button>'), "Monthly Production Plan harus tetap tersedia per bulan");

console.log("MRP planning-cycle and SO consumption contracts passed: 10/10 cases");
prisma.$disconnect().catch(() => {});
