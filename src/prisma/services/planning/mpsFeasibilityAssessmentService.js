"use strict";

const { CHECK_STATUS, OVERALL_STATUS, STATUS_META, summarizeChecks, summarizeMpsAssessments } = require("./scheduleFeasibilityAggregator");
const { buildMpsCalculationBreakdown } = require("./mpsCalculationService");

const EPSILON = 0.000001;
const RULES_VERSION = "SCHEDULE_FEASIBILITY_V1";
const finite = (v) => v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v));
const n = (v) => finite(v) ? Number(v) : null;
const round = (v, digits = 3) => { if (!finite(v)) return null; const f = 10 ** digits; return Math.round((Number(v) + Number.EPSILON) * f) / f; };
const iso = (v) => { if (!v) return null; const d = v instanceof Date ? v : new Date(v); return Number.isNaN(d.getTime()) ? null : d.toISOString(); };
const minutesBetween = (later, earlier) => iso(later) && iso(earlier) ? Math.round((new Date(iso(later)) - new Date(iso(earlier))) / 60000) : null;
const measure = (v, unit = null, display = null) => ({ value: v === null || v === undefined ? null : round(v), display: display || (finite(v) ? `${round(v)}${unit ? ` ${unit}` : ""}` : "—"), unit });

const DEFINITIONS = Object.freeze({
  MASTER_DATA_READY: ["Kelengkapan Data", "Data & Demand", "Memastikan data wajib schedule tersedia sesuai make/buy dan tipe baris.", true],
  FG_COVERAGE_AT_DUE_DATE: ["Ketersediaan FG", "Inventory", "Menghitung projected usable FG pada tanggal kebutuhan.", true],
  MATERIAL_READY_BY_START: ["Kesiapan Material", "Material & Supply", "Memastikan hasil BOM explosion tersedia pada component need date.", true],
  FIRM_SUPPLY_ON_TIME: ["PO dan Supplier", "Material & Supply", "Memastikan receipt eksternal firm, cukup, dan usable sebelum dibutuhkan.", true],
  CAPACITY_AVAILABLE: ["Kapasitas Work Center", "Production Capacity", "Membandingkan required load dengan net available capacity.", true],
  RESOURCE_CALENDAR_AVAILABLE: ["Mesin, Tool, Manpower, Shift", "Production Capacity", "Memastikan resource routing tersedia pada slot produksi.", true],
  ROUTING_SEQUENCE_VALID: ["Urutan Operasi", "Production Schedule", "Memvalidasi predecessor, gap, dan overlap operasi.", true],
  LOT_BATCH_YIELD_VALID: ["Lot, Batch, Yield", "Production Schedule", "Memvalidasi kuantitas produksi terhadap lot, split, yield, dan scrap.", true],
  LEAD_TIME_AND_FINISH_FIT: ["Lead Time dan Planned Finish", "Time & Delivery", "Membandingkan projected customer arrival dengan required delivery.", true],
  QUALITY_RELEASE_READY: ["QC dan Stock Release", "Quality", "Memastikan stock dan output selesai QC sebelum dispatch.", true],
  DELIVERY_SLOT_AVAILABLE: ["Packing, Dispatch, Transport", "Time & Delivery", "Memastikan slot dispatch dan customer arrival memenuhi target.", true],
  BUFFER_POLICY_MET: ["Buffer Policy", "Data & Demand", "Memastikan target buffer terpenuhi setelah demand.", false],
});

function check(code, result, evaluatedAt) {
  const [label, group, description, critical] = DEFINITIONS[code];
  const status = result.status || CHECK_STATUS.NOT_CHECKED;
  return {
    code, id: code, label, group, description, critical: result.critical ?? critical,
    applicable: status !== CHECK_STATUS.NA, status, state: status,
    requirement: result.requirement || measure(null), actual: result.actual || measure(null), gap: result.gap || measure(null),
    unit: result.unit || result.gap?.unit || result.actual?.unit || null,
    reason: result.reason || "Belum tersedia hasil evaluasi.", missingFields: result.missingFields || [],
    evidence: result.evidence || [], affectedEntities: result.affectedEntities || [], recommendation: result.recommendation || null,
    actionCode: result.actionCode || null, evaluatedAt, passed: status === CHECK_STATUS.PASS,
    blocking: status === CHECK_STATUS.FAIL && (result.critical ?? critical),
  };
}
const na = (reason) => ({ status: CHECK_STATUS.NA, reason });
const unknown = (fields, reason) => ({ status: CHECK_STATUS.NOT_CHECKED, missingFields: fields.filter(Boolean), reason, recommendation: "Lengkapi sumber data lalu hitung ulang kelayakan." });
const materialRows = (input) => Array.isArray(input.materials?.components) ? input.materials.components : (input.snapshots || []).flatMap((s) => Array.isArray(s.assessmentDetail?.materialCoverage) ? s.assessmentDetail.materialCoverage : []);

