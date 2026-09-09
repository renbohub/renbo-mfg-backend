"use strict";

const { businessNow } = require("../../utils/businessClock");
const { summarizeChecks, summarizeMpsAssessments } = require("./scheduleFeasibilityAggregator");
const VERSION = "MPS_PRODUCTION_CHECKSHEET_V3";
const DEFINITIONS = {
  MPS_MATERIAL: ["Material & waktu pembelian", "MATERIAL_SUPPLY"],
  MPS_CAPACITY: ["Kapasitas produksi", "PRODUCTION_CAPACITY"],
  MPS_VENDOR: ["Lead time proses vendor", "VENDOR_PROCESS"],
};
const numeric = (v) => v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v));
const n = (v) => numeric(v) ? Number(v) : null;
const iso = (v) => v && Number.isFinite(new Date(v).getTime()) ? new Date(v).toISOString() : null;
const date = (v) => iso(v)?.slice(0, 10) || null;
const measure = (display, value = null, unit = null) => ({ display, value, unit });
const fmt = (value) => new Intl.NumberFormat("id-ID", { maximumFractionDigits: 2 }).format(value);
const worst = (rows) => ["FAIL", "NOT_CHECKED", "WARNING", "PASS", "NA"].find((s) => rows.some((r) => r.status === s)) || "NOT_CHECKED";
const unknown = (reason, fields) => ({ status: "NOT_CHECKED", reason, missingFields: fields });
const na = (reason) => ({ status: "NA", reason });

function materialCheck(input) {
  if (input.materials?.error) return unknown(input.materials.error.message, [input.materials.error.code]);
  const rows = input.materials?.components || [];
  if (input.materials?.applicable === false) return na("BOM tidak memerlukan material.");
  if (!rows.length) return unknown("Coverage material BOM pada revisi MPS ini belum tersedia.", ["currentMaterialCoverage"]);
  const evidence = rows.map((r) => {
    const shortage = n(r.shortageQty); // Firm net requirement; never treat an unconfirmed PR as available stock.
    const required = n(r.requiredComponentQty ?? r.qty);
    const needAt = date(r.requiredDate);
    const latestPurchaseAt = date(r.latestPrDate);
    const missing = shortage === null || required === null || !needAt;
    let status = missing ? "NOT_CHECKED" : shortage <= 0 ? "PASS" : "WARNING";
    let purchase = missing ? "Data belum lengkap" : shortage <= 0 ? "Tidak perlu pembelian tambahan" : "Pembelian masih keburu";
    if (!missing && shortage > 0) {
      if (r.procurementWindow === "CUSTOMER_SUPPLIED") {
        const lateConfirmed = (r.lateSupply || []).filter((s) => s.confidence === "FIRM").reduce((sum, s) => sum + Number(s.qty || 0), 0);
        status = lateConfirmed >= shortage ? "FAIL" : "NOT_CHECKED";
        purchase = lateConfirmed >= shortage ? "Suplai customer terkonfirmasi, tetapi terlambat" : "Qty / ETA suplai customer belum menutup kekurangan";
      }
      else if (!latestPurchaseAt || !numeric(r.procurementLeadTimeDays) || !(r.supplierCode || r.supplierName)) { status = "NOT_CHECKED"; purchase = "Supplier / lead time pembelian belum lengkap"; }
      else if (numeric(r.supplierLeadTimeDays) && Number(r.procurementLeadTimeDays) < Number(r.supplierLeadTimeDays)) { status = "NOT_CHECKED"; purchase = "Jadwal pembelian belum memakai lead time supplier penuh"; }
      else if (latestPurchaseAt < date(input.asOf)) { status = "FAIL"; purchase = "Pembelian normal tidak keburu; minta percepatan"; }
    }
    if (!missing && shortage <= 0 && r.procurementWindow === "CUSTOMER_SUPPLIED") purchase = "Ditutup stok / kiriman customer terkonfirmasi tepat waktu";
    return { partCode: r.partCode, partName: r.partName, uomCode: r.uomCode, requiredQty: required, availableQty: required === null || shortage === null ? null : Math.max(required - shortage, 0), shortageQty: shortage, requiredDate: needAt, latestPurchaseAt, leadTimeDays: n(r.procurementLeadTimeDays), purchase, status, supplierCode: r.supplierCode || null, supplyCustomerCode: r.supplyCustomerCode || null, supplyReference: (r.eligibleSupply || []).map((s) => s.sourceNumber).filter(Boolean).join(", ") };
  });
  const status = worst(evidence);
  const shortages = evidence.filter((r) => r.shortageQty > 0).length;
  const late = evidence.filter((r) => r.status === "FAIL").length;
  const customerEtaMissing = rows.some((r) => r.procurementWindow === "CUSTOMER_SUPPLIED" && n(r.shortageQty) > 0);
  return { status, evidence, missingFields: evidence.filter((r) => r.status === "NOT_CHECKED").map((r) => `material.${r.partCode}.coverageOrPurchaseWindow`),
    actual: measure(`${shortages} dari ${rows.length} material kurang`), requirement: measure("Material cukup pada tanggal mulai proses"), gap: measure(late ? `${late} pembelian melewati batas waktu` : customerEtaMissing ? "Kurang material; menunggu ETA customer" : shortages ? "Perlu tambahan supply" : "Cukup"),
    reason: status === "PASS" ? "Stok dan receipt firm tepat waktu menutup kebutuhan BOM." : status === "WARNING" ? "Material kurang, tetapi batas pengajuan pembelian belum lewat." : status === "FAIL" ? "Ada material kurang dan pembelian dengan lead time normal sudah terlambat." : customerEtaMissing ? "Kebutuhan dan kekurangan sudah dihitung. Tanggal kedatangan suplai customer belum terkonfirmasi." : "Kecukupan material atau waktu pengadaannya belum dapat dipastikan.",
    recommendation: shortages ? customerEtaMissing ? "Buka Suplai Material Customer: konfirmasi qty, ETA, dan tanggal siap setelah QC; percepat kiriman yang terlambat." : "Konfirmasi jumlah dan tanggal kedatangan material dengan Purchasing; percepat bila melewati batas." : null };
}

