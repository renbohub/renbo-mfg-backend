"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  resolveVendorProcessPrice,
  vendorProcessMatches,
} = require("../src/prisma/services/pricing/vendorProcessPricingService");

const at = new Date("2026-09-01T00:00:00.000Z");
const process = { processCode: "GSN", processName: "GSN" };
const detail = (code, unitPrice) => ({ unitPrice, vendorProcess: { vendorProcessCode: code, vendorProcessName: code } });
const priceList = (overrides = {}) => ({
  id: overrides.id || "price",
  vendorId: overrides.vendorId || "vendor-1",
  partId: Object.prototype.hasOwnProperty.call(overrides, "partId") ? overrides.partId : "part-1",
  currencyCode: overrides.currencyCode || "IDR",
  effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
  effectiveUntil: null,
  isActive: true,
  isDeleted: false,
  details: overrides.details || [detail("GSN", 260)],
});

assert(vendorProcessMatches(detail("GSN", 260), process), "kode proses yang sama harus cocok");
assert(!vendorProcessMatches({ vendorProcess: { vendorProcessCode: "PAINT", vendorProcessName: "GSN" } }, process), "kode berbeda tidak boleh lolos lewat nama");

const resolved = resolveVendorProcessPrice({
  vendorPrices: [
    priceList({ id: "generic", partId: null, details: [detail("GSN", 200)] }),
    priceList({ id: "exact", details: [detail("GSN", 260)] }),
    priceList({ id: "wrong-process", details: [detail("PAINT", 999)] }),
  ],
  vendorId: "vendor-1",
  partId: "part-1",
  process,
  costingDate: at,
  currencyRates: new Map(),
});
assert.equal(resolved.priceList.id, "exact", "harga part spesifik harus mengalahkan harga generic");
assert.equal(resolved.unitPrice, 260, "harga hanya berasal dari detail proses yang cocok");

const converted = resolveVendorProcessPrice({
  vendorPrices: [priceList({ currencyCode: "USD", details: [detail("GSN", 2)] })],
  vendorId: "vendor-1", partId: "part-1", process, costingDate: at,
  currencyRates: new Map([["USD", 15000]]),
});
assert.equal(converted.unitPrice, 30000, "harga vendor harus dikonversi ke IDR sekali");

const controller = fs.readFileSync(path.join(__dirname, "../src/prisma/controllers/mbom/BOMController.js"), "utf8");
const liveCost = fs.readFileSync(path.join(__dirname, "../src/prisma/services/mbomLiveCostingService.js"), "utf8");
const report = fs.readFileSync(path.join(__dirname, "../src/prisma/services/mbomReportService.js"), "utf8");
const frontend = fs.readFileSync(path.join(__dirname, "../../frontend/public/js/bom-table-editor.js"), "utf8");

assert(controller.includes("normalizeVendorRoutingDetails"), "payload vendor lama harus dinormalisasi ke routing");
assert(controller.includes("entityVendorProcess.findFirst"), "backend harus memvalidasi vendor eligible");
assert(!liveCost.includes('["Purchase", "Vendor"].includes(row.category)'), "live costing tidak boleh menambah direct vendor component");
assert(!report.includes('detail.category === "Vendor" ? resolveEffectiveRecord'), "report tidak boleh menjumlah seluruh detail vendor price list");
assert(frontend.includes("eligibleVendorOptions"), "UI harus membatasi vendor berdasarkan proses");
assert(frontend.includes("vendorId: null"), "UI harus menyimpan vendor pada routing, bukan detail BOM");

console.log("BOM vendor routing checks PASS (selection, process price, no double count, UI/backend guard)");
