const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const { prPartWhere } = require("../src/prisma/services/purchasing/prPartEligibility");
const base = path.resolve(__dirname, "../src/prisma");

function load(file, dependencies, extra = "", globals = {}) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(base, file), "utf8") + extra, {
    module, exports: module.exports, console, ...globals,
    require(name) {
      if (Object.hasOwn(dependencies, name)) return dependencies[name];
      throw new Error(`Unexpected dependency ${name}`);
    },
  }, { filename: file });
  return module.exports;
}
const copy = (value) => JSON.parse(JSON.stringify(value));
function matches(row, where = {}) {
  return Object.entries(where).every(([key, condition]) => {
    if (key === "AND") return condition.every((clause) => matches(row, clause));
    if (key === "OR") return condition.some((clause) => matches(row, clause));
    const value = row?.[key] ?? null;
    if (condition === null || typeof condition !== "object") return value === condition;
    if (condition.some) return Array.isArray(value) && value.some((item) => matches(item, condition.some));
    if (condition.in) return condition.in.includes(value);
    const normalized = condition.mode === "insensitive" && typeof value === "string" ? value.toUpperCase() : value;
    const operand = condition.equals ?? condition.not;
    const expected = condition.mode === "insensitive" && typeof operand === "string" ? operand.toUpperCase() : operand;
    if (Object.hasOwn(condition, "equals")) return normalized === expected;
    if (Object.hasOwn(condition, "not")) return value !== null && normalized !== expected;
    return matches(value, condition);
  });
}
function fixture(overrides = {}) {
  const part = { id: "p1", partCode: "P1", partNumber: "DW-1", partName: "Bracket", isDeleted: false, itemType: "WIP", rawType: null, procurementType: "SUBCONTRACT", hasDrawing: true, purchaseUomCode: "PCS", materialId: "m1", ...overrides };
  const material = { id: "m1", materialCode: "MAT1", materialName: "Steel", materialType: "Steel", spec: "SPCC", thickness: 1.2, width: 105 };
  const saved = [];
  const db = {
    part: { findMany: async ({where} = {}) => [part].filter((row) => matches(row, where)) },
    material: { findMany: async () => [material] },
    vendor: { findMany: async () => [{ vendorCode: "V1", vendorName: "Vendor One" }] },
    supplier: { findMany: async () => [{ supplierCode: "S1" }] },
    department: { findFirst: async () => ({ id: "D1" }) },
    purchaseRequisition: {
      async create({ data }) {
        saved.push(copy(data));
        return { ...data, status: "Draft", details: data.details.create.map((row) => ({ ...row, sources: [], sourcingAllocations: row.sourcingAllocations?.create || [] })) };
      },
    },
    $transaction: async (fn) => fn(db),
  };
  const controller = load("controllers/purchasing/PurchaseRequisitionController.js", {
    "../../index": { prisma: db },
    "./utils/purchasingHelpers": { generateDocNumber: async () => "PR-TEST-0001", generatePONumber: async () => "PO-TEST", previewDocNumber: async () => "PR-PREVIEW" },
    "../../services/approvalRuleService": {},
    "../../services/masterFormulaService": { getFormulaSet: async () => ({}), evaluateFromSet: (_formulas, _key, { qty, estimatedPrice }) => qty * estimatedPrice },
    "../../services/purchasing/purchaseOrderQuantityService": {},
    "../../services/purchasing/prPartEligibility": { prPartWhere },
  }, "\nexports.normalize = normalizeRequisitionDetails;");
  return { controller, db, saved };
}
const vendorLine = { procurementCategory: "VENDOR_PROCESS", partCode: "P1", preferredVendor: "V1", description: "Painting bracket", qty: 3, uomCode: "PCS", estimatedPrice: 1200, notes: "Warna hitam, packing terpisah" };

