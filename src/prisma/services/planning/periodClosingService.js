const CLOSE_PREFIX = "PPIC_PERIOD_CLOSE_";

function normalizeMonth(value, fallback = new Date()) {
  const raw = String(value || "").trim();
  if (/^\d{4}-\d{2}$/.test(raw)) return raw;
  return `${fallback.getUTCFullYear()}-${String(fallback.getUTCMonth() + 1).padStart(2, "0")}`;
}

function periodBounds(month) {
  const key = normalizeMonth(month);
  const [year, monthNumber] = key.split("-").map(Number);
  const start = new Date(Date.UTC(year, monthNumber - 1, 1));
  const endExclusive = new Date(Date.UTC(year, monthNumber, 1));
  const end = new Date(endExclusive.getTime() - 1);
  return { month: key, start, end, endExclusive };
}

function settingKey(month) {
  return `${CLOSE_PREFIX}${normalizeMonth(month).replace("-", "_")}`;
}

function parseSetting(row, month) {
  let value = {};
  try { value = JSON.parse(row?.settingValue || "{}"); } catch (_) { value = {}; }
  return {
    month: normalizeMonth(month),
    status: value.status === "CLOSED" ? "CLOSED" : "OPEN",
    closedAt: value.closedAt || null,
    closedBy: value.closedBy || null,
    reopenedAt: value.reopenedAt || null,
    reopenedBy: value.reopenedBy || null,
    reason: value.reason || null,
    snapshot: value.snapshot || null,
  };
}

async function getPeriodState(tx, month) {
  const key = settingKey(month);
  const row = await tx.systemSetting.findUnique({ where: { settingKey: key } });
  return parseSetting(row, month);
}

async function assertPeriodOpen(tx, month) {
  const state = await getPeriodState(tx, month);
  if (state.status === "CLOSED") {
    throw Object.assign(new Error(`Periode PPIC ${state.month} sudah ditutup${state.closedBy ? ` oleh ${state.closedBy}` : ""}. Reopen periode sebelum mengubah MPS, MRP, Capacity, atau MPP.`), {
      statusCode: 409,
      code: "PPIC_PERIOD_CLOSED",
      periodState: state,
    });
  }
  return state;
}

async function savePeriodState(tx, month, payload, actor) {
  const key = settingKey(month);
  const state = { month: normalizeMonth(month), ...payload };
  const row = await tx.systemSetting.upsert({
    where: { settingKey: key },
    update: { settingValue: JSON.stringify(state), description: `PPIC period closing ${state.month}`, updatedBy: actor, isDeleted: false },
    create: { settingKey: key, settingValue: JSON.stringify(state), description: `PPIC period closing ${state.month}`, updatedBy: actor },
  });
  return parseSetting(row, state.month);
}

module.exports = { normalizeMonth, periodBounds, getPeriodState, assertPeriodOpen, savePeriodState };
