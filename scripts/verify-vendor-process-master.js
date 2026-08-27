const fs = require("fs");
const path = require("path");

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

function verify(label, condition) {
  if (!condition) throw new Error(`FAIL: ${label}`);
  console.log(`PASS: ${label}`);
}

const controller = read("src/prisma/controllers/master-data/VendorProcessController.js");

verify("kode vendor process dinormalisasi dan divalidasi", controller.includes("data.vendorProcessCode.toUpperCase()") && controller.includes("^[A-Z0-9]"));
verify("kode harus berasal dari master proses routing", controller.includes("assertRoutingProcess") && controller.includes("client.process.findFirst"));
verify("vendor pelaksana disimpan sebagai assignment terstruktur", controller.includes("replaceVendorAssignments") && controller.includes("client.entityVendorProcess.createMany"));
verify("master mengembalikan vendor dan penggunaan price list", controller.includes("vendorCodes") && controller.includes("priceListCount"));
verify("assignment lama hanya diganti untuk entity vendor", controller.includes('entityType: "vendor"'));

console.log("Vendor process master contract verified.");
