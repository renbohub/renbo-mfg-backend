"use strict";
const { resolveCapacityFromProfiles } = require("./workingHourCalendarService");
const fail = (message) => Object.assign(new Error(message), { code: "RCCP_WORK_CENTER_INVALID", statusCode: 409 });
const norm = (value) => String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const poolCode = (wc, spec) => `WC:${wc.workCenterCode}:${spec}`;
const poolSignature = (basis) => basis ? JSON.stringify([basis.workCenterId, basis.workCenterCode, basis.specification,
  (basis.machines || []).map(machine => machine.id).sort()]) : null;

function resolvePool(process, centers, machines) {
  const selected = machines.find(m => m.id === process.machineId);
  const spec = process.machineSpecificationCode || selected?.machineSpecificationCode;
  const explicit = process.routingOperation?.workCenterId;
  const candidates = centers.filter(wc => wc.isActive && (explicit ? wc.id === explicit
    : selected ? wc.machines.some(link => link.machineId === selected.id)
      : spec && wc.machines.some(link => machines.some(m => m.id === link.machineId && m.machineSpecificationCode === spec))));
  if (!spec || candidates.length !== 1) throw fail(`Proses ${process.process?.processCode || "produksi"}: work center/spesifikasi mesin belum tunggal dan lengkap.`);
  const wc = candidates[0];
  const members = [...new Map(wc.machines.map(link => machines.find(m => m.id === link.machineId))
    .filter(m => m && !m.isDeleted && m.status === "Active" && m.machineSpecificationCode === spec).map(m => [m.id, m])).values()];
  if (!members.length) throw fail(`${wc.workCenterCode}: tidak ada mesin aktif dengan spesifikasi ${spec}.`);
  // Sharing one physical machine between capacity pools would double capacity.
  if (members.some(m => centers.filter(c => c.isActive && c.machines.some(l => l.machineId === m.id)).length > 1)) {
    throw fail(`${wc.workCenterCode}: mesin terdaftar di lebih dari satu work center aktif; tetapkan satu pool kapasitas.`);
  }
  return { code: poolCode(wc, spec), workCenter: wc, specification: spec, machines: members.sort((a, b) => a.machineCode.localeCompare(b.machineCode)) };
}

async function hydrateWorkCenterProfiles(db, details, matchesProcess) {
  const headerIds = [...new Set(details.map(d => d.mbomHeaderId).filter(Boolean))];
  if (!headerIds.length) return details;
  const [headers, centers, machines] = await Promise.all([
    db.mBOMHeader.findMany({ where: { id: { in: headerIds }, isDeleted: false }, include: { details: { where: { isDeleted: false }, include: {
      mbomProcesses: { where: { isDeleted: false }, include: { process: true, routingOperation: true } },
    } } } }),
    db.workCenter.findMany({ include: { machines: true, workingHourProfile: { include: { rules: true } } } }),
    db.machine.findMany({ where: { isDeleted: false }, include: { workingHourProfile: { include: { rules: true } } } }),
  ]);
  for (const detail of details) {
    if (!detail.part) continue;
    const header = headers.find(h => h.id === detail.mbomHeaderId);
    const processes = (header?.details || []).flatMap(d => d.mbomProcesses).filter(p => p.routingMode !== "VENDOR" && !p.routingOperation?.isSubcontract);
    detail.part.rccpResourceProfiles = (detail.part?.rccpResourceProfiles || []).map(profile => {
      if (profile.resourceType === "OUTSOURCE") return profile;
      const exact = processes.filter(p => [p.process?.processCode, p.process?.processName, p.machineSpecificationCode].filter(Boolean)
        .some(code => [profile.resourceCode, profile.resourceName].some(value => norm(value) === norm(code))));
      const matched = exact.length ? exact : processes.filter(p => matchesProcess(profile, { processCode: p.process?.processCode, processName: p.process?.processName }));
      const identified = matched.filter(p => p.machineId || p.machineSpecificationCode || p.routingOperation?.workCenterId);
      if (!identified.length) return profile; // Legacy/manual resources without a machine requirement stay explicit.
      const pools = identified.map(p => resolvePool(p, centers, machines));
      if (new Set(pools.map(p => p.code)).size !== 1) throw fail(`${detail.partCode} · ${profile.resourceCode}: beberapa work center terpetakan ke satu profil; pisahkan profil proses.`);
      const pool = pools[0];
      return { ...profile, originalResourceCode: profile.resourceCode, resourceCode: pool.code,
        resourceName: pool.workCenter.workCenterCode, resourceCount: pool.machines.length,
        poolMachines: pool.machines, poolWorkCenter: pool.workCenter, poolSpecification: pool.specification,
        machineId: pool.machines[0].id, matchedProcessCodes: matched.map(p => p.process?.processCode).filter(Boolean),
        capacityBasis: { type: "WORK_CENTER", workCenterId: pool.workCenter.id, workCenterCode: pool.workCenter.workCenterCode,
          specification: pool.specification, machines: pool.machines.map(m => ({ id: m.id, machineCode: m.machineCode, machineName: m.machineName })) },
      };
    });
  }
  return details;
}

function poolCapacityHours(profile, start, end, overrides = []) {
  if (!profile.poolMachines) return null;
  const byMachineDay = new Map(overrides.map(o => [`${o.machineId}|${new Date(o.scheduleDate).toISOString().slice(0, 10)}`, o]));
  let total = 0;
  for (const machine of profile.poolMachines) {
    for (let day = new Date(start); day <= new Date(end); day.setUTCDate(day.getUTCDate() + 1)) {
      const key = day.toISOString().slice(0, 10), override = byMachineDay.get(`${machine.id}|${key}`);
      const machineCalendar = machine.workingHourProfile?.isActive && !machine.workingHourProfile.isDeleted ? machine.workingHourProfile : null;
      const wcCalendar = profile.poolWorkCenter.workingHourProfile?.isActive && !profile.poolWorkCenter.workingHourProfile.isDeleted ? profile.poolWorkCenter.workingHourProfile : null;
      let hours;
      if (override && (override.dayStatus === "HOLIDAY" || override.shiftsPerDay === 0)) hours = 0;
      else if (machineCalendar || wcCalendar || Array.isArray(override?.shiftOverrides)) {
        const calendar = resolveCapacityFromProfiles({ date: key, profiles: { machine: machineCalendar, workCenter: wcCalendar }, globalOverride: override });
        hours = (override?.shiftsPerDay != null ? calendar.shifts.slice(0, override.shiftsPerDay) : calendar.shifts).reduce((sum, shift) => sum + shift.effectiveMinutes, 0) / 60;
      } else {
        const working = override ? override.dayStatus !== "HOLIDAY" : profile.calendarMode === "ALL_DAYS" || ![0, 6].includes(day.getUTCDay());
        hours = working ? Number(override?.shiftsPerDay ?? profile.shiftsPerDay) * Number(profile.effectiveHoursPerShift) : 0;
      }
      total += hours * Number(profile.efficiencyPercent) / 100;
    }
  }
  return Math.max(total - Number(profile.plannedDowntimeHours || 0), 0);
}
module.exports = { resolvePool, hydrateWorkCenterProfiles, poolCapacityHours, poolSignature };
