const assert = require("node:assert/strict");
const {
  AUTO_MODE,
  MANUAL_MODE,
  isRevisionEffectiveAt,
  monthlySelectionKey,
  resolveMbomRevision,
  selectedRevisionId,
} = require("../src/prisma/services/planning/mbomRevisionService");

const revisions = [
  { id: "rev-1", noReg: "MBOM-001", revision: 1, effectiveDate: new Date("2026-07-01T00:00:00Z"), expiryDate: new Date("2026-08-14T23:59:59Z"), isDeleted: false },
  { id: "rev-2", noReg: "MBOM-002", revision: 2, effectiveDate: new Date("2026-08-15T00:00:00Z"), expiryDate: null, isDeleted: false },
  { id: "deleted", noReg: "MBOM-003", revision: 3, effectiveDate: new Date("2026-08-01T00:00:00Z"), expiryDate: null, isDeleted: true },
];

const historical = resolveMbomRevision({ revisions, selectionDate: "2026-08-10T07:00:00Z" });
assert.equal(historical.mode, AUTO_MODE);
assert.equal(historical.revision.id, "rev-1", "MPS sebelum effective date revisi baru harus memakai revisi lama");

const current = resolveMbomRevision({ revisions, selectionDate: "2026-08-20T07:00:00Z" });
assert.equal(current.revision.id, "rev-2", "MPS setelah effective date harus memakai revisi baru");

const manualHistorical = resolveMbomRevision({ revisions, selectionDate: "2026-08-20T07:00:00Z", selectedId: "rev-1" });
assert.equal(manualHistorical.mode, MANUAL_MODE);
assert.equal(manualHistorical.warning, "MANUAL_REVISION_OUTSIDE_EFFECTIVE_PERIOD");

const noEffective = resolveMbomRevision({ revisions: [{ ...revisions[1], effectiveDate: new Date("2026-09-01T00:00:00Z") }], selectionDate: "2026-08-20" });
assert.equal(noEffective.revision, null);
assert.equal(noEffective.warning, "NO_EFFECTIVE_MBOM_FOR_DATE");

assert.equal(isRevisionEffectiveAt(revisions[0], "2026-08-14T12:00:00Z"), true);
assert.equal(monthlySelectionKey("2026-08", "FG-001"), "2026-08|FG-001");
assert.equal(selectedRevisionId({ "2026-08|FG-001": "rev-2", "FG-002": "rev-1" }, "2026-08", "FG-001"), "rev-2");
assert.equal(selectedRevisionId({ "FG-002": "rev-1" }, "2026-09", "FG-002"), "rev-1");
assert.throws(() => resolveMbomRevision({ revisions, selectionDate: "2026-08-20", selectedId: "missing" }), /tidak ditemukan/);

console.log("MBOM revision selection: 12/12 PASS");
