const { prisma } = require("../index");

const TOKENS = ["PREFIX", "YYYY", "YY", "MM", "DD", "SEQ", "CUSTOMER", "TYPE", "REV", "CODE", "LEVEL", "PROCESS", "BRANCH"];
const RESET_POLICIES = new Set(["NONE", "YEARLY", "MONTHLY", "DAILY"]);
const SIBLING_ALPHA_MODES = new Set(["NONE", "SAME_PROCESS", "ALWAYS"]);
const DEFAULT_RULES = [
  ["CUSTOMER", "Kode Customer", "CUS", "{PREFIX}-{SEQ}", 4, "NONE"], ["SUPPLIER", "Kode Supplier", "SUP", "{PREFIX}-{SEQ}", 4, "NONE"], ["VENDOR", "Kode Vendor", "VEN", "{PREFIX}-{SEQ}", 4, "NONE"],
  ["PART_FG_COMPONENT", "Part FG Component", "", "{CUSTOMER}-C{SEQ}-000", 3, "NONE"], ["PART_FG_NON_COMPONENT", "Part FG Non Component", "", "{CUSTOMER}-{SEQ}-000", 4, "NONE"],
  ["PART_CHILD_COMPONENT", "Child Part Component", "", "{CUSTOMER}-C{SEQ}-{BRANCH}-{PROCESS}", 3, "NONE"], ["PART_CHILD_NON_COMPONENT", "Child Part Non Component", "", "{CUSTOMER}-{SEQ}-{BRANCH}-{PROCESS}", 4, "NONE"],
  ["PRODUCT", "Kode Barang", "PRD", "{PREFIX}-{SEQ}", 4, "NONE"], ["MATERIAL", "Kode Material", "MAT", "{PREFIX}-{SEQ}", 4, "NONE"], ["PROCESS", "Kode Proses", "PRC", "{PREFIX}-{SEQ}", 4, "NONE"],
  ["DEPARTMENT", "Kode Departemen", "DPT", "{PREFIX}-{SEQ}", 3, "NONE"], ["DIVISION", "Kode Divisi", "DIV", "{PREFIX}-{SEQ}", 3, "NONE"], ["EMPLOYEE", "NIK Pegawai", "EMP", "{PREFIX}-{SEQ}", 5, "NONE"],
  ["MACHINE", "Kode Mesin", "MCH", "{PREFIX}-{SEQ}", 4, "NONE"], ["DIES", "Kode Dies", "DIE", "{PREFIX}-{SEQ}", 4, "NONE"], ["WAREHOUSE", "Kode Gudang", "WH", "{PREFIX}-{SEQ}", 3, "NONE"], ["RACK", "Kode Rak", "RCK", "{PREFIX}-{SEQ}", 4, "NONE"],
  ["SUB_PROCESS", "Kode Sub Proses", "SPR", "{PREFIX}-{SEQ}", 4, "NONE"], ["MATERIAL_ISSUE", "Material Issue", "MI", "{PREFIX}-{YYYY}{MM}{DD}-{SEQ}", 4, "DAILY"], ["PRODUCTION_LOG", "Production Log", "PL", "{PREFIX}-{YYYY}{MM}{DD}-{SEQ}", 4, "DAILY"],
  ["QUALITY_INSPECTION", "Quality Inspection", "QC", "{PREFIX}-{YYYY}{MM}{DD}-{SEQ}", 4, "DAILY"], ["VENDOR_PROCESS_ORDER", "Vendor Process Order", "VPO", "{PREFIX}-{YYYY}{MM}{DD}-{SEQ}", 4, "DAILY"], ["WIP", "WIP Entry", "WIP", "{PREFIX}-{YYYY}{MM}{DD}-{SEQ}", 4, "DAILY"],
  ["DOWNTIME", "Downtime Log", "DT", "{PREFIX}-{YYYY}{MM}{DD}-{SEQ}", 4, "DAILY"], ["DAILY_PRODUCTION_SCHEDULE", "Daily Production Schedule", "DPS", "{PREFIX}-{YYYY}{MM}{DD}-{SEQ}", 4, "DAILY"], ["PLANNED_ORDER", "Planned Order", "PO", "{PREFIX}-{YYYY}{MM}{DD}-{SEQ}", 4, "DAILY"],
  ["LOT", "Lot Umum", "LOT", "{PREFIX}-{YYYY}{MM}{DD}-{SEQ}", 4, "DAILY"],
  ["LOT_INCOMING", "Lot Internal Incoming", "INLOT", "{PREFIX}-{YYYY}{MM}{DD}-{SEQ}", 4, "DAILY"],
  ["LOT_PRODUCTION", "Lot Finished Goods Production", "FGLOT", "{PREFIX}-{YYYY}{MM}{DD}-{SEQ}", 4, "DAILY"],
  ["LOT_WIP", "Lot Work In Process", "WIPLOT", "{PREFIX}-{YYYY}{MM}{DD}-{SEQ}", 4, "DAILY"],
  ["LOT_VENDOR_PROCESS", "Lot Vendor Process", "VPLOT", "{PREFIX}-{YYYY}{MM}{DD}-{SEQ}", 4, "DAILY"],
  ["LOT_ADJUSTMENT", "Lot Inventory Adjustment", "ADJLOT", "{PREFIX}-{YYYY}{MM}{DD}-{SEQ}", 4, "DAILY"]
];

