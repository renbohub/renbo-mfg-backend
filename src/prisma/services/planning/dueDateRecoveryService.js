"use strict";

const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const asDate = (value) => {
  const parsed = value instanceof Date ? new Date(value) : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};
const dateKey = (value) => asDate(value)?.toISOString().slice(0, 10) || null;

function calendarGapDays(from, to) {
  const start = asDate(from);
  const finish = asDate(to);
  if (!start || !finish) return 0;
  return Math.max(Math.ceil((finish.getTime() - start.getTime()) / 86400000), 0);
}

function action({ id, category, title, reason, ownerRole, targetDate, required = true, expectedRecoveryDays = 0, verification, evidence = {} }) {
  return {
    id,
    category,
    title,
    reason,
    ownerRole,
    targetDate: dateKey(targetDate),
    required,
    selected: required,
    expectedRecoveryDays: Math.max(number(expectedRecoveryDays), 0),
    verification,
    evidence,
  };
}

/**
 * Turns an explainable feasibility snapshot into execution controls. These are
 * proposed countermeasures, not promises that the customer date has changed.
 */
function buildDueDateRecoveryChecklist(feasibility = {}, options = {}) {
  const details = feasibility.constraintDetails || {};
  const calculation = details.earliestFgCalculation || {};
  const materialRows = details.materialCoverage || [];
  const shortages = materialRows.filter((row) => number(row.shortageQty) > 0.000001);
  const blockers = details.capacityBlockers || [];
  const requestedDeliveryDate = feasibility.requestedDeliveryDate || options.requestedDeliveryDate;
  const fgRequiredDate = feasibility.fgRequiredDate;
  const earliestDeliveryDate = feasibility.earliestFeasibleDeliveryDate;
  const gapDays = calendarGapDays(requestedDeliveryDate, earliestDeliveryDate);
  const today = options.today || feasibility.simulatedAt || new Date();
  const actions = [];

  if ((feasibility.waivedRisks || details.waivedRisks || []).length) {
    const waivedRisks = feasibility.waivedRisks || details.waivedRisks;
    actions.push(action({
      id: "APPROVE_RISK_WAIVER",
      category: "GOVERNANCE",
      title: "Approve asumsi risiko yang dikecualikan",
      reason: `${waivedRisks.map((row) => row.label || row.code).join(", ")} diubah dari asumsi master pada kalkulasi tanggal. Produksi dan vendor dependency tetap wajib dihitung.`,
      ownerRole: "PPIC",
      targetDate: today,
      expectedRecoveryDays: 0,
      verification: "PPIC menyetujui asumsi, mencatat mitigasi, dan melampirkan bukti komitmen dari fungsi terkait.",
      evidence: { waivedRisks },
    }));
  }

  if (feasibility.status === "MASTER_DATA_INCOMPLETE") {
    actions.push(action({
      id: "COMPLETE_MASTER_DATA",
      category: "MASTER_DATA",
      title: "Lengkapi routing, cycle time, supplier, dan lead time",
      reason: "Feasibility belum dapat dipercaya sebelum master data kritis lengkap.",
      ownerRole: "PPIC / Engineering / Purchasing",
      targetDate: today,
      expectedRecoveryDays: 0,
      verification: "Jalankan ulang feasibility dan pastikan status bukan MASTER_DATA_INCOMPLETE.",
      evidence: { bomNumber: details.bomNumber || null },
    }));
  }

  if (shortages.length || ["SUPPLIER_LEAD_TIME", "MATERIAL_SHORTAGE"].includes(feasibility.criticalConstraint)) {
    const purchasing = calculation.procurementLeadTimeBreakdown || details.procurementLeadTimeBreakdown || {};
    actions.push(action({
      id: "RELEASE_PR_PO",
      category: "MATERIAL",
      title: "Release PR/PO sesuai latest release date",
      reason: `${shortages.length || materialRows.length} material perlu diamankan sebelum produksi dimulai.`,
      ownerRole: "Purchasing",
      targetDate: feasibility.latestPrDate && asDate(feasibility.latestPrDate) > asDate(today) ? feasibility.latestPrDate : today,
      expectedRecoveryDays: Math.min(gapDays, number(purchasing.prApprovalDays) + number(purchasing.poProcessingDays)),
      verification: "Nomor PR/PO dan required arrival supplier tercatat untuk seluruh material kritis.",
      evidence: { latestPrDate: dateKey(feasibility.latestPrDate), materials: (shortages.length ? shortages : materialRows).map((row) => ({ partCode: row.partCode, shortageQty: number(row.shortageQty), supplierCode: row.supplierCode, requiredDate: dateKey(row.requiredDate), latestPrDate: dateKey(row.latestPrDate) })) },
    }));
    actions.push(action({
      id: "SUPPLIER_COMMITMENT",
      category: "SUPPLIER",
      title: "Dapatkan komitmen tanggal kirim supplier",
      reason: "Lead time hanya dapat diproteksi bila supplier mengonfirmasi arrival sebelum material required date.",
      ownerRole: "Purchasing",
      targetDate: today,
      expectedRecoveryDays: Math.min(gapDays, number(purchasing.safetyLeadTimeDays) + number(purchasing.transitDays)),
      verification: "Lampirkan konfirmasi supplier; committed arrival tidak melewati material required date.",
      evidence: { materialRequiredDate: dateKey(feasibility.materialRequiredDate), supplierRequiredArrivalDate: dateKey(feasibility.supplierRequiredArrivalDate) },
    }));
  } else if (materialRows.length) {
    actions.push(action({
      id: "RESERVE_MATERIAL",
      category: "MATERIAL",
      title: "Reserve stok dan open supply untuk demand ini",
      reason: "Coverage tersedia tetapi harus diproteksi agar tidak dikonsumsi demand lain.",
      ownerRole: "PPIC / Warehouse",
      targetDate: feasibility.materialRequiredDate || today,
      expectedRecoveryDays: 0,
      verification: "Reservation/pegging mencakup seluruh quantity sampai tanggal material required.",
      evidence: { materials: materialRows.map((row) => ({ partCode: row.partCode, requiredQty: number(row.qty), openingQty: number(row.openingQty), eligibleSupplyQty: number(row.eligibleSupplyQty) })) },
    }));
  }

  if (feasibility.capacityStatus === "CAPACITY_LATE" || blockers.length) {
    actions.push(action({
      id: "RECOVER_CAPACITY",
      category: "CAPACITY",
      title: "Kunci slot capacity sebelum latest process start",
      reason: "Finite capacity belum mempunyai slot yang cukup sebelum FG required date.",
      ownerRole: "PPIC / Production",
      targetDate: feasibility.productionLatestStartDate || today,
      expectedRecoveryDays: gapDays,
      verification: "Simulation ulang menunjukkan tidak ada blocker dan completion tidak melewati FG required date.",
      evidence: { productionLatestStartDate: dateKey(feasibility.productionLatestStartDate), blockerCodes: blockers.map((row) => row.code || row.type).filter(Boolean) },
    }));
  } else if (feasibility.capacityStatus === "NOT_SIMULATED") {
    actions.push(action({
      id: "RUN_CAPACITY_SIMULATION",
      category: "CAPACITY",
      title: "Jalankan finite capacity simulation",
      reason: "Due date belum aman sebelum ketersediaan mesin, dies, shift, downtime, dan dependency divalidasi.",
      ownerRole: "PPIC",
      targetDate: today,
      expectedRecoveryDays: 0,
      verification: "Simulation tersimpan dan menghasilkan completion date serta daftar blocker authoritative.",
      evidence: {},
    }));
  } else {
    actions.push(action({
      id: "LOCK_CAPACITY_SLOT",
      category: "CAPACITY",
      title: "Lock allocation sesuai backward due date",
      reason: "Slot feasible perlu diproteksi dari displacement demand dengan prioritas lebih rendah.",
      ownerRole: "PPIC",
      targetDate: feasibility.productionLatestStartDate || today,
      expectedRecoveryDays: 0,
      verification: "MPP/capacity allocation membawa delivery phase, FG required date, dan priority yang sama.",
      evidence: { productionLatestStartDate: dateKey(feasibility.productionLatestStartDate) },
    }));
  }

  const hasVendor = Boolean(feasibility.vendorSendDate || feasibility.vendorReturnDate || (details.processTimeline || []).some((row) => row.routingMode === "VENDOR"));
  if (hasVendor) {
    actions.push(action({
      id: "VENDOR_SLOT_COMMITMENT",
      category: "VENDOR",
      title: "Konfirmasi slot kirim dan kembali vendor process",
      reason: "Vendor operation adalah dependency route dan tidak boleh diasumsikan selalu tersedia.",
      ownerRole: "PPIC / Purchasing",
      targetDate: feasibility.vendorSendDate || today,
      expectedRecoveryDays: 0,
      verification: "Vendor send/return date dikonfirmasi dan return tidak melewati successor start.",
      evidence: { vendorSendDate: dateKey(feasibility.vendorSendDate), vendorReturnDate: dateKey(feasibility.vendorReturnDate) },
    }));
  }

  // Optional PPIC recovery levers. These remain explicit audit decisions: no
  // lead-time master or production date is silently rewritten by a recovery
  // plan. The selected option, owner, target date, evidence and approval are
  // stored on the versioned DueDateRecoveryPlan.
  actions.push(action({
    id: "REDUCE_SUPPLIER_LEAD_TIME",
    category: "SUPPLIER",
    title: "Kurangi lead time supplier untuk recovery",
    reason: "Gunakan committed lead time hasil negosiasi supplier khusus delivery phase ini.",
    ownerRole: "Purchasing",
    targetDate: feasibility.materialRequiredDate || today,
    required: false,
    verification: "Konfirmasi supplier dan committed arrival date wajib dilampirkan; master lead time tidak berubah otomatis.",
  }));
  actions.push(action({
    id: "RUN_TRIAL_RECOVERY",
    category: "TRIAL",
    title: "Jalankan trial recovery",
    reason: "Validasi percepatan material atau proses dalam mode trial sebelum dijadikan komitmen resmi.",
    ownerRole: "PPIC / Production / Purchasing",
    targetDate: today,
    required: false,
    verification: "Hasil trial, asumsi, dan dampak delivery phase dicatat sebelum approval.",
  }));
  actions.push(action({
    id: "SHIFT_PRODUCTION_START",
    category: "PRODUCTION",
    title: "Geser start production",
    reason: "Start production diubah sebagai recovery dan tidak boleh mengubah customer due date tanpa approval.",
    ownerRole: "PPIC / Production",
    targetDate: feasibility.productionLatestStartDate || today,
    required: false,
    verification: "Tanggal start baru, resource terdampak, dan alasan pergeseran tercatat pada Production Plan.",
  }));
  actions.push(action({
    id: "REDUCE_VENDOR_LEAD_TIME",
    category: "VENDOR",
    title: "Kurangi lead time vendor process",
    reason: "Gunakan committed vendor turnaround khusus recovery tanpa mengubah master lead time permanen.",
    ownerRole: "PPIC / Purchasing",
    targetDate: feasibility.vendorReturnDate || feasibility.productionLatestStartDate || today,
    required: false,
    verification: "Vendor send/return baru dikonfirmasi dan tidak melewati successor process start.",
  }));
  actions.push(action({
    id: "FORCE_WITH_REASON",
    category: "GOVERNANCE",
    title: "Force dengan alasan khusus",
    reason: "Override hanya untuk keputusan berotorisasi ketika recovery standar tidak mencukupi.",
    ownerRole: "PPIC Approver",
    targetDate: today,
    required: false,
    verification: "Alasan khusus, risiko, pemilik risiko, dan bukti approval wajib lengkap.",
  }));
  if (feasibility.status === "NOT_FEASIBLE" && gapDays > 0) {
    actions.push(action({
      id: "ACCEPT_LATE",
      category: "GOVERNANCE",
      title: "Accept Late",
      reason: "Keterlambatan diterima dengan tanggal komitmen baru dan persetujuan formal.",
      ownerRole: "PPIC Approver",
      targetDate: earliestDeliveryDate,
      required: false,
      verification: "Alasan, tanggal baru, dampak delivery phase, dan approval wajib tersimpan.",
    }));
  }

  actions.push(action({
    id: "DAILY_CONTROL",
    category: "CONTROL",
    title: "Monitor milestone dan eskalasi deviasi setiap hari",
    reason: "Recovery plan gagal bila PR, material arrival, process completion, atau dispatch meleset tanpa eskalasi.",
    ownerRole: "PPIC",
    targetDate: fgRequiredDate || requestedDeliveryDate,
    expectedRecoveryDays: 0,
    verification: "Actual milestone diperbarui; setiap deviasi mempunyai owner dan corrective action.",
    evidence: { fgRequiredDate: dateKey(fgRequiredDate), requestedDeliveryDate: dateKey(requestedDeliveryDate) },
  }));

  return {
    method: "DUE_DATE_RECOVERY_V1",
    status: feasibility.status,
    criticalConstraint: feasibility.criticalConstraint || null,
    requestedDeliveryDate: dateKey(requestedDeliveryDate),
    fgRequiredDate: dateKey(fgRequiredDate),
    earliestFeasibleFgDate: dateKey(feasibility.earliestFeasibleFgDate),
    earliestFeasibleDeliveryDate: dateKey(earliestDeliveryDate),
    recoveryGapDays: gapDays,
    generatedAt: new Date().toISOString(),
    actions,
  };
}

