const DAY_MS = 24 * 60 * 60 * 1000;
const TIME_ZONE = "Asia/Jakarta";
const LOGGED_TIME_NOTE = "Availability menggunakan durasi production log setelah downtime, bukan seluruh waktu shift terjadwal.";

const text = value => (value == null ? "" : String(value).trim());
const number = value => {
  if (value == null || value === "" || typeof value === "boolean") return null;
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 ? result : null;
};
const round = value => value == null ? null : Number(value.toFixed(2));
const ratio = (part, total) => part != null && total > 0 ? part / total : null;
const iso = value => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};
const sumKnown = values => values.length && values.every(value => value != null)
  ? values.reduce((total, value) => total + value, 0) : null;
const dateKey = date => new Intl.DateTimeFormat("en-CA", {
  timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
}).format(date);

function badRequest(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function monitoringPeriod(query = {}, now = new Date()) {
  const date = query.date == null || query.date === "" ? dateKey(now) : query.date;
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw badRequest("Tanggal harus menggunakan format YYYY-MM-DD.");
  }
  const start = new Date(`${date}T00:00:00+07:00`);
  if (!Number.isFinite(start.getTime()) || dateKey(start) !== date) {
    throw badRequest("Tanggal monitoring tidak valid.");
  }
  const shift = query.shift == null ? "" : query.shift;
  if (typeof shift !== "string" || (shift && !/^[a-zA-Z0-9][a-zA-Z0-9 _-]{0,19}$/.test(shift))) {
    throw badRequest("Shift tidak valid.");
  }
  const machineId = query.machineId == null ? "" : query.machineId;
  if (typeof machineId !== "string" || machineId.length > 100 || /[\x00-\x1f]/.test(machineId)) {
    throw badRequest("Machine ID tidak valid.");
  }
  return { date, shift: shift.trim() || null, machineId: machineId.trim() || null, start, end: new Date(start.getTime() + DAY_MS) };
}

function elapsedMinutes(start, end) {
  const from = iso(start);
  const until = iso(end);
  if (!from || !until) return null;
  const duration = (Date.parse(until) - Date.parse(from)) / 60000;
  return duration >= 0 ? duration : null;
}

function downtimeDuration(row) {
  const stored = number(row.durationMinutes);
  const elapsed = elapsedMinutes(row.startTime, row.endTime);
  if (stored > 0) return stored;
  if (elapsed != null) return elapsed;
  // An open record's default zero is not evidence of a zero-length event.
  if (!row.endTime && text(row.status).toLowerCase() === "open") return null;
  return stored;
}

function logSpan(log) {
  const stored = number(log.runningMinutes);
  if (stored > 0) return stored;
  return elapsedMinutes(log.startTime, log.endTime) ?? stored;
}

function machineCodeFor(row) {
  return text(row.machineCode) || text(row.workOrder?.machine?.machineCode);
}

function historyEntry(row, log = null) {
  return {
    id: row.id,
    downtimeNumber: row.downtimeNumber || null,
    reason: text(row.reason) || "Alasan belum dicatat",
    category: text(row.category) || "OTHER",
    startTime: iso(row.startTime),
    endTime: iso(row.endTime),
    recordedAt: iso(row.downtimeDate || log?.logDate || row.createdAt),
    updatedAt: iso(row.updatedAt || row.createdAt),
    durationMinutes: round(downtimeDuration(row)),
    status: row.status || null,
    shift: row.shift || log?.shift || null,
    operatorName: row.operatorName || log?.operatorName || null,
    moNumber: log?.manufacturingOrder?.moNumber || row.manufacturingOrder?.moNumber || null,
    logNumber: log?.logNumber || null,
    source: log ? "downtime_log" : "unlinked_downtime_log",
  };
}

function latestProduction(log) {
  if (!log) return null;
  const part = log.manufacturingOrder?.part;
  const workOrder = log.workOrder;
  return {
    moNumber: log.manufacturingOrder?.moNumber || null,
    woNumber: workOrder?.woNumber || null,
    partCode: workOrder?.outputPartCode || part?.partCode || null,
    partNumber: workOrder?.outputPartNumber || part?.partNumber || null,
    partName: workOrder?.outputPartName || part?.partName || null,
    operatorName: log.operatorName || workOrder?.operatorName || null,
    shift: log.shift || null,
    startTime: iso(log.startTime),
    endTime: iso(log.endTime),
    logNumber: log.logNumber,
    status: log.status,
  };
}

