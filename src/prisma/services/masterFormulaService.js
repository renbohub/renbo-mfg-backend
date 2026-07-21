const DEFAULT_FORMULAS = Object.freeze({
  MPS_BUFFER_QTY: "round(bufferBaseQty * bufferPercent / 100, 6)",
  MPS_EFFECTIVE_DEMAND: "forecastQty + bufferQty",
  MPS_TARGET_QTY: "max(effectiveDemandQty * productionPercent / 100, actualSalesOrderQty)",
  MRP_NET_REQUIREMENT: "max(grossRequirement - projectedAvailable, 0)",
  MRP_ADJUSTED_ORDER: "max(netRequirement * orderPercent / 100, soConsumedQty)",
  LINE_AFTER_DISCOUNT: "qty * unitPrice * (1 - discount / 100)",
  LINE_TOTAL: "afterDiscount * (1 + tax / 100)",
  LOAD_MINUTES: "qty * cycleTimeMinutes / max(efficiencyPercent / 100, 0.000001)",
});

const FUNCTIONS = {
  min: (...a) => Math.min(...a), max: (...a) => Math.max(...a), abs: Math.abs,
  ceil: Math.ceil, floor: Math.floor,
  round: (value, digits = 0) => { const p = 10 ** Math.max(0, Math.trunc(digits)); return Math.round(value * p) / p; },
};

class Parser {
  constructor(expression, variables = {}) { this.s = String(expression || ""); this.i = 0; this.vars = variables; this.names = new Set(); }
  ws() { while (/\s/.test(this.s[this.i] || "")) this.i += 1; }
  eat(c) { this.ws(); if (this.s[this.i] === c) { this.i += 1; return true; } return false; }
  number() { this.ws(); const m = this.s.slice(this.i).match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i); if (!m) return null; this.i += m[0].length; return Number(m[0]); }
  identifier() { this.ws(); const m = this.s.slice(this.i).match(/^[A-Za-z_][A-Za-z0-9_]*/); if (!m) return null; this.i += m[0].length; return m[0]; }
  primary() {
    this.ws(); const n = this.number(); if (n !== null) return n;
    if (this.eat("(")) { const v = this.add(); if (!this.eat(")")) throw new Error("Missing closing parenthesis"); return v; }
    const name = this.identifier(); if (!name) throw new Error(`Unexpected token at ${this.i + 1}`);
    this.ws();
    if (this.eat("(")) { if (!FUNCTIONS[name]) throw new Error(`Function ${name} is not allowed`); const args = []; if (!this.eat(")")) { do { args.push(this.add()); } while (this.eat(",")); if (!this.eat(")")) throw new Error("Missing function parenthesis"); } return FUNCTIONS[name](...args); }
    this.names.add(name); const value = this.vars[name]; if (value === undefined || value === null || value === "") throw new Error(`Variable ${name} is not provided`); const result = Number(value); if (!Number.isFinite(result)) throw new Error(`Variable ${name} must be numeric`); return result;
  }
  unary() { this.ws(); if (this.eat("+")) return this.unary(); if (this.eat("-")) return -this.unary(); return this.primary(); }
  mul() { let v = this.unary(); for (;;) { if (this.eat("*")) v *= this.unary(); else if (this.eat("/")) { const d = this.unary(); if (d === 0) throw new Error("Division by zero"); v /= d; } else if (this.eat("%")) v %= this.unary(); else return v; } }
  add() { let v = this.mul(); for (;;) { if (this.eat("+")) v += this.mul(); else if (this.eat("-")) v -= this.mul(); else return v; } }
  parse() { const value = this.add(); this.ws(); if (this.i !== this.s.length) throw new Error(`Unexpected token at ${this.i + 1}`); if (!Number.isFinite(value)) throw new Error("Formula result is not finite"); return value; }
}

function evaluateFormula(expression, variables = {}) { return new Parser(expression, variables).parse(); }
function validateExpression(expression, variableNames = []) {
  const vars = Object.fromEntries(variableNames.map((name) => [name, 1]));
  const parser = new Parser(expression, vars); parser.parse();
  return true;
}
function key(value) { return String(value || "").trim().toUpperCase(); }
async function getFormulaSet(prisma, moduleCode) {
  const rows = await prisma.masterFormula.findMany({ where: { moduleCode: String(moduleCode).toLowerCase(), isDeleted: false, isActive: true, OR: [{ effectiveFrom: null }, { effectiveFrom: { lte: new Date() } }], AND: [{ OR: [{ effectiveUntil: null }, { effectiveUntil: { gte: new Date() } }] }] }, orderBy: [{ formulaKey: "asc" }, { version: "desc" }] });
  const map = new Map(); rows.forEach((row) => { if (!map.has(key(row.formulaKey))) map.set(key(row.formulaKey), row); });
  Object.entries(DEFAULT_FORMULAS).forEach(([formulaKey, expression]) => { if (!map.has(formulaKey)) map.set(formulaKey, { formulaKey, expression, version: 0, source: "fallback" }); });
  return map;
}
function evaluateFromSet(formulaSet, formulaKey, variables) { const formula = formulaSet?.get(key(formulaKey)); return evaluateFormula(formula?.expression || DEFAULT_FORMULAS[key(formulaKey)], variables); }

module.exports = { DEFAULT_FORMULAS, evaluateFormula, validateExpression, getFormulaSet, evaluateFromSet, key };
