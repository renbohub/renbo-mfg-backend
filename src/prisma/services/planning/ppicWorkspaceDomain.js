"use strict";
const { createHash } = require("node:crypto");
const { activeRoleAssignments, rolePermissionMatches, userHasPermission } = require("../ai/permissionEvaluator");
const CONTEXT = { moduleCode: "planning-ppic", pageCode: "master-production-schedule" };
const READ_RESOURCES = ["mps", "mrp", "monthlyProductionPlan"];
const fail = (message, code = "INVALID_WORKSPACE_INPUT", statusCode = 400) => Object.assign(new Error(message), { code, statusCode });
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const plain = value => value && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const text = value => String(value ?? "").trim();
const numeric = value => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value)) ? Number(value) : null;
const iso = value => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null;

function monthKey(value) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(value || "")) || value < "1900-01" || value > "2199-12") throw fail("Periode harus YYYY-MM (1900–2199).", "INVALID_MONTH");
  return value;
}
function globalScope(scope) {
  if (scope == null) return true;
  if (!plain(scope)) return false;
  if (!Object.keys(scope).length) return true;
  return Object.keys(scope).length === 1 && ["ALL", "GLOBAL"].includes(String(scope.type || scope.scope || "").toUpperCase());
}
function scopedPermission(user, resourceCode, action = "read") {
  if (!userHasPermission(user, { resourceCode, action }, CONTEXT)) return false;
  if (user?.isSuperAdmin) return true;
  const assignments = activeRoleAssignments(user);
  if (!assignments.length) return true;
  return assignments.some(a => (a.role.permissions || []).some(p => rolePermissionMatches(p, { resourceCode, action }, CONTEXT) && globalScope(p.dataScope)));
}
function assertAccess(user, query = {}, mutation = null) {
  if (!user) throw fail("Login diperlukan.", "UNAUTHENTICATED", 401);
  if (query.plant && !["ALL", "ERP_GLOBAL"].includes(query.plant)) throw fail("Pemetaan plant pada demand, stok, dan WO belum tersedia. Workspace ini hanya mendukung seluruh ERP.", "PLANT_SCOPE_UNAVAILABLE", 403);
  const required = READ_RESOURCES.map(resourceCode => ({ resourceCode, action: "read" }));
  if (mutation) required.push({ resourceCode: "monthlyProductionPlan", action: mutation });
  for (const rule of required) {
    if (!userHasPermission(user, rule, CONTEXT)) throw fail(`Akses ${rule.action} ${rule.resourceCode} diperlukan.`, "WORKSPACE_FORBIDDEN", 403);
    if (!scopedPermission(user, rule.resourceCode, rule.action)) throw fail("Hak akses Anda dibatasi pada scope tertentu, tetapi pemetaan plant sumber PPIC belum lengkap. Data lintas scope tidak ditampilkan.", "PLANT_SCOPE_UNAVAILABLE", 403);
  }
}
function capabilities(user) {
  return { read: READ_RESOURCES.every(r => scopedPermission(user, r)), refresh: READ_RESOURCES.every(r => scopedPermission(user, r)), scenarioCreate: scopedPermission(user, "monthlyProductionPlan", "create"), scenarioUpdate: scopedPermission(user, "monthlyProductionPlan", "update"), release: false };
}
function normalizeScenario(input, update = false) {
  if (!plain(input)) throw fail("Isi skenario tidak valid.");
  const name = text(input.name), month = monthKey(input.month), sourceIdentifier = text(input.sourceIdentifier), sourceFingerprint = text(input.sourceFingerprint), operationId = text(input.operationId);
  if (!name || name.length > 120) throw fail("Nama skenario wajib diisi, maksimal 120 karakter.");
  if (!/^[a-f0-9]{64}$/.test(sourceFingerprint)) throw fail("Snapshot sumber tidak valid. Muat ulang Gantt.", "SOURCE_REQUIRED");
  if (!sourceIdentifier || sourceIdentifier.length > 100 || !/^[a-zA-Z0-9:_-]+$/.test(sourceIdentifier)) throw fail("Identitas sumber tidak valid.");
  if (!/^[a-zA-Z0-9_-]{16,100}$/.test(operationId)) throw fail("Identitas operasi wajib diisi untuk mencegah simpan ganda.", "OPERATION_ID_REQUIRED");
  if (update && (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1)) throw fail("Revisi skenario wajib diisi.", "REVISION_REQUIRED");
  if (!plain(input.payload) || input.payload.version !== 1 || !plain(input.payload.overrides)) throw fail("Format adjustment skenario tidak valid.");
  if (Object.keys(input.payload).some(k => !["version", "overrides"].includes(k))) throw fail("Snapshot dan hasil hitung harus berasal dari server. Kirim hanya version dan overrides.", "CLIENT_SEED_FORBIDDEN");
  const serialized = JSON.stringify(input.payload.overrides);
  if (Buffer.byteLength(serialized) > 2 * 1024 * 1024 || Object.keys(input.payload.overrides).length > 10000) throw fail("Adjustment skenario terlalu besar.");
  return { name, month, sourceIdentifier, sourceFingerprint, operationId, expectedRevision: input.expectedRevision, overrides: input.payload.overrides };
}
function validateOverrides(seed, overrides) {
  const nodes = new Map(seed.nodes.map(n => [n.id, n]));
  const allowed = { fg: ["qty", "targetDate"], process: ["cycleSeconds", "efficiency", "downtime", "transitionMinutes", "machineId"], vendor: ["cycleSeconds", "efficiency", "downtime", "transitionMinutes", "vendorId", "leadDays"], material: ["availableDate", "leadDays"] };
  const result = {};
  for (const [id, value] of Object.entries(overrides)) {
    const node = nodes.get(id);
    if (!node || !plain(value)) throw fail("Adjustment mengacu pada node yang tidak ada di snapshot.", "UNKNOWN_SCENARIO_NODE");
    for (const [key, item] of Object.entries(value)) {
      if (!(allowed[node.kind] || []).includes(key)) throw fail(`Field ${key} tidak dapat diubah untuk ${node.kind}.`, "INVALID_OVERRIDE_FIELD");
      if (["qty", "cycleSeconds", "efficiency", "transitionMinutes", "leadDays"].includes(key)) {
        const max = key === "qty" ? 1e9 : key === "efficiency" ? 1 : key === "leadDays" ? 365 : key === "transitionMinutes" ? 10080 : 86400;
        const min = key === "efficiency" ? .01 : 0;
        if (typeof item !== "number" || !Number.isFinite(item) || item < min || item > max) throw fail(`Nilai ${key} harus ${min}–${max}.`);
      }
      if (["targetDate", "availableDate"].includes(key) && (typeof item !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(item) || iso(item)?.slice(0, 10) !== item || item < seed.horizonStart || item >= seed.horizonEnd)) throw fail("Tanggal adjustment harus valid di dalam horizon snapshot.");
      if (key === "machineId" && !node.machineOptions?.some(m => m.machineId === item)) throw fail("Mesin belum qualified untuk routing ini.", "INVALID_MACHINE");
      if (key === "vendorId" && !seed.vendors?.some(v => v.id === item)) throw fail("Vendor aktif tidak ditemukan.", "INVALID_VENDOR");
      if (key === "downtime" && (!plain(item) || Object.entries(item).some(([k, v]) => !["coil", "dies", "rest", "setup", "briefing"].includes(k) || typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 10080))) throw fail("Downtime tidak valid.");
    }
    result[id] = value;
  }
  return result;
}
function state(value) {
  return ({ PASS: "OK", FEASIBLE: "OK", WARNING: "CONDITIONAL", FEASIBLE_WITH_RISK: "CONDITIONAL", FAIL: "BLOCKER", NOT_FEASIBLE: "BLOCKER", NA: "NA", "N/A": "NA", OK: "OK", BLOCKER: "BLOCKER", CONDITIONAL: "CONDITIONAL" })[value] || "UNKNOWN";
}
function worst(values) { return values.length ? [...values].sort((a, b) => ({ NA: 0, OK: 1, CONDITIONAL: 2, UNKNOWN: 3, BLOCKER: 4 })[b] - ({ NA: 0, OK: 1, CONDITIONAL: 2, UNKNOWN: 3, BLOCKER: 4 })[a])[0] : "UNKNOWN"; }
function totalsByUom(rows, field = "qty") {
  const totals = new Map();
  for (const row of rows) { const qty = numeric(row[field]); if (qty == null) continue; const uom = row.uom || "UNKNOWN"; totals.set(uom, (totals.get(uom) || 0) + qty); }
  return [...totals].map(([uom, qty]) => ({ uom, qty: Math.round(qty * 1e6) / 1e6 }));
}
module.exports = { fail, hash, plain, text, numeric, iso, monthKey, globalScope, scopedPermission, assertAccess, capabilities, normalizeScenario, validateOverrides, state, worst, totalsByUom };