function capacityCheck(input) {
  const cap = input.capacity || {};
  const required = n(cap.requiredCapacityHours), available = n(cap.netAvailableCapacityHours);
  if (!cap.rccpRunId || required === null || available === null || !["FEASIBLE", "WARNING", "OVERLOAD", "OVERRIDDEN"].includes(cap.status)) return unknown("Hasil RCCP untuk revisi MPS ini belum tersedia.", ["currentRccpLoad"]);
  const gap = available - required;
  const status = gap < -0.000001 ? "FAIL" : required > 0 && available > 0 && required / available * 100 >= (n(cap.warningThreshold) ?? 90) ? "WARNING" : "PASS";
  return { status, actual: measure(`${fmt(required)} jam dibutuhkan`, required, "hour"), requirement: measure(`${fmt(available)} jam tersedia`, available, "hour"), gap: measure(gap < 0 ? `Kurang ${fmt(Math.abs(gap))} jam` : `Sisa ${fmt(gap)} jam`),
    evidence: cap.evidence || [], reason: status === "FAIL" ? "Beban produksi melebihi kapasitas pada work center / periode terkait." : status === "WARNING" ? "Kapasitas cukup dengan sisa jam terbatas." : "Beban produksi masih di dalam kapasitas RCCP.", recommendation: status !== "PASS" ? "Tinjau overtime, penambahan shift, atau alternatif line bersama Production." : null };
}

