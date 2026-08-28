const MINIMUM_SUCCESSOR_GAP_MINUTES = 120;
const DAY_MINUTES = 1440;

function dateOrdinal(value) {
  const parsed = new Date(value || "1970-01-01T00:00:00.000Z");
  const time = parsed.getTime();
  return Number.isFinite(time) ? Math.floor(time / 86400000) : 0;
}

function toMinute(value) {
  const match = String(value || "").match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (minute > 59 || hour > 47) return null;
  return hour * 60 + minute;
}

function issue(code, item, message, extra = {}) {
  return { code, scheduleNumber: item.scheduleNumber || null, message, ...extra };
}

function toTime(value) {
  const minutes = Math.max(Number(value) || 0, 0);
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function operationalMinute(value, dayStart = 420) {
  const minute = toMinute(value);
  if (minute == null) return null;
  return minute < dayStart ? minute + 1440 : minute;
}

function validateScheduleItems(items = []) {
  const blockers = [];
  const warnings = [];
  const validRanges = [];

  for (const item of items) {
    if (!item.machineId) blockers.push(issue("MACHINE_REQUIRED", item, "Mesin wajib dipilih."));
    if (!(Number(item.plannedQty) > 0)) blockers.push(issue("PLANNED_QTY_REQUIRED", item, "Planned quantity harus lebih dari 0."));
    const localStart = operationalMinute(item.plannedStartTime);
    const localEnd = operationalMinute(item.plannedEndTime);
    if (localStart == null || localEnd == null || localEnd <= localStart) {
      blockers.push(issue("TIME_RANGE_INVALID", item, "Jam mulai dan selesai tidak valid."));
    } else if (item.machineId) {
      const dayBase = dateOrdinal(item.scheduleDate) * DAY_MINUTES;
      validRanges.push({ item, start: dayBase + localStart, end: dayBase + localEnd, dayBase });
    }
    if (!item.woId && String(item.shift || "").toUpperCase() !== "VENDOR") {
      warnings.push(issue("WORK_ORDER_MISSING", item, "Work Order belum terhubung."));
    }
    if (String(item.materialReadinessStatus || "").toUpperCase().startsWith("WARNING")) {
      warnings.push(issue(
        "MATERIAL_SHORTAGE_WARNING",
        item,
        "Material belum siap pada tanggal planning. Daily Plan tetap dapat direlease dengan acknowledgement; stok aktual divalidasi sebelum material issue/produksi.",
        { materialReadinessStatus: item.materialReadinessStatus },
      ));
    }
  }

  validRanges.sort((a, b) => String(a.item.machineId).localeCompare(String(b.item.machineId)) || a.start - b.start);
  for (let index = 1; index < validRanges.length; index += 1) {
    const previous = validRanges[index - 1];
    const current = validRanges[index];
    if (current.item.machineId === previous.item.machineId && current.start < previous.end) {
      blockers.push(issue("MACHINE_TIME_OVERLAP", current.item, "Jadwal mesin bertumpuk.", {
        conflictScheduleNumber: previous.item.scheduleNumber || null,
      }));
    }
  }

  const rangeByAllocationId = new Map();
  for (const range of validRanges) {
    if (!range.item.productionPlanAllocationId) continue;
    const key = String(range.item.productionPlanAllocationId);
    const existing = rangeByAllocationId.get(key);
    if (!existing || range.end > existing.end) rangeByAllocationId.set(key, range);
  }
  for (const current of validRanges) {
    const predecessorIds = Array.isArray(current.item.predecessorAllocationIds)
      ? current.item.predecessorAllocationIds
      : [];
    for (const predecessorId of predecessorIds) {
      const predecessor = rangeByAllocationId.get(String(predecessorId));
      if (!predecessor) continue;
      const requiredStart = predecessor.end + MINIMUM_SUCCESSOR_GAP_MINUTES;
      if (current.start < requiredStart) {
        blockers.push(issue(
          "DIRECT_PREDECESSOR_GAP_SHORT",
          current.item,
          `Proses successor harus mulai minimal 2 jam setelah predecessor ${predecessor.item.scheduleNumber || predecessorId} selesai.`,
          {
            predecessorScheduleNumber: predecessor.item.scheduleNumber || null,
            requiredStartDate: new Date(Math.floor(requiredStart / DAY_MINUTES) * 86400000).toISOString().slice(0, 10),
            requiredStartTime: toTime(requiredStart - current.dayBase),
          },
        ));
      }
    }
  }

  return { blockers, warnings };
}

function summarizeRevision(revision = {}) {
  const schedules = Array.isArray(revision.schedules) ? revision.schedules : [];
  const releasedStatuses = new Set(["Released", "In Progress", "Completed"]);
  return {
    status: revision.status || "Draft",
    version: Number(revision.version || 1),
    itemCount: schedules.length,
    totalQty: schedules.reduce((sum, item) => sum + Number(item.plannedQty || 0), 0),
    editable: ["Draft", "Ready", "Partially Released"].includes(String(revision.status || "Draft")),
    releasedCount: schedules.filter((item) => releasedStatuses.has(item.status)).length,
  };
}

function buildExecutionExceptions(schedules = []) {
  const rows = [];
  schedules.forEach((schedule) => {
    const logs = Array.isArray(schedule.productionLogs) ? schedule.productionLogs : [];
    const good = logs.reduce((sum, log) => sum + Number(log.qtyGood || 0), 0);
    const ng = logs.reduce((sum, log) => sum + Number(log.qtyReject || 0) + Number(log.qtyRework || 0), 0);
    const downtime = logs.reduce((sum, log) => sum + Number(log.downtime || 0), 0);
    const common = {
      id: `derived:${schedule.id}`,
      sourceType: "DailyProductionSchedule",
      sourceId: schedule.id,
      planDate: schedule.scheduleDate,
      machineId: schedule.machineId || null,
      partCode: schedule.partCode || null,
      processCode: schedule.processCode || null,
      uomCode: schedule.uomCode || null,
      state: "OPEN",
      derived: true,
    };
    const shortfall = Math.max(0, Number(schedule.plannedQty || 0) - good);
    if (["Completed", "In Progress"].includes(schedule.status) && shortfall > 0) rows.push({
      ...common,
      id: `${common.id}:shortfall`,
      exceptionType: "PRODUCTION_SHORTFALL",
      severity: schedule.status === "Completed" ? "BLOCKER" : "WARNING",
      qty: shortfall,
      suggestions: [{ action: "ALLOCATE_NEXT_DRAFT", label: "Alokasikan sisa ke Draft berikutnya" }],
    });
    if (ng > 0) rows.push({
      ...common,
      id: `${common.id}:ng`,
      exceptionType: "NG_PENDING_REVIEW",
      severity: "WARNING",
      qty: ng,
      suggestions: [{ action: "WAIT_QC", label: "Tunggu disposition QC" }, { action: "PREPARE_REWORK", label: "Siapkan slot rework" }],
    });
    if (downtime > 0) rows.push({
      ...common,
      id: `${common.id}:downtime`,
      exceptionType: "MACHINE_DOWNTIME",
      severity: "WARNING",
      qty: downtime,
      uomCode: "MIN",
      suggestions: [{ action: "MOVE_MACHINE", label: "Evaluasi mesin alternatif" }, { action: "MOVE_TIME", label: "Geser ke slot aman" }],
    });
  });
  return rows;
}

module.exports = { MINIMUM_SUCCESSOR_GAP_MINUTES, toMinute, validateScheduleItems, summarizeRevision, buildExecutionExceptions };
