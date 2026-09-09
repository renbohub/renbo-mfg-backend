const { AsyncLocalStorage } = require("node:async_hooks");
const context = new AsyncLocalStorage();
const KEY = "DEMO_CURRENT_DATE";

function validateDate(value) {
  if (value === null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < "1900-01-01" || value > "2199-12-31") {
    throw Object.assign(new Error("Tanggal harus YYYY-MM-DD, antara tahun 1900 dan 2199."), { status: 400 });
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw Object.assign(new Error("Tanggal tidak valid."), { status: 400 });
  }
  return value;
}

// Explicit business clock: never replace the native Date or security/audit clocks.
function businessNow() {
  const date = context.getStore();
  return date ? new Date(`${date}T00:00:00.000Z`) : new Date();
}
function withBusinessDate(date, callback) { return context.run(validateDate(date), callback); }
function isDemoMode() { return Boolean(context.getStore()); }
async function readDemoDate(prisma) {
  const row = await prisma.systemSetting.findUnique({ where: { settingKey: KEY } });
  return row && !row.isDeleted && row.settingValue ? validateDate(row.settingValue) : null;
}
function clockMiddleware(prisma) {
  return async (_req, _res, next) => {
    try { withBusinessDate(await readDemoDate(prisma), next); } catch (error) { next(error); }
  };
}
module.exports = { KEY, validateDate, businessNow, withBusinessDate, readDemoDate, clockMiddleware, isDemoMode };