function vendorCheck(input) {
  const vendor = input.vendor || {};
  if (vendor.error) return unknown(vendor.error.message, [vendor.error.code]);
  if (!vendor.bomAvailable) return unknown("BOM belum tersedia untuk menentukan proses vendor.", ["effectiveBom"]);
  if (!vendor.processes?.length) return na("Tidak ada proses vendor pada BOM.");
  const timeline = vendor.current ? vendor.timeline || [] : [];
  const forward = vendor.solver?.forward;
  const tasks = vendor.current && forward?.feasible === true ? forward.tasks || [] : [];
  const evidence = vendor.processes.map((p) => {
    const matched = timeline.filter((r) => r.routingMode === "VENDOR" && r.processCode === p.processCode && (!p.vendorCode || r.vendorCode === p.vendorCode));
    // Repeated occurrences are separate operations. Use every matching occurrence, never just the first.
    const slots = matched.map((r) => ({ row: r, task: tasks.find((t) => t.id === r.solverTaskId) }));
    const lt = n(p.vendorLeadTimeDays);
    const valid = Boolean(p.vendorCode && lt !== null && slots.length && slots.every(({ row, task }) => iso(row.latestFinishDate) && iso(task?.endDate) && numeric(row.baselineDurationDays) && numeric(row.durationDays) && Number(row.durationDays) >= Number(row.baselineDurationDays) && Number(row.baselineDurationDays) >= lt));
    const late = valid ? Math.max(...slots.map(({ row, task }) => (new Date(task.endDate) - new Date(row.latestFinishDate)) / 86400000)) : null;
    const latest = slots.map(({ row }) => iso(row.latestFinishDate)).filter(Boolean).sort().at(-1) || null;
    const returned = slots.map(({ task }) => iso(task?.endDate)).filter(Boolean).sort().at(-1) || null;
    return { ...p, latestReturnAt: latest, projectedReturnAt: returned, lateDays: late === null ? null : Math.max(late, 0), status: !valid ? "NOT_CHECKED" : late > 0 ? "FAIL" : "PASS" };
  });
  const status = worst(evidence);
  return { status, evidence, missingFields: evidence.filter((r) => r.status === "NOT_CHECKED").map((r) => `vendor.${r.processCode}.bomLeadTimeOrCurrentSchedule`),
    actual: measure(`${evidence.filter((r) => r.status === "PASS").length} / ${evidence.length} proses tepat waktu`), requirement: measure("Kembali sebelum proses berikutnya, dengan lead time BOM"), gap: measure(status === "FAIL" ? "Perlu percepatan vendor" : status === "NOT_CHECKED" ? "Jadwal / lead time belum lengkap" : "Sesuai"),
    reason: status === "PASS" ? "Jadwal CP-SAT memenuhi batas kembali proses vendor tanpa memotong lead time BOM." : status === "FAIL" ? "Proses vendor selesai setelah batas yang dibutuhkan untuk melanjutkan produksi." : "Lead time BOM dan hasil jadwal vendor terkini belum dapat dibandingkan.", recommendation: status !== "PASS" ? "Konfirmasi percepatan proses atau alternatif vendor dengan Purchasing." : null };
}