function runRules(input = {}) {
  const rowType = String(input.rowType || "BATCH").toUpperCase();
  const isBuffer = rowType === "BUFFER";
  const mpsQty = Math.max(n(input.mpsQty) || 0, 0);
  const production = !isBuffer && mpsQty > EPSILON;
  const evaluatedAt = iso(input.asOf) || new Date().toISOString();
  const checks = [];
  const add = (code, result) => checks.push(check(code, result, evaluatedAt));

  const master = input.masterData || {};
  if (isBuffer) add("MASTER_DATA_READY", na("Baris buffer hanya dievaluasi terhadap kebijakan buffer."));
  else if ((master.missingFields || []).length || master.ready === false) add("MASTER_DATA_READY", unknown(master.missingFields || ["masterData"], `${(master.missingFields || []).length || 1} data wajib belum tersedia.`));
  else add("MASTER_DATA_READY", { status: CHECK_STATUS.PASS, requirement: measure(0, "field", "Semua data wajib tersedia"), actual: measure(0, "field", "Lengkap"), gap: measure(0, "field"), reason: "Data wajib yang berlaku tersedia.", evidence: master.evidence });

  const inv = input.inventory || {};
  if (isBuffer) add("FG_COVERAGE_AT_DUE_DATE", na("Tidak ada customer delivery pada baris buffer."));
  else {
    const absent = ["usableStockQty", "onTimeReceiptQty", "scheduledOutputByDue", "dueDemandQty"].filter((key) => !finite(inv[key]));
    if (absent.length) add("FG_COVERAGE_AT_DUE_DATE", unknown(absent.map((key) => `inventory.${key}`), "Projected FG pada due date belum dapat dihitung."));
    else {
      const projected = Number(inv.usableStockQty) + Number(inv.onTimeReceiptQty) + Number(inv.scheduledOutputByDue) - Number(inv.demandAllocatedBefore || 0) - Number(inv.dueDemandQty);
      const shortage = Math.max(-projected, 0);
      add("FG_COVERAGE_AT_DUE_DATE", { status: projected >= -EPSILON ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL,
        requirement: measure(inv.dueDemandQty, input.uomCode, `${round(inv.dueDemandQty)} ${input.uomCode || "unit"} due demand`),
        actual: { ...measure(projected, input.uomCode, `${round(projected)} projected FG`), onHandQty: n(inv.onHandQty), reservedQty: n(inv.reservedQty), allocatedQty: n(inv.allocatedQty), qcHoldQty: n(inv.qcHoldQty), blockedQty: n(inv.blockedQty), usableStockQty: n(inv.usableStockQty), onTimeReceiptQty: n(inv.onTimeReceiptQty), scheduledOutputByDue: n(inv.scheduledOutputByDue), dueDemandQty: n(inv.dueDemandQty), projectedFgAtDue: round(projected), shortageQty: round(shortage) },
        gap: measure(projected, input.uomCode), reason: projected >= -EPSILON ? "Usable stock dan supply on-time menutup demand." : `Projected FG kurang ${round(shortage)} ${input.uomCode || "unit"} pada due date.`, recommendation: shortage ? "Tambah produksi/supply sebelum due date atau reschedule delivery." : null, actionCode: shortage ? "COVER_FG_SHORTAGE" : null });
    }
  }

  const components = materialRows(input);
  if (!production || input.materials?.applicable === false) add("MATERIAL_READY_BY_START", na(!production ? "Tidak ada production requirement pada baris ini." : "Item tidak mempunyai component requirement."));
  else if (!components.length) add("MATERIAL_READY_BY_START", unknown(["effectiveBom", "componentCoverage"], "BOM/coverage component belum tersedia."));
  else {
    const missingCoverage = components.filter((r) => !finite(r.shortageQty ?? r.expectedShortageQty) && !finite(r.componentGapQty));
    const shortages = components.filter((r) => Number(r.shortageQty ?? r.expectedShortageQty ?? Math.max(-(n(r.componentGapQty) || 0), 0)) > EPSILON);
    const late = components.filter((r) => (n(r.lateDays ?? r.materialLateDays) || 0) > 0);
    const required = components.reduce((s, r) => s + (n(r.requiredComponentQty ?? r.qty) || 0), 0);
    const shortageQty = shortages.reduce((s, r) => s + (n(r.shortageQty ?? r.expectedShortageQty) || Math.max(-(n(r.componentGapQty) || 0), 0)), 0);
    const causesMiss = shortages.some((r) => r.causesDeliveryMiss !== false) || late.some((r) => r.causesDeliveryMiss === true);
    const status = missingCoverage.length ? CHECK_STATUS.NOT_CHECKED : shortages.length && causesMiss ? CHECK_STATUS.FAIL : shortages.length || late.length ? CHECK_STATUS.WARNING : CHECK_STATUS.PASS;
    add("MATERIAL_READY_BY_START", { status, missingFields: missingCoverage.length ? ["component.projectedAvailableAtNeedDate"] : [], requirement: measure(required, input.uomCode, `${components.length} component diperiksa`), actual: { ...measure(required - shortageQty, input.uomCode), materialCoveragePct: required > EPSILON ? round((required - shortageQty) / required * 100) : 100, shortageComponentCount: shortages.length, criticalComponentCount: late.length || shortages.length, materialReadyAt: input.materials?.materialReadyAt || null, maxMaterialLateDays: Math.max(0, ...components.map((r) => n(r.lateDays ?? r.materialLateDays) || 0)), shortageQty: round(shortageQty), topShortageComponents: shortages.slice(0, 5) }, gap: measure(-shortageQty, input.uomCode), reason: status === CHECK_STATUS.PASS ? "Seluruh component tersedia saat dibutuhkan." : status === CHECK_STATUS.WARNING ? "Material memerlukan percepatan tetapi masih dapat diserap slack schedule." : status === CHECK_STATUS.FAIL ? "Shortage/keterlambatan material melewati batas delivery." : "Sebagian projected coverage component belum tersedia.", evidence: components.slice(0, 20), affectedEntities: shortages.map((r) => r.partCode || r.componentCode).filter(Boolean), recommendation: status !== CHECK_STATUS.PASS ? "Expedite receipt atau sesuaikan urutan produksi berdasarkan material ready date." : null, actionCode: status === CHECK_STATUS.FAIL ? "EXPEDITE_MATERIAL" : null });
  }

  const supply = input.firmSupply || {};
  if (!production || supply.applicable === false || supply.externalDependent === false) add("FIRM_SUPPLY_ON_TIME", na(!production ? "Tidak ada production requirement." : "Schedule tidak bergantung pada receipt eksternal."));
  else if (!supply.externalDependent) add("FIRM_SUPPLY_ON_TIME", unknown(["firmSupply.externalDependent"], "Ketergantungan external receipt belum diketahui."));
  else {
    const absent = ["firmReceiptQty", "onTimeFirmReceiptQty", "lateReceiptQty", "unconfirmedReceiptQty"].filter((key) => !finite(supply[key]));
    const lateQty = n(supply.lateReceiptQty) || 0; const unconfirmed = n(supply.unconfirmedReceiptQty) || 0;
    const status = absent.length ? CHECK_STATUS.NOT_CHECKED : lateQty > EPSILON || supply.causesDeliveryMiss ? CHECK_STATUS.FAIL : unconfirmed > EPSILON ? CHECK_STATUS.WARNING : CHECK_STATUS.PASS;
    add("FIRM_SUPPLY_ON_TIME", { status, missingFields: absent.map((key) => `firmSupply.${key}`), requirement: measure(supply.requiredReceiptQty ?? supply.firmReceiptQty, input.uomCode), actual: { ...measure(supply.onTimeFirmReceiptQty, input.uomCode), firmReceiptQty: n(supply.firmReceiptQty), onTimeFirmReceiptQty: n(supply.onTimeFirmReceiptQty), lateReceiptQty: lateQty, unconfirmedReceiptQty: unconfirmed, nextReceiptAt: supply.nextReceiptAt || null, supplierLateDays: n(supply.supplierLateDays) }, gap: measure((n(supply.onTimeFirmReceiptQty) || 0) - (n(supply.requiredReceiptQty ?? supply.firmReceiptQty) || 0), input.uomCode), reason: status === CHECK_STATUS.PASS ? "Dependent receipt firm dan on-time." : status === CHECK_STATUS.WARNING ? "Ada receipt belum confirmed, tetapi masih dalam slack." : status === CHECK_STATUS.FAIL ? "Receipt terlambat/kurang menyebabkan delivery miss." : "Confirmation atau ETA receipt belum lengkap.", evidence: supply.evidence, affectedEntities: supply.affectedPoNumbers, recommendation: status !== CHECK_STATUS.PASS ? "Konfirmasi ETA dan expedite PO/subcontract/transfer terkait." : null, actionCode: status === CHECK_STATUS.FAIL ? "EXPEDITE_SUPPLY" : null });
  }

  const cap = input.capacity || {};
  if (!production) add("CAPACITY_AVAILABLE", na("MPS Qty 0; tidak ada load produksi."));
  else if (!finite(cap.requiredCapacityHours) || !finite(cap.netAvailableCapacityHours)) add("CAPACITY_AVAILABLE", unknown([!finite(cap.requiredCapacityHours) ? "capacity.requiredCapacityHours" : null, !finite(cap.netAvailableCapacityHours) ? "capacity.netAvailableCapacityHours" : null], "RCCP/calendar belum menyediakan required dan net available hours."));
  else {
    const required = Number(cap.requiredCapacityHours); const available = Number(cap.netAvailableCapacityHours); const gap = available - required; const utilization = available > EPSILON ? required / available * 100 : required > EPSILON ? 999999 : 0; const warningAt = n(cap.warningThreshold) ?? 90;
    const status = gap < -EPSILON || utilization > 100 + EPSILON ? CHECK_STATUS.FAIL : utilization >= warningAt - EPSILON ? CHECK_STATUS.WARNING : CHECK_STATUS.PASS;
    add("CAPACITY_AVAILABLE", { status, requirement: measure(available, "hour", `${round(available)} jam tersedia`), actual: { ...measure(required, "hour", `${round(required)} jam dibutuhkan`), requiredCapacityHours: round(required), netAvailableCapacityHours: round(available), capacityGapHours: round(gap), utilizationPct: round(utilization), bottleneckWorkCenterId: cap.bottleneckWorkCenterId || null, bottleneckWorkCenterName: cap.bottleneckWorkCenterName || null, earliestAvailableSlot: cap.earliestAvailableSlot || null, affectedTimeBucket: cap.affectedTimeBucket || null }, gap: measure(gap, "hour"), reason: status === CHECK_STATUS.FAIL ? "Load melebihi net available capacity sebelum latest finish." : status === CHECK_STATUS.WARNING ? "Schedule masih muat, tetapi utilization berada pada zona risiko." : "Kapasitas tersedia sebelum latest finish.", evidence: cap.evidence, affectedEntities: [cap.bottleneckWorkCenterId || cap.bottleneckWorkCenterName].filter(Boolean), recommendation: status === CHECK_STATUS.FAIL ? "Evaluasi overtime, alternate work center, subcontract, atau reschedule." : null, actionCode: status === CHECK_STATUS.FAIL ? "ADD_CAPACITY" : null });
  }

  const res = input.resources || {};
  if (!production || res.applicable === false) add("RESOURCE_CALENDAR_AVAILABLE", na(!production ? "Tidak ada load produksi." : "Routing tidak memakai resource detail."));
  else if (!res.evaluated) add("RESOURCE_CALENDAR_AVAILABLE", unknown(res.missingFields || ["resourceRequirements", "resourceCalendar"], "Availability mesin, tool, manpower, dan shift belum tersedia."));
  else {
    const conflicts = n(res.conflictingResourceCount) || 0; const missingCount = n(res.missingResourceCount) || 0; const alternatives = n(res.alternateResourceCount) || 0;
    const status = missingCount + conflicts > 0 ? alternatives > 0 ? CHECK_STATUS.WARNING : CHECK_STATUS.FAIL : CHECK_STATUS.PASS;
    add("RESOURCE_CALENDAR_AVAILABLE", { status, requirement: measure(0, "resource", "0 konflik resource"), actual: { ...measure(missingCount + conflicts, "resource"), missingResourceCount: missingCount, conflictingResourceCount: conflicts, alternateResourceCount: alternatives, firstAvailableResourceAt: res.firstAvailableResourceAt || null, affectedResourceNames: res.affectedResourceNames || [] }, gap: measure(-(missingCount + conflicts), "resource"), reason: status === CHECK_STATUS.PASS ? "Seluruh required resource tersedia." : status === CHECK_STATUS.WARNING ? "Ada konflik, tetapi alternate resource valid tersedia." : "Tidak ada valid resource slot sebelum latest finish.", affectedEntities: res.affectedResourceNames, recommendation: status !== CHECK_STATUS.PASS ? "Pilih alternate resource atau reschedule slot operasi." : null });
  }

  const route = input.routing || {};
  if (!production || route.applicable === false) add("ROUTING_SEQUENCE_VALID", na(!production ? "Tidak ada operasi produksi." : "Item tidak mempunyai routing operation."));
  else if (!route.evaluated) add("ROUTING_SEQUENCE_VALID", unknown(route.missingFields || ["operationSchedule"], "Operation schedule belum tersedia untuk validasi urutan."));
  else {
    const invalid = n(route.invalidSequenceCount) || 0; const overlaps = n(route.overlapCount) || 0; const requiredGap = n(route.minimumRequiredGapMinutes) || 0; const actualGap = n(route.minimumActualGapMinutes);
    const status = invalid + overlaps > 0 || (actualGap !== null && actualGap < requiredGap) ? CHECK_STATUS.FAIL : actualGap !== null && actualGap < (n(route.warningGapMinutes) || requiredGap) ? CHECK_STATUS.WARNING : CHECK_STATUS.PASS;
    add("ROUTING_SEQUENCE_VALID", { status, requirement: measure(requiredGap, "minute"), actual: { ...measure(actualGap, "minute"), invalidSequenceCount: invalid, overlapCount: overlaps, minimumRequiredGapMinutes: requiredGap, minimumActualGapMinutes: actualGap, affectedOperationIds: route.affectedOperationIds || [] }, gap: measure(actualGap === null ? null : actualGap - requiredGap, "minute"), reason: status === CHECK_STATUS.FAIL ? "Terdapat overlap atau urutan operasi yang tidak valid." : status === CHECK_STATUS.WARNING ? "Urutan valid dengan slack operasi kecil." : "Urutan dan dependency operasi valid.", affectedEntities: route.affectedOperationIds, recommendation: status === CHECK_STATUS.FAIL ? "Susun ulang operation slot sesuai predecessor dan transfer/wait time." : null });
  }

  const lot = input.lot || {};
  if (!production || lot.applicable === false) add("LOT_BATCH_YIELD_VALID", na(!production ? "MPS Qty 0; lot/batch tidak berlaku." : "Lot/yield constraint tidak diterapkan."));
  else if (!lot.evaluated) add("LOT_BATCH_YIELD_VALID", unknown(lot.missingFields || ["lotPolicy", "yield"], "Lot, order multiple, atau yield wajib belum tersedia."));
  else {
    const delta = (n(lot.roundedMpsQty) ?? mpsQty) - mpsQty; const status = lot.valid === false && lot.deliverable === false ? CHECK_STATUS.FAIL : Math.abs(delta) > EPSILON || lot.requiresSplit ? CHECK_STATUS.WARNING : CHECK_STATUS.PASS;
    add("LOT_BATCH_YIELD_VALID", { status, requirement: measure(mpsQty, input.uomCode), actual: { ...measure(lot.roundedMpsQty ?? mpsQty, input.uomCode), requestedMpsQty: mpsQty, roundedMpsQty: n(lot.roundedMpsQty) ?? mpsQty, minimumLotQty: n(lot.minimumLotQty), maximumLotQty: n(lot.maximumLotQty), orderMultipleQty: n(lot.orderMultipleQty), plannedBatchCount: n(lot.plannedBatchCount), expectedGoodQty: n(lot.expectedGoodQty), lotRoundingDeltaQty: round(delta) }, gap: measure(delta, input.uomCode), reason: status === CHECK_STATUS.FAIL ? "Qty tidak dapat dibentuk menjadi batch valid sebelum due date." : status === CHECK_STATUS.WARNING ? "Qty memerlukan rounding atau batch split." : "MPS Qty valid terhadap lot dan yield.", recommendation: status !== CHECK_STATUS.PASS ? "Tinjau rounding, split batch, dan yield sebelum release." : null });
  }

  const schedule = input.schedule || {};
  if (!production) add("LEAD_TIME_AND_FINISH_FIT", na("Tidak ada production lead time untuk MPS Qty 0."));
  else {
    const due = schedule.requiredDeliveryAt || input.requiredDeliveryAt; const arrival = schedule.projectedCustomerArrivalAt || schedule.earliestFeasibleDeliveryAt;
    if (!due || !arrival) add("LEAD_TIME_AND_FINISH_FIT", unknown([!due ? "requiredDeliveryAt" : null, !arrival ? "projectedCustomerArrivalAt" : null], "Tanggal/duration utama belum tersedia."));
    else {
      const slack = minutesBetween(due, arrival); const warning = n(schedule.warningSlackMinutes) ?? 1440; const late = Math.max(-(slack || 0), 0); const status = slack < 0 ? CHECK_STATUS.FAIL : slack <= warning ? CHECK_STATUS.WARNING : CHECK_STATUS.PASS;
      add("LEAD_TIME_AND_FINISH_FIT", { status, requirement: measure(null, null, iso(due)), actual: { value: iso(arrival), display: iso(arrival), unit: "datetime", plannedStartAt: iso(schedule.plannedStartAt), plannedFinishAt: iso(schedule.plannedFinishAt), projectedProductionFinishAt: iso(schedule.projectedProductionFinishAt || schedule.plannedFinishAt), projectedCustomerArrivalAt: iso(arrival), requiredDeliveryAt: iso(due), slackMinutes: slack, lateByMinutes: late, lateByWorkingDays: n(schedule.lateByWorkingDays), earliestFeasibleDeliveryAt: iso(schedule.earliestFeasibleDeliveryAt || arrival) }, gap: measure(slack, "minute"), reason: status === CHECK_STATUS.FAIL ? `Projected arrival terlambat ${round(late / 60)} jam; working-day equivalent menunggu calendar result.` : status === CHECK_STATUS.WARNING ? "Arrival masih on-time dengan slack kecil." : "Projected customer arrival memenuhi target.", recommendation: status === CHECK_STATUS.FAIL ? "Majukan material/production slot atau reschedule komitmen delivery." : null });
    }
  }

  const quality = input.quality || {};
  if (isBuffer || quality.applicable === false) add("QUALITY_RELEASE_READY", na(isBuffer ? "Buffer stock tidak memiliki customer release event." : "QC tidak diwajibkan untuk item/transaksi ini."));
  else if (!quality.evaluated) add("QUALITY_RELEASE_READY", unknown(quality.missingFields || ["inspectionPlan", "expectedInspectionDuration"], "Status release atau durasi inspeksi belum tersedia."));
  else { const delay = n(quality.qcDelayMinutes) || 0; const status = quality.causesDeliveryMiss ? CHECK_STATUS.FAIL : delay > 0 ? CHECK_STATUS.WARNING : CHECK_STATUS.PASS; add("QUALITY_RELEASE_READY", { status, requirement: measure(null, null, iso(quality.latestAllowedReleaseAt)), actual: { value: iso(quality.expectedReleaseAt), display: iso(quality.expectedReleaseAt), unit: "datetime", qcHoldQty: n(quality.qcHoldQty), expectedReleaseAt: iso(quality.expectedReleaseAt), latestAllowedReleaseAt: iso(quality.latestAllowedReleaseAt), qcDelayMinutes: delay, affectedInspectionIds: quality.affectedInspectionIds || [] }, gap: measure(-delay, "minute"), reason: status === CHECK_STATUS.FAIL ? "QC/release menyebabkan customer arrival terlambat." : status === CHECK_STATUS.WARNING ? "QC release masih on-time dengan buffer kecil." : "Quantity yang dipakai akan released tepat waktu.", affectedEntities: quality.affectedInspectionIds, recommendation: status !== CHECK_STATUS.PASS ? "Prioritaskan inspeksi dan release lot terkait." : null }); }

  const delivery = input.delivery || {};
  if (isBuffer || delivery.applicable === false) add("DELIVERY_SLOT_AVAILABLE", na(isBuffer ? "Buffer stock tidak mempunyai customer delivery." : "Delivery dikelola di luar scope aplikasi."));
  else if (!delivery.evaluated) add("DELIVERY_SLOT_AVAILABLE", unknown(delivery.missingFields || ["dispatchSlot", "transitDuration", "deliveryCalendar"], "Slot dispatch/transit belum dapat dievaluasi."));
  else { const due = delivery.requiredDeliveryAt || input.requiredDeliveryAt; const arrival = delivery.projectedCustomerArrivalAt; const slack = minutesBetween(due, arrival); const status = delivery.slotAvailable === false || (slack !== null && slack < 0) ? CHECK_STATUS.FAIL : slack !== null && slack <= (n(delivery.warningSlackMinutes) ?? 1440) ? CHECK_STATUS.WARNING : CHECK_STATUS.PASS; add("DELIVERY_SLOT_AVAILABLE", { status, requirement: measure(null, null, iso(due)), actual: { value: iso(arrival), display: iso(arrival), unit: "datetime", packingFinishAt: iso(delivery.packingFinishAt), dispatchAt: iso(delivery.dispatchAt), projectedCustomerArrivalAt: iso(arrival), transitMinutes: n(delivery.transitMinutes), slotAvailable: delivery.slotAvailable, carrierOrVehicle: delivery.carrierOrVehicle || null }, gap: measure(slack, "minute"), reason: status === CHECK_STATUS.FAIL ? "Slot/arrival tidak memenuhi required delivery." : status === CHECK_STATUS.WARNING ? "Delivery masih on-time dengan margin kecil." : "Slot dan projected arrival memenuhi target.", evidence: delivery.evidence, recommendation: status === CHECK_STATUS.FAIL ? "Booking slot/carrier lebih awal atau reschedule delivery." : null }); }

  const buffer = input.buffer || {};
  if (buffer.applicable === false || (!isBuffer && !finite(buffer.targetQty))) add("BUFFER_POLICY_MET", na("Buffer policy tidak diterapkan pada baris ini."));
  else if (!finite(buffer.targetQty) || !finite(buffer.projectedEndingQty)) add("BUFFER_POLICY_MET", unknown([!finite(buffer.targetQty) ? "buffer.targetQty" : null, !finite(buffer.projectedEndingQty) ? "buffer.projectedEndingQty" : null], "Target atau projected ending buffer belum tersedia."));
  else { const gap = Number(buffer.projectedEndingQty) - Number(buffer.targetQty); const ratio = Number(buffer.targetQty) > EPSILON ? Number(buffer.projectedEndingQty) / Number(buffer.targetQty) : 1; const status = gap >= -EPSILON ? CHECK_STATUS.PASS : CHECK_STATUS.WARNING; add("BUFFER_POLICY_MET", { status, requirement: measure(buffer.targetQty, input.uomCode), actual: { ...measure(buffer.projectedEndingQty, input.uomCode), targetBufferQty: n(buffer.targetQty), projectedEndingQty: n(buffer.projectedEndingQty), bufferCoveragePct: Number(buffer.targetQty) > EPSILON ? round(ratio * 100) : 100 }, gap: measure(gap, input.uomCode), reason: status === CHECK_STATUS.PASS ? "Projected ending stock memenuhi buffer policy." : "Demand utama masih dapat dipenuhi, tetapi target buffer belum penuh.", recommendation: status === CHECK_STATUS.WARNING ? "Tambah buffer production bila kapasitas dan material memungkinkan." : null }); }
  return checks;
}

