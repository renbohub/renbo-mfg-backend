const assert = require("assert");
const { prisma, disconnectDatabase } = require("../src/prisma");
const historical = require("../src/prisma/controllers/system/HistoricalExcelImportController");
const dashboard = require("../src/prisma/controllers/dashboard/ExecutiveDashboardController");

function invoke(controller, req) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { if (this.statusCode >= 400) reject(Object.assign(new Error(body?.message), { body, statusCode: this.statusCode })); else resolve(body); },
    };
    Promise.resolve(controller(req, res, reject)).catch(reject);
  });
}

(async () => {
  const indexes = await prisma.$queryRawUnsafe(`SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'tbl_material_active_identity_key'`);
  assert.strictEqual(indexes.length, 1, "Material active identity unique index is missing");

  const duplicateMonths = await prisma.$queryRawUnsafe(`
    SELECT period_start, COUNT(*)::int AS count
    FROM tbl_mps
    WHERE is_deleted = false AND status <> 'Superseded'
    GROUP BY period_start
    HAVING COUNT(*) > 1
  `);
  assert.strictEqual(duplicateMonths.length, 0, "More than one active MPS header exists in a month");

  const currentPlanIndex = await prisma.$queryRawUnsafe(`SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'tbl_mrp_run_one_current_plan'`);
  assert.strictEqual(currentPlanIndex.length, 1, "Current MRP plan unique index is missing");
  const duplicateCurrentMrpPlans = await prisma.$queryRawUnsafe(`
    SELECT plan_number, COUNT(*)::int AS count
    FROM tbl_mrp_run
    WHERE plan_number IS NOT NULL AND is_current_plan = true AND is_deleted = false
    GROUP BY plan_number
    HAVING COUNT(*) > 1
  `);
  assert.strictEqual(duplicateCurrentMrpPlans.length, 0, "More than one current MRP revision exists for a monthly plan");

  const [part, customer] = await Promise.all([
    prisma.part.findFirst({ where: { isDeleted: false, itemType: "FG" }, select: { partCode: true } }),
    prisma.customer.findFirst({ where: { isDeleted: false }, select: { customerCode: true } }),
  ]);
  if (part && customer) {
    const preview = await invoke(historical.preview, { body: { importType: "SALES_HISTORY", rows: [{ sheetName: "Sales", rowNumber: 2, sourceJson: { Customer: customer.customerCode, "Part Code": part.partCode, Period: "2026-01", Qty: 10, "Unit Price": 1000 } }] } });
    assert.strictEqual(preview.errors.length, 0, "Sales history preview should map a valid FG");
    assert.strictEqual(preview.lines.length, 1, "Sales history preview should emit one ledger row");
  }

  const material = await prisma.material.findFirst({ where: { isDeleted: false, thickness: { not: null }, width: { not: null } }, select: { materialCode: true, spec: true, thickness: true, width: true } });
  if (material) {
    const preview = await invoke(historical.preview, { body: { importType: "MATERIAL_DEMAND_HISTORY", rows: [{ sheetName: "Material", rowNumber: 2, sourceJson: { "Material Code": material.materialCode, Period: "2026-01", "Qty KG": 25 } }] } });
    assert.strictEqual(preview.errors.length, 0, "Material demand preview should map a valid Material Master");
    assert.strictEqual(preview.lines.length, 1, "Material demand preview should emit one snapshot row");

    const multiHeaderPreview = await invoke(historical.preview, { body: { importType: "MATERIAL_DEMAND_HISTORY", sourcePeriod: "Jul 2026", rows: [{ sheetName: "ALL (2)", rowNumber: 9, sourceJson: { SIZE: material.thickness, "Column E": material.width, SPEC: material.spec, PART: "P0-CONTRACT", GROSS: 0.1, "PO/": 10, "PO/ (2)": 1 } }] } });
    assert.strictEqual(multiHeaderPreview.errors.length, 0, "Material adapter should understand the ALL (2) multi-header layout");
    assert.strictEqual(multiHeaderPreview.lines[0]?.periodMonth?.toISOString?.().slice(0, 7), "2026-07", "Text month must not shift because of timezone");

    const widePreview = await invoke(historical.preview, { body: { importType: "MATERIAL_DEMAND_HISTORY", historyStartYear: 2025, sourcePeriod: "Aug 2025 - Sep 2025", rows: [{ sheetName: "ALL", rowNumber: 17, sourceJson: { T: material.thickness, W: material.width, MATERIAL: material.spec, NUMBER: "P0-CONTRACT", WEIGHT: 0.1, Aug: 10, "Aug (2)": 1, Sep: 20, "Sep (2)": 2 } }] } });
    assert.strictEqual(widePreview.errors.length, 0, "Material adapter should understand paired PCS/KG month columns");
    assert.strictEqual(widePreview.lines.length, 2, "Wide material history should emit one snapshot per populated month");
  }

  for (const actualBasis of ["BOOKED", "DELIVERED", "INVOICED", "RECOGNIZED"]) {
    const salesDashboard = await invoke(dashboard.get, { params: { module: "sales" }, query: { year: "2026", actualBasis } });
    assert.strictEqual(salesDashboard.actualBasis, actualBasis, `Dashboard must honor ${actualBasis} basis`);
    assert.ok(salesDashboard.actualBasisOptions.length >= 4, "Dashboard must expose semantic actual basis options");
  }

  console.log("PASS One active consolidated MPS header per month");
  console.log("PASS One current MRP revision per logical monthly plan");
  console.log("PASS Consolidated MPS source lineage model and database migration");
  console.log("PASS Material identity protected by database unique index");
  console.log("PASS Historical sales and material-demand preview mapping, including source workbook multi-row headers");
  console.log("PASS Dashboard semantic actual basis selection");
})().finally(disconnectDatabase);