function hasOverlappingSpans(logs) {
  const spans = logs.map(log => [iso(log.startTime), iso(log.endTime)])
    .filter(([start, end]) => start && end && end > start)
    .sort((a, b) => a[0].localeCompare(b[0]));
  let previousEnd = null;
  for (const [start, end] of spans) {
    if (previousEnd && start < previousEnd) return true;
    previousEnd = end;
  }
  return false;
}

function targetOutput(logs) {
  if (!logs.length) return null;
  const targets = new Map();
  for (const log of logs) {
    // Repeated logs may each contain the remaining DPS quantity; never add
    // that remainder to the schedule's full target again.
    const schedule = log.dailyProductionSchedule;
    const key = schedule?.id ? `dps:${schedule.id}` : log.woId
      ? `wo:${log.woId}:${log.shift}` : `log:${log.id}`;
    const value = number(schedule?.plannedQty) ?? number(log.qtyPlanned);
    const previous = targets.get(key);
    targets.set(key, previous == null ? value : value == null ? previous : Math.max(previous, value));
  }
  const total = sumKnown([...targets.values()]);
  // Schema defaults to zero even when no target was entered.
  return total > 0 ? total : null;
}

function aggregateMachine(machine, logs = [], unlinkedDowntimes = []) {
  const notes = new Set();
  if (logs.length) notes.add(LOGGED_TIME_NOTE);
  const histories = [];
  const spans = [];
  const netSpans = [];
  const linkedDurations = [];
  const quantities = { totalProduced: [], goodOutput: [], rejectOutput: [], reworkOutput: [] };
  const idealSeconds = [];
  const cycleTimes = new Set();
  let validQuality = true;
  const latestFirst = [...logs].sort((a, b) =>
    text(iso(b.startTime || b.logDate || b.createdAt)).localeCompare(text(iso(a.startTime || a.logDate || a.createdAt)))
    || text(iso(b.createdAt)).localeCompare(text(iso(a.createdAt))));

  for (const log of logs) {
    const downtimeRows = (log.downtimeLogs || []).filter(row => !row.isDeleted && row.status !== "Cancelled");
    let downtime = number(log.downtime);
    if (downtimeRows.length) {
      const unique = [...new Map(downtimeRows.map(row => [row.id, row])).values()];
      downtime = sumKnown(unique.map(downtimeDuration));
      histories.push(...unique.map(row => historyEntry(row, log)));
      if (number(log.downtime) != null && downtime != null && Math.abs(Number(log.downtime) - downtime) > 0.01) {
        notes.add("Total downtime menggunakan rincian Downtime Log; subtotal production log berbeda.");
      }
    } else if (downtime > 0) {
      histories.push({
        id: `production-log:${log.id}`, downtimeNumber: null,
        reason: text(log.downtimeReason) || "Downtime tanpa rincian",
        category: "OTHER", startTime: null, endTime: null,
        recordedAt: iso(log.logDate), updatedAt: iso(log.updatedAt),
        durationMinutes: round(downtime), status: null,
        shift: log.shift || null, operatorName: log.operatorName || null,
        moNumber: log.manufacturingOrder?.moNumber || null,
        logNumber: log.logNumber, source: "production_log_summary",
      });
    }
    const span = logSpan(log);
    const runtime = span != null && downtime != null && downtime <= span ? span - downtime : null;
    if (span == null) notes.add("Durasi sebagian production log belum lengkap.");
    if (downtime == null) notes.add("Durasi downtime sebagian log belum diketahui; runtime dan OEE belum dapat dihitung.");
    if (span != null && downtime != null && downtime > span) {
      notes.add("Downtime melebihi durasi production log; runtime dan OEE perlu koreksi data.");
    }
    const produced = number(log.qtyProduced);
    const good = number(log.qtyGood);
    const reject = number(log.qtyReject);
    const rework = number(log.qtyRework);
    if (produced == null || good == null || reject == null || rework == null) notes.add("Sebagian jumlah output tidak valid atau belum diisi.");
    if (produced != null && good != null && good > produced) {
      validQuality = false;
      notes.add("Jumlah good output melebihi total output; quality belum dapat dihitung.");
    }
    quantities.totalProduced.push(produced);
    quantities.goodOutput.push(good);
    quantities.rejectOutput.push(reject);
    quantities.reworkOutput.push(rework);
    spans.push(span);
    netSpans.push(runtime);
    linkedDurations.push(downtime);
    const ct = [log.workOrder?.cycleTime, machine.cycleTime].map(number).find(value => value > 0) ?? null;
    if (ct != null) cycleTimes.add(ct);
    if (ct == null && produced > 0) notes.add("Ideal cycle time belum tersedia untuk sebagian output.");
    idealSeconds.push(produced === 0 ? 0 : produced != null && ct != null ? produced * ct : null);
  }
  const unlinked = unlinkedDowntimes.filter(row => !row.isDeleted && row.status !== "Cancelled");
  histories.push(...unlinked.map(row => historyEntry(row)));
  if (unlinked.length) notes.add("Downtime tanpa production log masuk histori dan total downtime, tetapi belum dapat dialokasikan ke perhitungan OEE.");
  histories.sort((a, b) => text(b.startTime || b.recordedAt).localeCompare(text(a.startTime || a.recordedAt)));

  const output = Object.fromEntries(Object.entries(quantities).map(([key, values]) => [key, logs.length ? sumKnown(values) : 0]));
  let plannedMinutes = sumKnown(spans);
  let runtimeMinutes = sumKnown(netSpans);
  if (hasOverlappingSpans(logs)) {
    notes.add("Rentang waktu production log mesin bertumpuk; waktu dan OEE belum dapat digabung tanpa verifikasi.");
    plannedMinutes = null;
    runtimeMinutes = null;
  }
  const totalIdealSeconds = sumKnown(idealSeconds);
  const linkedDowntime = logs.length ? sumKnown(linkedDurations) : 0;
  const unlinkedDowntime = unlinked.length ? sumKnown(unlinked.map(downtimeDuration)) : 0;
  const downtimeMinutes = linkedDowntime != null && unlinkedDowntime != null ? linkedDowntime + unlinkedDowntime : null;
  const availability = ratio(runtimeMinutes, plannedMinutes);
  const performance = ratio(totalIdealSeconds, runtimeMinutes == null ? null : runtimeMinutes * 60);
  const quality = validQuality && output.goodOutput != null && output.totalProduced != null && output.goodOutput <= output.totalProduced
    ? ratio(output.goodOutput, output.totalProduced) : null;
  const oee = plannedMinutes > 0 && runtimeMinutes != null && output.totalProduced === 0 && output.goodOutput === 0
    ? 0 : availability != null && performance != null && quality != null ? availability * performance * quality : null;
  if (performance > 1.0001) notes.add("Performance melebihi 100%; periksa ideal cycle time dan durasi log.");
  if (cycleTimes.size > 1) notes.add("Ideal cycle time merupakan rata-rata tertimbang terhadap total output dari beberapa pekerjaan.");
  const target = targetOutput(logs);
  const lastUpdatedAt = [...logs.map(log => iso(log.updatedAt || log.createdAt)), ...histories.map(row => row.updatedAt)]
    .filter(Boolean).sort().at(-1) || null;

  return {
    id: machine.id, machineCode: machine.machineCode, machineName: machine.machineName || machine.machineCode,
    machineType: machine.machineType || null, machineFamily: machine.machineFamily || null,
    lineCode: machine.lineCode || null, location: machine.location || null,
    masterStatus: machine.status, status: logs.length || histories.length ? "recorded" : "no_data",
    dataSource: "production_logs", isRealtime: false, lastUpdatedAt, logCount: logs.length,
    metrics: {
      ...Object.fromEntries(Object.entries(output).map(([key, value]) => [key, round(value)])),
      targetOutput: round(target), plannedMinutes: round(plannedMinutes), runtimeMinutes: round(runtimeMinutes),
      downtimeMinutes: round(downtimeMinutes), loggedDowntimeMinutes: round(linkedDowntime),
      unlinkedDowntimeMinutes: round(unlinkedDowntime),
      idealCycleTimeSeconds: round(output.totalProduced > 0 && totalIdealSeconds != null
        ? totalIdealSeconds / output.totalProduced : cycleTimes.size === 1 ? [...cycleTimes][0] : null),
      availability: round(availability == null ? null : availability * 100),
      performance: round(performance == null ? null : performance * 100),
      quality: round(quality == null ? null : quality * 100),
      oee: round(oee == null ? null : oee * 100),
      rejectRate: round(output.totalProduced > 0 && output.rejectOutput != null ? output.rejectOutput / output.totalProduced * 100 : null),
      achievementRate: round(target > 0 && output.goodOutput != null ? output.goodOutput / target * 100 : null),
    },
    production: latestProduction(latestFirst[0]),
    downtimeHistory: histories,
    downtimeReasons: [...histories.reduce((result, row) => {
      const key = `${row.category}:${row.reason}`;
      const entry = result.get(key) || { reason: row.reason, category: row.category, count: 0, durationMinutes: 0 };
      entry.count += 1;
      entry.durationMinutes = entry.durationMinutes != null && row.durationMinutes != null ? entry.durationMinutes + row.durationMinutes : null;
      result.set(key, entry);
      return result;
    }, new Map()).values()].map(row => ({ ...row, durationMinutes: round(row.durationMinutes) }))
      .sort((a, b) => (b.durationMinutes ?? -1) - (a.durationMinutes ?? -1)),
    dataQuality: [...notes],
  };
}

