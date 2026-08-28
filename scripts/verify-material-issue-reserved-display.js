"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const backendRoot = path.resolve(__dirname, "..");
const frontendRoot = path.resolve(backendRoot, "..", "renbo-mfg-frontend");
const controller = fs.readFileSync(path.join(backendRoot, "src/prisma/controllers/production/MaterialIssueController.js"), "utf8");
const ui = fs.readFileSync(path.join(frontendRoot, "public/js/operations-detail.js"), "utf8");

assert.match(controller, /qtyReservedForIssue: reservedForIssueQty/, "Payload line harus memuat reservation khusus MI");
assert.match(controller, /reservedQty: 0/, "Ringkasan per UOM harus memuat reserved qty");
assert.match(controller, /current\.reservedQty \+= Number\(group\.qtyReservedForIssue/, "Reserved summary harus berasal dari reservation MI, bukan seluruh reservation stock");
assert.match(ui, /STOCK RESERVED/, "KPI reserved harus ditampilkan");
assert.match(ui, /Reserved MI ini/, "Komposisi stock harus membedakan reserved total dan reserved MI");
assert.match(ui, /reserved MI/, "Pilihan rack dan lot harus menampilkan qty reserved MI");

console.log("Material Issue reserved stock display: PASS");