test("manual Out Process snapshots part, notes and vendor without treating it as raw material", async () => {
  const { controller, db } = fixture();
  const [row] = await controller.normalize([vendorLine], db);
  assert.equal(row.partNumber, "DW-1");
  assert.equal(row.preferredVendor, "V1");
  assert.equal(row.materialCode, null);
  assert.equal(row.materialId, null);
  assert.equal(row.totalAmount, 3600);
  assert.equal(row.notes, vendorLine.notes);
});
test("vendor selection must be valid and cannot be replaced by supplier", async () => {
  const { controller, db } = fixture();
  await assert.rejects(controller.normalize([{ ...vendorLine, preferredVendor: "" }], db), /Preferred Vendor wajib/);
  await assert.rejects(controller.normalize([{ ...vendorLine, preferredVendor: "INVALID" }], db), /Vendor tidak ditemukan/);
  await assert.rejects(controller.normalize([{ ...vendorLine, proposedSupplierCode: "S1" }], db), /Out Process menggunakan vendor/);
  await assert.rejects(controller.normalize([{ ...vendorLine, partCode: "", partNumber: "" }], db), /Part Out Process wajib/);
});
test("vendor allocations survive normalization and reject mixed partners", async () => {
  const { controller, db } = fixture();
  const [row] = await controller.normalize([{ ...vendorLine, sourcingAllocations: [{ vendorCode: "V1", demandCoveredQty: 3 }] }], db);
  assert.equal(row.sourcingAllocations.create[0].vendorCode, "V1");
  assert.equal(row.sourcingAllocations.create[0].supplierCode, null);
  await assert.rejects(controller.normalize([{ ...vendorLine, sourcingAllocations: [{ vendorCode: "V1", supplierCode: "S1", demandCoveredQty: 3 }] }], db), /wajib dipilih/);
});
test("material dimensions remain authoritative and per-line notes can be cleared", async () => {
  const { controller, db } = fixture();
  const [row] = await controller.normalize([{ procurementCategory: "MATERIAL", materialCode: "MAT1", qty: 10, uomCode: "KG", estimatedPrice: 3, thickness: 999, width: 999, notes: "" }], db);
  assert.equal(row.spec, "SPCC");
  assert.equal(row.thickness, 1.2);
  assert.equal(row.width, 105);
  assert.equal(row.notes, null);
  assert.equal(row.totalAmount, 30);
});
test("create trusts logged-in requester and persists Out Process type", async () => {
  const { controller, saved } = fixture();
  const response = { status(value) { this.code = value; return this; }, json(value) { this.body = value; return this; } };
  await controller.create({ user: { username: "real-user" }, body: { header: { requestedBy: "spoof", procurementGroup: "VENDOR_PROCESS", poType: "Other", requiredDate: "2026-09-15" }, details: [vendorLine] } }, response, (error) => { throw error; });
  assert.equal(response.code, 201);
  assert.equal(saved[0].requestedBy, "real-user");
  assert.equal(saved[0].poType, "Out Process");
  assert.equal(response.body.details[0].notes, vendorLine.notes);
  assert.equal(response.body.procurementCategory, "VENDOR_PROCESS");
});
test("non-production purchasing types and distinct line notes persist", async () => {
  for (const poType of ["Consumable", "Maintenance", "Asset", "Service", "Other"]) {
    const { controller, saved } = fixture();
    const response = { status(value) { this.code = value; return this; }, json(value) { this.body = value; } };
    await controller.create({ user: { username: "requester" }, body: { header: { procurementGroup: "NON_PRODUCTION", poType }, details: [
      { procurementCategory: "NON_PRODUCTION", description: "Item A", qty: 2, uomCode: "PCS", estimatedPrice: 50, notes: "A" },
      { procurementCategory: "NON_PRODUCTION", description: "Item B", qty: 1, uomCode: "PCS", estimatedPrice: 25, notes: "B" },
    ] } }, response, (error) => { throw error; });
    assert.equal(response.code, 201);
    assert.equal(saved[0].poType, poType);
    assert.equal(saved[0].totalAmount, 125);
    assert.deepEqual(saved[0].details.create.map((row) => row.notes), ["A", "B"]);
  }
});
test("editing a manual vendor draft changes notes without changing requester or category", async () => {
  const { controller, db } = fixture();
  const current = { prNumber: "PR-TEST", requestedBy: "original", sourceType: "MANUAL", procurementGroup: "VENDOR_PROCESS", status: "Draft", requiredDate: "2026-09-15", details: [{ ...vendorLine, id: "d1", orderedQty: 0 }], purchaseOrders: [] };
  const written = [];
  db.purchaseRequisition.findFirst = async () => current;
  db.purchaseRequisitionSourcingAllocation = { updateMany: async () => ({ count: 0 }) };
  db.purchaseRequisitionDetail = { updateMany: async () => ({ count: 1 }), create: async ({ data }) => { written.push(data); return data; } };
  db.purchaseRequisition.update = async ({ data }) => ({ ...current, ...data, details: written });
  const response = { status(value) { this.code = value; return this; }, json(value) { this.body = value; } };
  await controller.update({ params: { prNumber: "PR-TEST" }, body: { header: { requestedBy: "replacement", poType: "Material" }, details: [{ ...vendorLine, id: "d1", notes: "Catatan diperbarui" }] } }, response, (error) => { throw error; });
  assert.equal(response.body.requestedBy, "original");
  assert.equal(response.body.poType, "Out Process");
  assert.equal(response.body.procurementGroup, "VENDOR_PROCESS");
  assert.equal(response.body.details[0].notes, "Catatan diperbarui");
  assert.equal(response.body.details[0].preferredVendor, "V1");
});
test("number preview is read-only, honors reset policy and inactive rules", async () => {
  class FixedDate extends Date { constructor(value) { super(value === undefined ? "2026-09-08T10:00:00Z" : value); } }
  const numbering = load("services/numberingService.js", { "../index": { prisma: {} } });
  let rule = { isActive: true, resetPolicy: "DAILY", lastResetKey: "20260907", nextNumber: 99, pattern: "{PREFIX}-{YYYY}{MM}{DD}-{SEQ}", sequenceLength: 4 };
  let reads = 0;
  const db = { purchaseRequisition: { async findFirst() { reads++; return { prNumber: "PR-20260908-0007" }; } } };
  const helpers = load("controllers/purchasing/utils/purchasingHelpers.js", {
    "../../../index": { prisma: db },
    "../../../services/numberingService": { getRule: async () => rule, formatNumber: numbering.formatNumber },
  }, "", { Date: FixedDate });
  const preview = () => helpers.previewDocNumber("purchaseRequisition", "PR", "prNumber", db);
  assert.equal(await preview(), "PR-20260908-0001");
  assert.equal(await preview(), "PR-20260908-0001");
  assert.equal(rule.nextNumber, 99);
  assert.equal(reads, 0);
  rule.lastResetKey = "20260908";
  assert.equal(await preview(), "PR-20260908-0099");
  rule.isActive = false;
  assert.equal(await preview(), "PR-20260908-0008");
});