function validateRecoveryChecklist(checklist = [], requestedDeliveryDate = null) {
  const errors = [];
  const customerDue = dateKey(requestedDeliveryDate);
  const today = dateKey(new Date());
  for (const item of checklist) {
    if (item.required && !item.selected) errors.push(`${item.title}: tindakan wajib belum dicentang.`);
    if (!item.selected) continue;
    if (!String(item.owner || "").trim()) errors.push(`${item.title}: PIC wajib diisi.`);
    if (!dateKey(item.targetDate)) errors.push(`${item.title}: target selesai wajib diisi.`);
    if (item.id !== "ACCEPT_LATE" && customerDue && customerDue >= today && dateKey(item.targetDate) > customerDue) errors.push(`${item.title}: target tindakan tidak boleh melewati due date customer.`);
  }
  return errors;
}

function buildTrialRecoveryChecklist(recommendation = {}, options = {}) {
  const owner = String(options.owner || "PPIC Trial").trim();
  const notes = String(options.notes || "Trial recovery otomatis dari MPS Workbench.").trim();
  const evidenceReference = String(options.evidenceReference || "MPS one-click trial recovery").trim();
  return (recommendation.actions || []).map((item) => {
    const selected = Boolean(item.required || item.id === "RUN_TRIAL_RECOVERY");
    return {
      ...item,
      selected,
      owner: selected ? owner || item.ownerRole || "PPIC Trial" : null,
      targetDate: item.targetDate || recommendation.requestedDeliveryDate || null,
      notes: selected ? notes : null,
      evidenceReference: selected ? evidenceReference : null,
    };
  });
}

function resolveAcceptedLateDate(requestedDeliveryDate, earliestFeasibleDeliveryDate) {
  const requested = asDate(requestedDeliveryDate);
  const feasible = asDate(earliestFeasibleDeliveryDate);
  if (!requested || !feasible) return null;
  if (feasible > requested) return feasible;
  return null;
}

module.exports = { buildDueDateRecoveryChecklist, buildTrialRecoveryChecklist, resolveAcceptedLateDate, validateRecoveryChecklist, calendarGapDays };