function pad(value, size = 2) { return String(value).padStart(size, "0"); }
function resetKey(policy, date) {
  const year = date.getFullYear(); const month = pad(date.getMonth() + 1); const day = pad(date.getDate());
  if (policy === "YEARLY") return String(year);
  if (policy === "MONTHLY") return `${year}${month}`;
  if (policy === "DAILY") return `${year}${month}${day}`;
  return "NONE";
}
function normalizeRuleInput(data = {}) {
  const ruleKey = String(data.ruleKey || "").trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  const pattern = String(data.pattern || "{PREFIX}-{SEQ}").trim().toUpperCase();
  if (!ruleKey) throw Object.assign(new Error("Rule Key wajib diisi."), { statusCode: 400 });
  if (!pattern.includes("{SEQ}")) throw Object.assign(new Error("Pattern wajib memiliki token {SEQ}."), { statusCode: 400 });
  const unknown = [...pattern.matchAll(/\{([A-Z_]+)\}/g)].map((match) => match[1]).filter((token) => !TOKENS.includes(token));
  if (unknown.length) throw Object.assign(new Error(`Token tidak dikenal: ${[...new Set(unknown)].join(", ")}.`), { statusCode: 400 });
  const resetPolicy = String(data.resetPolicy || "NONE").toUpperCase();
  const siblingAlphaMode = String(data.siblingAlphaMode || "SAME_PROCESS").toUpperCase();
  const processStep = Math.min(1000, Math.max(1, Number.parseInt(data.processStep, 10) || 10));
  const insertionStart = Number.parseInt(data.insertionStart, 10) || processStep + 1;
  if (insertionStart <= processStep || insertionStart >= processStep * 2) {
    throw Object.assign(new Error(`Awal sisipan harus antara ${processStep + 1} dan ${processStep * 2 - 1}.`), { statusCode: 400 });
  }
  return {
    ...data, ruleKey, pattern, resetPolicy: RESET_POLICIES.has(resetPolicy) ? resetPolicy : "NONE",
    prefix: String(data.prefix || "").trim().toUpperCase(), sequenceLength: Math.min(12, Math.max(1, Number(data.sequenceLength || 4))),
    nextNumber: Math.max(1, Number(data.nextNumber || 1)), incrementBy: Math.max(1, Number(data.incrementBy || 1)),
    processStep, insertionStart,
    siblingAlphaMode: SIBLING_ALPHA_MODES.has(siblingAlphaMode) ? siblingAlphaMode : "SAME_PROCESS",
    inheritBranchAlpha: data.inheritBranchAlpha !== false && data.inheritBranchAlpha !== "false",
    isActive: data.isActive !== false && data.isActive !== "false", isDeleted: data.isDeleted === true || data.isDeleted === "true",
  };
}
function formatNumber(rule, sequence, context = {}, date = new Date()) {
  const values = {
    PREFIX: context.prefix ?? rule.prefix ?? "", YYYY: String(date.getFullYear()), YY: String(date.getFullYear()).slice(-2), MM: pad(date.getMonth() + 1), DD: pad(date.getDate()),
    SEQ: pad(sequence, rule.sequenceLength || 4), CUSTOMER: context.customer || context.customerCode || "", TYPE: context.type || "", REV: context.rev || context.revision || "00", CODE: context.code || "", LEVEL: context.level || context.process || "000", PROCESS: context.process || context.processSequence || context.level || "000", BRANCH: context.branch || context.branchCode || "",
  };
  return String(rule.pattern || "{PREFIX}-{SEQ}").replace(/\{([A-Z_]+)\}/g, (_match, token) => String(values[token] ?? "").toUpperCase()).replace(/-{2,}/g, "-").replace(/^-|-$/g, "");
}
async function getRule(ruleKey, db = prisma) {
  try { return await db.numberingRule.findFirst({ where: { ruleKey: String(ruleKey).toUpperCase(), isDeleted: false } }); }
  catch (error) { if (["P2021", "P2022"].includes(error?.code) || !db.numberingRule) return null; throw error; }
}
async function ensureDefaultNumberingRules(db = prisma) {
  if (!db.numberingRule) return;
  await Promise.all(DEFAULT_RULES.map(([ruleKey]) => ensureDefaultNumberingRule(ruleKey, db)));
}
async function ensureDefaultNumberingRule(ruleKey, db = prisma) {
  if (!db.numberingRule) return null;
  const definition = DEFAULT_RULES.find(([key]) => key === String(ruleKey || "").trim().toUpperCase());
  if (!definition) return null;
  const [key, ruleName, prefix, pattern, sequenceLength, resetPolicy] = definition;
  return db.numberingRule.upsert({
    where: { ruleKey: key },
    update: {},
    create: { ruleKey: key, ruleName, prefix, pattern, sequenceLength, resetPolicy, notes: "Rule default sistem. Pola dapat diubah dari master data." },
  });
}
async function previewConfiguredNumber(ruleKey, options = {}) {
  const rule = await getRule(ruleKey, options.db || prisma); return rule ? formatNumber(rule, rule.nextNumber, options.context, options.date || new Date()) : null;
}
async function generateConfiguredNumber(ruleKey, options = {}) {
  const db = options.db || prisma; const rule = await getRule(ruleKey, db);
  if (!rule || !rule.isActive) return typeof options.fallback === "function" ? options.fallback() : null;
  const date = options.date || new Date(); const bucket = resetKey(rule.resetPolicy, date);
  if (rule.resetPolicy !== "NONE" && rule.lastResetKey !== bucket) {
    await db.numberingRule.updateMany({ where: { id: rule.id, OR: [{ lastResetKey: { not: bucket } }, { lastResetKey: null }] }, data: { nextNumber: 1, lastResetKey: bucket } });
  }
  const updated = await db.numberingRule.update({ where: { id: rule.id }, data: { nextNumber: { increment: rule.incrementBy } }, select: { nextNumber: true, incrementBy: true, prefix: true, pattern: true, sequenceLength: true } });
  return formatNumber(updated, updated.nextNumber - updated.incrementBy, options.context, date);
}

module.exports = { TOKENS, RESET_POLICIES, SIBLING_ALPHA_MODES, DEFAULT_RULES, normalizeRuleInput, formatNumber, getRule, ensureDefaultNumberingRule, ensureDefaultNumberingRules, previewConfiguredNumber, generateConfiguredNumber };
