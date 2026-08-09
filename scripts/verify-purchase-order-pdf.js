const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { buildPurchaseOrderPdf, groupPurchaseOrderDetails } = require("../src/prisma/services/purchasing/purchaseOrderPdfService");

const fixture = {
  poNumber: "PO/MAT-PD/015/MI/VIII/2026",
  poDate: "2026-08-03",
  deliveryDate: "2026-09-01",
  currencyCode: "IDR",
  poType: "Material",
  notes: "Main PO September 2026",
  supplier: {
    supplierName: "Indometal Mitrabuana, PT",
    contact: "Ibu Lina",
    phone: "081398834669",
    billingAddress: "Jl. Kruing I Blok L6 No. 2, Delta Silicon Industrial Estate 1, Lippo Cikarang",
    taxId: "31.577.325.9-414.000",
  },
  details: [
    { materialName: "SPHC-PO", thickness: 1.6, width: 50, CSP: "C", qty: 60, uomCode: "Kg", unitPrice: 15575, totalAmount: 934500, partNumber: "11057-7699", partName: "BRACKET", sourceReferences: [{ partNumber: "11057-7699", partName: "BRACKET" }, { partNumber: "11057-7700", partName: "BRACKET" }], deliveryDate: "2026-09-01", category: "Material PD", tax: 11 },
    { materialName: "SPHC-PO", thickness: 1.6, width: 50, CSP: "C", qty: 80, uomCode: "Kg", unitPrice: 15575, totalAmount: 1246000, partNumber: "11057-7700", partName: "BRACKET", deliveryDate: "2026-09-01", category: "Material PD", tax: 11 },
    { materialName: "SPHC-PO", thickness: 1.6, width: 65, CSP: "C", qty: 70, uomCode: "Kg", unitPrice: 15575, totalAmount: 1090250, partNumber: "11057-7695", partName: "BRACKET", deliveryDate: "2026-09-01", category: "Material PD", tax: 11 },
  ],
};

(async () => {
  const groups = groupPurchaseOrderDetails(fixture.details);
  assert.equal(groups.length, 2, "baris berbeda ukuran tidak boleh tergabung");
  assert.equal(groups[0].quantity, 140, "qty dari material/size/harga sama harus dijumlahkan");
  assert.match(groups[0].reference, /11057-7699, 11057-7700 - BRACKET/, "part number harus disatukan pada reference");
  const purchasePartRows = groupPurchaseOrderDetails([
    { id: "part-1", materialName: "PURCHASE PART", size: "STD", qty: 1, uomCode: "PCS", unitPrice: 1000, partNumber: "PP-001", partName: "PART A" },
    { id: "part-2", materialName: "PURCHASE PART", size: "STD", qty: 1, uomCode: "PCS", unitPrice: 1000, partNumber: "PP-002", partName: "PART B" },
  ], { groupMaterials: false });
  assert.equal(purchasePartRows.length, 2, "Purchase Part harus tetap satu baris per detail tanpa grouping");
  const pdf = await buildPurchaseOrderPdf(fixture);
  assert.equal(pdf.subarray(0, 4).toString(), "%PDF", "hasil harus berupa PDF valid");
  assert(pdf.length > 5000, "PDF tidak boleh kosong");
  if (process.env.PO_PDF_OUTPUT) {
    const output = path.resolve(process.env.PO_PDF_OUTPUT);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, pdf);
    console.log(`PREVIEW ${output}`);
  }
  console.log("PASS Purchase Order PDF grouping and generation");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
