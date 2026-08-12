const AUTO_MODE = "AUTO_EFFECTIVE_DATE";
const MANUAL_MODE = "MANUAL_OVERRIDE";

const asDate = (value) => {
  if (!value) return null;
  const parsed = value instanceof Date ? new Date(value) : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

function isRevisionEffectiveAt(revision, selectionDate) {
  const at = asDate(selectionDate);
  if (!at) return true;
  const from = asDate(revision?.effectiveDate);
  const until = asDate(revision?.expiryDate);
  return (!from || from <= at) && (!until || until >= at);
}

function compareRevision(left, right) {
  const leftEffective = asDate(left?.effectiveDate)?.getTime() || 0;
  const rightEffective = asDate(right?.effectiveDate)?.getTime() || 0;
  return rightEffective - leftEffective
    || Number(right?.revision || 0) - Number(left?.revision || 0)
    || String(right?.id || "").localeCompare(String(left?.id || ""));
}

function resolveMbomRevision({ revisions = [], selectionDate, selectedId = null } = {}) {
  const available = revisions.filter((row) => row && row.isDeleted !== true).sort(compareRevision);
  const at = asDate(selectionDate);
  if (selectedId) {
    const selected = available.find((row) => row.id === selectedId);
    if (!selected) {
      const error = new Error("Revisi mBOM yang dipilih tidak ditemukan untuk part ini.");
      error.statusCode = 400;
      error.code = "MBOM_REVISION_INVALID";
      throw error;
    }
    const effective = isRevisionEffectiveAt(selected, at);
    return {
      revision: selected,
      mode: MANUAL_MODE,
      selectionDate: at,
      warning: effective ? null : "MANUAL_REVISION_OUTSIDE_EFFECTIVE_PERIOD",
    };
  }

  const selected = available.find((row) => isRevisionEffectiveAt(row, at)) || null;
  return {
    revision: selected,
    mode: AUTO_MODE,
    selectionDate: at,
    warning: selected ? null : "NO_EFFECTIVE_MBOM_FOR_DATE",
  };
}

function monthlySelectionKey(month, partCode) {
  return `${month}|${partCode}`;
}

function selectedRevisionId(selections, month, partCode) {
  if (!selections || typeof selections !== "object") return null;
  return selections[monthlySelectionKey(month, partCode)] || selections[partCode] || null;
}

module.exports = {
  AUTO_MODE,
  MANUAL_MODE,
  isRevisionEffectiveAt,
  monthlySelectionKey,
  resolveMbomRevision,
  selectedRevisionId,
};