test("vendor PR rejects ordinary production and purchase parts", async () => {
  for (const overrides of [
    { procurementType: "MAKE", itemType: "FG" },
    { procurementType: "BUY", itemType: "RAW", rawType: "PURCHASE_PART" },
    { procurementType: null, mbomDetails: [{ isDeleted: true, category: "Vendor", mbomHeader: { isDeleted: false } }] },
    { procurementType: null, mbomDetails: [{ isDeleted: false, category: "Vendor", mbomHeader: { isDeleted: true } }] },
  ]) {
    const { controller, db } = fixture(overrides);
    await assert.rejects(controller.normalize([vendorLine], db), /tidak sesuai kategori PR/);
  }
});
test("vendor eligibility includes an active vendor BOM or vendor operation", async () => {
  for (const overrides of [
    { procurementType: null, category: "Vendor" },
    { procurementType: null, mbomDetails: [{ isDeleted: false, category: "Vendor", mbomHeader: { isDeleted: false } }] },
    { procurementType: "MAKE", mbomDetails: [{ isDeleted: false, category: "inHouse", mbomHeader: { isDeleted: false }, mbomProcesses: [{ isDeleted: false, routingMode: "VENDOR" }] }] },
  ]) {
    const { controller, db } = fixture(overrides);
    assert.equal((await controller.normalize([vendorLine], db))[0].preferredVendor, "V1");
  }
});
test("purchase groups require purchased RAW parts and the matching drawing scope", async () => {
  const input = { partCode: "P1", qty: 2, uomCode: "PCS", procurementCategory: "PURCHASE_PART" };
  for (const overrides of [{}, {itemType:"FG",rawType:"PURCHASE_PART",procurementType:"MAKE"}, {itemType:"RAW",rawType:"MATERIAL",procurementType:"BUY"}]) {
    const {controller,db}=fixture(overrides);
    await assert.rejects(controller.normalize([input],db), /tidak sesuai kategori PR/);
  }
  const purchased=fixture({itemType:"RAW",rawType:"PURCHASE_PART",procurementType:"BUY"});
  assert.equal((await purchased.controller.normalize([input],purchased.db))[0].procurementCategory,"PURCHASE_PART");
  await assert.rejects(purchased.controller.normalize([{...input,procurementCategory:"UNIVERSAL_PURCHASE_PART"}],purchased.db),/tidak sesuai kategori PR/);
  const universal=fixture({itemType:"RAW",rawType:"PURCHASE_PART",procurementType:null,partNumber:null});
  assert.equal((await universal.controller.normalize([{...input,procurementCategory:"UNIVERSAL_PURCHASE_PART"}],universal.db))[0].procurementCategory,"UNIVERSAL_PURCHASE_PART");
});
test("simple C/S/P persists without requiring package quantity or conversion", async () => {
  const {controller,db}=fixture();
  const input={procurementCategory:"MATERIAL",materialCode:"MAT1",qty:10,uomCode:"KG",estimatedPrice:25};
  for (const CSP of ["C","S","P"]) {
    const [row]=await controller.normalize([{...input,CSP}],db);
    assert.equal(row.CSP,CSP);
    assert.equal(row.qty,10);
    assert.equal(row.totalAmount,250);
    assert.equal(row.purchasePackageQty,null);
    assert.equal(row.conversionFactor,null);
  }
  await assert.rejects(controller.normalize([{...input,CSP:"INVALID"}],db),/C\/S\/P harus/);
});