function aggregateSummary(machines) {
  const recorded = machines.filter(machine => machine.logCount > 0);
  const sum = (field, entries = recorded) => entries.length
    ? sumKnown(entries.map(machine => machine.metrics[field])) : null;
  const totalProduced = sum("totalProduced") ?? (recorded.length ? null : 0);
  const goodOutput = sum("goodOutput") ?? (recorded.length ? null : 0);
  const plannedMinutes = sum("plannedMinutes");
  const runtimeMinutes = sum("runtimeMinutes");
  // Duration-weighted fleet OEE preserves the contribution of each machine.
  const weighted = (field, weight = "plannedMinutes") => {
    const totalWeight = sum(weight);
    return totalWeight > 0 && recorded.every(machine => machine.metrics[weight] != null
      && (machine.metrics[weight] === 0 || machine.metrics[field] != null))
      ? recorded.reduce((total, machine) => total + (machine.metrics[field] || 0) * machine.metrics[weight], 0) / totalWeight : null;
  };
  return {
    machineCount: machines.length,
    machinesWithData: machines.filter(machine => machine.status === "recorded").length,
    machinesWithOee: machines.filter(machine => machine.metrics.oee != null).length,
    totalProduced: round(totalProduced), goodOutput: round(goodOutput),
    rejectOutput: round(sum("rejectOutput") ?? (recorded.length ? null : 0)),
    targetOutput: round(sum("targetOutput")), plannedMinutes: round(plannedMinutes), runtimeMinutes: round(runtimeMinutes),
    downtimeMinutes: round(sum("downtimeMinutes", machines) ?? (machines.length ? null : 0)),
    availability: round(runtimeMinutes != null && plannedMinutes > 0 ? runtimeMinutes / plannedMinutes * 100 : null),
    performance: round(weighted("performance", "runtimeMinutes")),
    quality: round(goodOutput != null && totalProduced > 0 && goodOutput <= totalProduced ? goodOutput / totalProduced * 100 : null),
    oee: round(weighted("oee")),
    oeeBasis: "logged_duration_weighted_machine_oee",
  };
}

