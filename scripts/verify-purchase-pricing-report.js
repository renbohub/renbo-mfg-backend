const assert = require("assert");
const fs = require("fs");
const path = require("path");

const controller = fs.readFileSync(path.join(__dirname, "../src/prisma/controllers/reporting/P2ReportingController.js"), "utf8");
const routes = fs.readFileSync(path.join(__dirname, "../src/prisma/routes/reporting.js"), "utf8");

assert(controller.includes('new Set(["material", "purchase-part", "vendor-process"])'), "Pricing report harus menyediakan tiga jenis laporan");
assert(controller.includes("prisma.materialPriceList.findMany"), "Harga material harus bersumber dari Material Price List");
assert(controller.includes("prisma.partPriceList.findMany"), "Harga purchase part harus bersumber dari Part Price List");
assert(controller.includes("prisma.vendorPriceListDetail.findMany"), "Harga vendor process harus bersumber dari detail Vendor Price List");
assert(controller.includes("resolveEffectiveRecord(records, at)"), "Harga bulanan harus memakai record efektif pada akhir bulan");
assert(controller.includes("comparisonKey") && controller.includes("comparisonLabel"), "Pricing report harus mengelompokkan item untuk grafik supplier");
assert(controller.includes("monthlyIdr"), "Grafik perbandingan supplier harus memakai harga yang dinormalisasi ke IDR");
assert(routes.includes('router.get("/purchase-pricing"'), "Route purchase pricing report belum terdaftar");

console.log("Purchase pricing report contracts passed.");
