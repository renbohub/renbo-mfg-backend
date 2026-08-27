const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  assertReference,
  assertReferenceList,
  referenceError,
} = require("../src/prisma/utils/referenceValidation");

async function expectReferenceError(run, field, code) {
  let caught;
  try { await run(); } catch (error) { caught = error; }
  assert(caught, `expected ${field} validation error`);
  assert.strictEqual(caught.statusCode, 400);
  assert.strictEqual(caught.code, code);
  assert.strictEqual(caught.details?.field, field);
}

async function main() {
  let checks = 0;
  const records = [
    { code: "ACTIVE", isDeleted: false, status: "Active" },
    { code: "INACTIVE", isDeleted: false, status: "Inactive" },
  ];
  const delegate = {
    findFirst: async ({ where }) => records.find((row) => row.code === where.code && row.isDeleted === where.isDeleted && (!where.status || row.status === where.status)) || null,
  };

  await assertReference({ delegate, field: "partCode", value: "ACTIVE", key: "code", label: "Part", activeWhere: { status: "Active" } }); checks += 1;
  await expectReferenceError(() => assertReference({ delegate, field: "partCode", value: "UNKNOWN", key: "code", label: "Part", activeWhere: { status: "Active" } }), "partCode", "REFERENCE_NOT_FOUND"); checks += 1;
  await expectReferenceError(() => assertReference({ delegate, field: "partCode", value: "INACTIVE", key: "code", label: "Part", activeWhere: { status: "Active" } }), "partCode", "REFERENCE_INACTIVE"); checks += 1;
  await assertReference({ delegate, field: "partCode", value: "INACTIVE", currentValue: "INACTIVE", key: "code", label: "Part", activeWhere: { status: "Active" } }); checks += 1;
  await assertReference({ delegate, field: "partCode", value: "", key: "code", label: "Part" }); checks += 1;

  const listDelegate = {
    findMany: async ({ where }) => where.id.in.filter((id) => id !== "missing").map((id) => ({ id })),
  };
  await assertReferenceList({ delegate: listDelegate, field: "divisionIds", values: ["d1", "d2"], key: "id", label: "Divisi" }); checks += 1;
  await expectReferenceError(() => assertReferenceList({ delegate: listDelegate, field: "divisionIds", values: ["d1", "missing"], key: "id", label: "Divisi" }), "divisionIds", "REFERENCE_NOT_FOUND"); checks += 1;

  const controllers = {
    PriceListController: ["partCode", "materialCode", "supplierCode"],
    ScrapPriceMasterController: ["partCode"],
    MachineController: ["warehouseCode"],
    DiesController: ["customerCode", "warehouseCode"],
    DiesMaintenanceController: ["vendorCode"],
    DiesUsageController: ["machineCode"],
    EmployeeController: ["divisionIds"],
  };
  Object.entries(controllers).forEach(([name, fields]) => {
    const source = fs.readFileSync(path.join(__dirname, "..", "src", "prisma", "controllers", "master-data", `${name}.js`), "utf8");
    fields.forEach((field) => {
      assert(new RegExp(`assertReference(?:List)?\\([\\s\\S]{0,500}field:\\s*[\"']${field}[\"']`).test(source), `${name} must validate ${field}`);
      checks += 1;
    });
  });

  const error = referenceError("supplierCode", "Supplier tidak valid.", "REFERENCE_NOT_FOUND");
  assert.deepStrictEqual(error.details, { field: "supplierCode" }); checks += 1;
  console.log(`Master reference validation contracts passed: ${checks}/${checks}`);
}

main().catch((error) => { console.error(error.stack || error); process.exit(1); });