function buildMpsFeasibilityAssessment(input = {}) {
  const evaluatedAt = iso(input.asOf) || new Date().toISOString();
  const checks = runRules({ ...input, asOf: evaluatedAt });
  const calculation = input.mpsCalculation || buildMpsCalculationBreakdown(input);
  const snapshotDates = (input.snapshots || []).map((r) => r.assessmentDetail?.earliestFeasibleDeliveryDate).filter(Boolean).sort();
  const summary = summarizeChecks(checks, { evaluatedAt, sourceDataAsOf: iso(input.sourceDataAsOf) || evaluatedAt, rulesVersion: RULES_VERSION, formulaVersion: calculation.formulaVersion, earliestFeasibleDeliveryAt: iso(input.schedule?.earliestFeasibleDeliveryAt || snapshotDates.at(-1)) || null, lateByWorkingDays: input.schedule?.lateByWorkingDays });
  return { identity: input.identity || {}, mpsCalculation: calculation, summary, checklistSummary: summary, checks, checklist: checks, ...summary };
}

function aggregateMpsFeasibilityAssessments(assessments = [], input = {}) {
  const children = assessments.filter(Boolean); if (!children.length) return buildMpsFeasibilityAssessment(input);
  const evaluatedAt = iso(input.asOf) || new Date().toISOString();
  const checks = Object.keys(DEFINITIONS).map((code) => {
    const childChecks = children.map((child) => (child.checks || child.checklist || []).find((row) => row.code === code)).filter(Boolean);
    const applicable = childChecks.filter((row) => row.status !== CHECK_STATUS.NA);
    if (!applicable.length) return check(code, na("Parameter tidak berlaku pada seluruh child batch."), evaluatedAt);
    const status = applicable.some((row) => row.status === CHECK_STATUS.FAIL) ? CHECK_STATUS.FAIL : applicable.some((row) => row.status === CHECK_STATUS.NOT_CHECKED) ? CHECK_STATUS.NOT_CHECKED : applicable.some((row) => row.status === CHECK_STATUS.WARNING) ? CHECK_STATUS.WARNING : CHECK_STATUS.PASS;
    const affected = applicable.filter((row) => row.status !== CHECK_STATUS.PASS).flatMap((row) => row.affectedEntities || []).filter(Boolean);
    const affectedBatches = children.filter((child) => {
      const childCheck = (child.checks || child.checklist || []).find((row) => row.code === code);
      return childCheck && childCheck.status !== CHECK_STATUS.PASS && childCheck.status !== CHECK_STATUS.NA;
    }).map((child) => child.identity?.batchLabel || child.identity?.batchId).filter(Boolean);
    const representative = applicable.find((row) => row.status === status) || applicable[0];
    return check(code, { ...representative, status, reason: status === CHECK_STATUS.PASS ? `Lolos pada ${applicable.length} child batch.` : `${applicable.filter((row) => row.status === status).length} child batch berstatus ${status}. ${representative.reason}`, affectedEntities: [...new Set([...affectedBatches, ...affected])] }, evaluatedAt);
  });
  const latest = children.map((row) => row.summary?.earliestFeasibleDeliveryAt).filter(Boolean).sort().at(-1) || null;
  const childLateDays = children.map((row) => n(row.summary?.lateByWorkingDays)).filter((value) => value !== null);
  const summary = summarizeChecks(checks, { evaluatedAt, sourceDataAsOf: evaluatedAt, rulesVersion: RULES_VERSION, formulaVersion: input.mpsCalculation?.formulaVersion, earliestFeasibleDeliveryAt: latest, lateByWorkingDays: childLateDays.length ? Math.max(...childLateDays) : null });
  return { identity: input.identity || {}, mpsCalculation: input.mpsCalculation || null, summary, checklistSummary: summary, checks, checklist: checks, ...summary };
}

function capacityPlan(capacity = {}) { const available = n(capacity.netAvailableCapacityHours); const load = n(capacity.maxLoadPercentage); return { ...capacity, warningThreshold: n(capacity.warningThreshold) ?? 90, overloadThreshold: n(capacity.overloadThreshold) ?? 100, netAvailableCapacityHours: available, requiredCapacityHours: n(capacity.requiredCapacityHours) ?? (available !== null && load !== null ? round(available * load / 100) : null) }; }
function scheduleSlackDays(snapshots = []) { const values = snapshots.map((r) => minutesBetween(r.effectiveCommitmentDate || r.originalTargetDate, r.assessmentDetail?.earliestFeasibleDeliveryDate)).filter((v) => v !== null); return values.length ? Math.min(...values) / 1440 : null; }

module.exports = { CHECK_STATUS, OVERALL_STATUS, STATUS_META, RULES_VERSION, DEFINITIONS, runRules, buildMpsFeasibilityAssessment, aggregateMpsFeasibilityAssessments, summarizeMpsAssessments, scheduleSlackDays, capacityPlan };