const machineSelect = {
  id: true, machineCode: true, machineName: true, machineType: true, machineFamily: true,
  lineCode: true, location: true, status: true, cycleTime: true,
};
const downtimeSelect = {
  id: true, downtimeNumber: true, downtimeDate: true, reason: true, category: true,
  machineCode: true, durationMinutes: true, startTime: true, endTime: true,
  status: true, shift: true, operatorName: true, updatedAt: true, createdAt: true,
};

async function buildOeeMonitoring(prisma, query = {}, now = new Date()) {
  const period = monitoringPeriod(query, now);
  const dateRange = { gte: period.start, lt: period.end };
  const [masterMachines, allLogs, allUnlinked] = await Promise.all([
    prisma.machine.findMany({
      where: { isDeleted: false, status: { in: ["Active", "Maintenance"] } },
      select: machineSelect, orderBy: { machineCode: "asc" },
    }),
    prisma.productionLog.findMany({
      where: { isDeleted: false, status: { not: "Cancelled" }, logDate: dateRange },
      orderBy: [{ startTime: "desc" }, { createdAt: "desc" }],
      select: {
        id: true, logNumber: true, logDate: true, dpsId: true, woId: true, shift: true,
        machineCode: true, operatorName: true, qtyPlanned: true, qtyProduced: true,
        qtyGood: true, qtyReject: true, qtyRework: true, startTime: true, endTime: true,
        runningMinutes: true, downtime: true, downtimeReason: true, status: true,
        source: true, updatedAt: true, createdAt: true,
        dailyProductionSchedule: { select: { id: true, plannedQty: true } },
        manufacturingOrder: { select: { moNumber: true, part: { select: { partCode: true, partNumber: true, partName: true } } } },
        workOrder: { select: {
          woNumber: true, cycleTime: true, operatorName: true, outputPartCode: true,
          outputPartNumber: true, outputPartName: true, machine: { select: machineSelect },
        } },
        downtimeLogs: {
          where: { isDeleted: false, status: { not: "Cancelled" } }, select: downtimeSelect,
        },
      },
    }),
    prisma.downtimeLog.findMany({
      where: { isDeleted: false, status: { not: "Cancelled" }, productionLogId: null, downtimeDate: dateRange },
      select: {
        ...downtimeSelect,
        manufacturingOrder: { select: { moNumber: true } },
        workOrder: { select: { machine: { select: machineSelect } } },
      },
    }),
  ]);
  const shifts = [...new Set([...allLogs, ...allUnlinked].map(row => text(row.shift)).filter(Boolean))].sort();
  const logs = allLogs.filter(row => !period.shift || row.shift === period.shift);
  const unlinked = allUnlinked.filter(row => !period.shift || row.shift === period.shift);
  const known = new Map(masterMachines.map(machine => [machine.machineCode, machine]));
  // Preserve historical evidence when an asset was subsequently made inactive
  // or retired, and legacy machine codes that no longer have a master record.
  for (const row of [...logs, ...unlinked]) {
    const code = machineCodeFor(row);
    if (code && !known.has(code)) known.set(code, row.workOrder?.machine?.machineCode === code
      ? row.workOrder.machine
      : { id: `legacy:${code}`, machineCode: code, machineName: code, status: "Unknown" });
  }
  const machines = [...known.values()]
    .filter(machine => !period.machineId || machine.id === period.machineId)
    .sort((a, b) => a.machineCode.localeCompare(b.machineCode, "en", { numeric: true }))
    .map(machine => aggregateMachine(machine,
      logs.filter(row => machineCodeFor(row) === machine.machineCode),
      unlinked.filter(row => machineCodeFor(row) === machine.machineCode)));
  if (period.machineId && !machines.length) {
    throw Object.assign(new Error("Mesin tidak ditemukan pada periode monitoring."), { statusCode: 404 });
  }
  return {
    generatedAt: now.toISOString(),
    period: { date: period.date, timeZone: TIME_ZONE, startAt: period.start.toISOString(), endAt: period.end.toISOString(), shift: period.shift },
    dataSource: "production_logs", isRealtime: false,
    dataQuality: [LOGGED_TIME_NOTE, "OEE gabungan ditimbang menurut durasi log mesin. Status mesin real-time tidak tersedia dari laporan ini.",
      ...([...logs, ...unlinked].some(row => !machineCodeFor(row)) ? ["Sebagian log tidak memiliki referensi mesin dan tidak masuk ringkasan mesin."] : [])],
    shifts, summary: aggregateSummary(machines), machines,
  };
}

module.exports = { monitoringPeriod, downtimeDuration, aggregateMachine, aggregateSummary, buildOeeMonitoring };