function check(code, result, evaluatedAt) {
  return { code, id: code, label: DEFINITIONS[code][0], group: DEFINITIONS[code][0], checkpointCode: DEFINITIONS[code][1], critical: true,
    requirement: measure("—"), actual: measure("—"), gap: measure("—"), evidence: [], missingFields: [], ...result,
    applicable: result.status !== "NA", passed: result.status === "PASS", blocking: result.status === "FAIL", state: result.status, evaluatedAt, evaluationAttempted: true,
    evaluationOutcome: result.status === "NA" ? "NOT_APPLICABLE" : result.status === "NOT_CHECKED" || result.missingFields?.length ? "DATA_MISSING" : "EVALUATED" };
}
function result(input, checks, schedule) {
  const summary = summarizeChecks(checks, { evaluatedAt: iso(input.asOf), rulesVersion: VERSION, formulaVersion: input.mpsCalculation?.formulaVersion, earliestFeasibleDeliveryAt: schedule?.projectedCustomerArrivalAt });
  return { identity: input.identity || {}, mpsCalculation: input.mpsCalculation || null, productionSchedule: schedule || {}, summary, checklistSummary: summary, checks, checklist: checks, ...summary };
}
function buildMpsFeasibilityAssessment(input = {}) {
  input = { ...input, asOf: input.asOf || businessNow() };
  const qty = n(input.mpsQty ?? input.identity?.mpsQty);
  const checks = [materialCheck, capacityCheck, vendorCheck].map((rule, i) => check(Object.keys(DEFINITIONS)[i], qty === null ? unknown("Jumlah produksi MPS belum tersedia.", ["mpsQty"]) : qty > 0 ? rule(input) : na("Tidak ada kebutuhan produksi pada baris ini."), iso(input.asOf)));
  return result(input, checks, { ...input.schedule, customerDelivery: input.schedule?.customerDelivery ?? input.rowType !== "BUFFER" });
}
function aggregateMpsFeasibilityAssessments(children = [], input = {}) {
  if (!children.length) return buildMpsFeasibilityAssessment(input);
  input = { ...input, asOf: input.asOf || businessNow() };
  const checks = Object.keys(DEFINITIONS).map((code) => {
    const entries = children.map((child) => ({ child, check: child.checks.find((c) => c.code === code) })).filter((e) => e.check);
    const status = worst(entries.map((e) => e.check));
    const representative = entries.find((e) => e.check.status === status)?.check;
    return check(code, { ...representative, status,
      missingFields: [...new Set(entries.flatMap((e) => e.check.missingFields || []))],
      evidence: entries.flatMap(({ child, check: c }) => (c.evidence || []).map((r) => ({ ...r, batchLabel: child.identity?.batchLabel, lineId: child.identity?.lineId }))),
      affectedEntities: entries.filter((e) => !["PASS", "NA"].includes(e.check.status)).map((e) => e.child.identity?.batchLabel),
      reason: `${representative?.reason || "Belum dinilai."} Ringkasan mengikuti batch yang paling terkendala.` }, iso(input.asOf));
  });
  // A root can contain different delivery targets; never suggest one date for all customer batches.
  return { ...result(input, checks, { customerDelivery: false, reviewPerBatch: true }), childSchedules: children.map((c) => ({ identity: c.identity, schedule: c.productionSchedule })) };
}

function deliverySuggestion(assessment, requests = []) {
  const schedule = assessment?.productionSchedule || {};
  const blocked = (reason) => ({ eligible: false, reason });
  if (Object.keys(DEFINITIONS).some((code) => !(assessment?.checks || []).some((c) => c.code === code))) return blocked("Tiga area checksheet produksi harus diperiksa terlebih dahulu.");
  if (!schedule.customerDelivery) return blocked(schedule.reviewPerBatch ? "Tinjau perubahan delivery pada batch terkait." : "Baris ini bukan delivery customer.");
  if ((assessment.checks || []).some((c) => c.status === "NOT_CHECKED" || c.missingFields?.length)) return blocked("Lengkapi data penilaian sebelum menyimpulkan recovery tidak memungkinkan.");
  const due = iso(schedule.requiredDeliveryAt), arrival = iso(schedule.projectedCustomerArrivalAt);
  if (!due || !arrival || arrival <= due) return blocked("Belum ada keterlambatan pada hasil jadwal terkini.");
  const problems = (assessment.checks || []).filter((c) => ["FAIL", "WARNING"].includes(c.status));
  if (!problems.length) return blocked("Tinjau penyebab keterlambatan jadwal terlebih dahulu.");
  const id = assessment.identity || {};
  const exhausted = problems.every((c) => requests.some((r) => r.mpsNumber === id.mpsNumber && r.mpsRevision === id.mpsRevision && r.lineId === id.lineId && r.checkpointCode === c.checkpointCode && r.feedbackStatus === "DONE" && r.history?.at(-1)?.recoveryOutcome === "NOT_FEASIBLE" && r.history.at(-1).evidenceReference && r.feedbackNotes));
  if (!exhausted) return blocked("Tuntaskan review recovery material, kapasitas, dan vendor yang masih bermasalah.");
  return { eligible: true, requestedDeliveryDate: due, suggestedDeliveryDate: arrival, reason: "Recovery pada seluruh kendala terkait dinyatakan tidak memungkinkan; ajukan review delivery ke Sales." };
}
module.exports = { VERSION, DEFINITIONS, buildMpsFeasibilityAssessment, aggregateMpsFeasibilityAssessments, summarizeMpsAssessments, deliverySuggestion };
