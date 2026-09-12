"use strict";
const { createHash } = require("node:crypto");
const n = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const dateKey = value => { if (!value || (value instanceof Date && !Number.isFinite(value.getTime()))) return null; const key=String(value instanceof Date?value.toISOString():value).slice(0,10); const d=new Date(`${key}T00:00:00Z`); return /^\d{4}-\d{2}-\d{2}$/.test(key)&&Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===key?key:null; };
const shiftKey = value => String(value || "").trim().toUpperCase().replace(/^SHIFT[ -]?/, "");
const minute = value => { const match=/^(\d{1,2}):(\d{2})$/.exec(String(value||"")); if(!match)return null; const h=Number(match[1]),m=Number(match[2]);return h<=24&&m<60&&(h<24||m===0)?h*60+m:null; };

function machineWindows(machine, row) {
  if(!machine || !dateKey(row.scheduleDate))return [];
  const windows=[];
  for(let offset=0;offset<=1;offset++) for(let shift=1;shift<=3;shift++){
    const start=minute(machine[`shift${shift}Start`]),end=minute(machine[`shift${shift}End`]);
    if(start==null||end==null)continue;
    const date=new Date(`${dateKey(row.scheduleDate)}T00:00:00Z`);date.setUTCDate(date.getUTCDate()+offset);
    windows.push({shift:String(shift),scheduleDate:dateKey(date),startMinute:start+offset*1440,endMinute:(end<=start?end+1440:end)+offset*1440});
  }
  return windows;
}

function identity(row) {
  const fields = [dateKey(row.scheduleDate), row.machineId, shiftKey(row.shift), row.partCode, row.processCode];
  return fields.every(Boolean) ? JSON.stringify(fields) : null;
}

// Windows are explicit calendar slots, in minutes relative to the operational
// date (so a night shift can end above 1440). Do not invent vendor shifts.
function splitAllocation(row, windows = []) {
  if (!windows.length) return [{ ...row }];
  const start = minute(row.plannedStartTime);
  let end = minute(row.plannedEndTime);
  if (start == null || end == null) return [{ ...row }];
  if (end <= start) end += 1440;
  const intersections = windows.map(window => ({
    shift: shiftKey(window.shift || window.shiftCode),
    scheduleDate: window.scheduleDate || row.scheduleDate,
    start: Math.max(start, n(window.startMinute)),
    end: Math.min(end, n(window.endMinute)),
  })).filter(window => window.shift && window.end > window.start).sort((a, b) => a.start - b.start);
  const duration = intersections.reduce((sum, window) => sum + window.end - window.start, 0);
  if (duration !== end - start || intersections.some((window, i) => i > 0 && window.start < intersections[i - 1].end)) {
    return [{ ...row, lotException: "Jadwal belum sepenuhnya tercakup slot shift" }];
  }
  const discrete = /^(PCS|PC|EA|UNIT|SHEET)$/.test(String(row.uomCode).toUpperCase());
  let assigned = 0;
  return intersections.map((window, index) => {
    const portion = n(row.qty) * (window.end - window.start) / duration;
    const qty = index === intersections.length - 1 ? n(row.qty) - assigned : discrete ? Math.floor(portion) : Math.round(portion * 1e6) / 1e6;
    assigned += qty;
    return { ...row, scheduleDate: window.scheduleDate, shift: window.shift, qty, minutes: n(row.minutes) * (window.end - window.start) / duration,
      plannedStartMinute: window.start, plannedEndMinute: window.end };
  }).filter(row => row.qty > 0);
}

function buildProductionLots(allocations = [], { windowsFor = () => [] } = {}) {
  const groups = new Map(), exceptions = [], seen = new Set();
  for (const input of allocations) {
    if (!Number.isFinite(Number(input.qty)) || Number(input.qty) < 0) { exceptions.push({ ...input, reason: "Jumlah lot tidak valid" }); continue; }
    if (Number(input.qty) === 0) continue;
    if (input.allocationId && seen.has(input.allocationId)) continue;
    if (input.allocationId) seen.add(input.allocationId);
    const split = splitAllocation({ ...input, uomCode: String(input.uomCode || "").trim().toUpperCase() }, windowsFor(input));
    const sourceAssigned = [];
    for (const [index, row] of split.entries()) {
      row.demandSources = (input.demandSources || []).map((source, sourceIndex) => {
        const qty = index === split.length - 1 ? n(source.qty) - (sourceAssigned[sourceIndex] || 0) : Math.round(n(source.qty) * n(row.qty) / n(input.qty) * 1e6) / 1e6;
        sourceAssigned[sourceIndex] = (sourceAssigned[sourceIndex] || 0) + qty;
        return { ...source, qty };
      });
      const key = identity(row);
      if (!key || row.lotException) { exceptions.push({ ...row, reason: row.lotException || (row.vendorId ? "Mesin atau shift vendor belum tersedia" : "Tanggal, mesin, shift, part, atau proses belum lengkap") }); continue; }
      let lot = groups.get(key);
      if (lot && lot.uomCode !== row.uomCode) { exceptions.push({ ...row, reason: "Satuan berbeda pada identitas lot yang sama" }); continue; }
      if (!lot) {
        lot = { key, lotPlanNumber: `RLOT-${createHash("sha256").update(key).digest("hex").slice(0, 20).toUpperCase()}`,
          scheduleDate: dateKey(row.scheduleDate), machineId: row.machineId, shift: shiftKey(row.shift), partCode: row.partCode,
          processCode: row.processCode, uomCode: row.uomCode, qty: 0, minutes: 0, allocations: [], predecessorLotKeys: [] };
        groups.set(key, lot);
      }
      lot.qty += n(row.qty); lot.minutes += n(row.minutes);
      lot.allocations.push({ allocationId: row.allocationId || null, planNumber: row.planNumber || null, lineNumber: row.lineNumber,
        qty: n(row.qty), customerCode: row.customerCode || null, demandSources: row.demandSources || [], woNumber: row.woNumber || null,
        predecessorAllocationIds: row.predecessorAllocationIds || [], plannedStartTime: row.plannedStartTime, plannedEndTime: row.plannedEndTime,
        plannedStartMinute: row.plannedStartMinute, plannedEndMinute: row.plannedEndMinute });
    }
  }
  const lots = [...groups.values()];
  const byAllocation = new Map();
  for (const lot of lots) for (const allocation of lot.allocations) {
    if (!byAllocation.has(allocation.allocationId)) byAllocation.set(allocation.allocationId, []);
    byAllocation.get(allocation.allocationId).push(lot.key);
  }
  for (const lot of lots) lot.predecessorLotKeys = [...new Set(lot.allocations.flatMap(row => row.predecessorAllocationIds.flatMap(id => byAllocation.get(id) || [])))].filter(key => key !== lot.key);
  return { lots, exceptions };
}
module.exports = { identity, splitAllocation, buildProductionLots, machineWindows };
