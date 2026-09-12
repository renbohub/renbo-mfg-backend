"use strict";
const { shiftWindows, withCapacityRuleIndex, buildCapacityRuleIndex } = require("./capacityRecommendationService");
const E = require("../../../../../library/ppic-planning/engine");
const CLOSED = new Set(["HOLIDAY", "CLOSED", "UNAVAILABLE", "OFF"]);
const key = d => new Date(d).toISOString().slice(0, 10);
const active = (p, date) => p?.isActive && !p.isDeleted && (!p.effectiveFrom || key(p.effectiveFrom)<=date) && (!p.effectiveUntil || key(p.effectiveUntil)>=date);
const minutes = s => { const [h,m]=s.split(":").map(Number); return h*60+m; };

function buildCalendar({ machines, preset, overrides, planOverrides, start, end }) {
  const count = Math.round((end-start)/86400000), origin = start.getTime()/60000;
  const byMachine = new Map(overrides.map(r=>[`${r.machineId}|${key(r.scheduleDate)}`,r]));
  const companyClosed = new Set(overrides.filter(r=>CLOSED.has(r.dayStatus) && (!r.machineId || String(r.reason||"").startsWith("[YEARLY-CALENDAR:"))).map(r=>key(r.scheduleDate)));
  const dates = Array.from({length:count},(_,i)=>key(new Date(start.getTime()+i*86400000)));
  for (const date of dates) if (machines.length && machines.every(m=>CLOSED.has(byMachine.get(`${m.id}|${date}`)?.dayStatus))) companyClosed.add(date);
  const base = withCapacityRuleIndex(preset, buildCapacityRuleIndex({globalOverrides:overrides,planOverrides}));
  function windowsFor(machine, generic = false) {
    const closed = [], windows = [];
    for (const [i,date] of dates.entries()) {
      const global = byMachine.get(`${machine.id}|${date}`);
      if (companyClosed.has(date) || CLOSED.has(global?.dayStatus)) { closed.push([origin+i*1440,origin+(i+1)*1440]); continue; }
      const workCenter = machine.workCenterMachines?.find(r=>r.isPrimary && r.workCenter?.isActive)?.workCenter
        || machine.workCenterMachines?.find(r=>r.workCenter?.isActive)?.workCenter;
      const profile = [machine.workingHourProfile,workCenter?.workingHourProfile].find(p=>active(p,date));
      let calendar = base;
      if (!generic && (profile || Array.isArray(global?.shiftOverrides) && global.shiftOverrides.length)) {
        const weekday = new Date(`${date}T00:00:00Z`).getUTCDay() || 7;
        const shifts = global?.shiftOverrides?.length ? global.shiftOverrides : profile.rules.filter(r=>r.isEnabled && r.dayOfWeek===weekday);
        const mapped = shifts.map(s=>{
          let finish=minutes(s.endTime);const begin=minutes(s.startTime);if(finish<=begin)finish+=1440;
          finish=Math.max(begin,finish-Number(s.breakMinutes||0)+Number(s.overtimeMinutes||0));
          return {start:s.startTime,end:`${String(Math.floor(finish/60)%24).padStart(2,'0')}:${String(finish%60).padStart(2,'0')}`,duration:finish-begin};
        }).filter(s=>s.duration>0);
        const rule={dayStatus:mapped.length?"WORKING":"OFF",shiftsPerDay:mapped.length,shifts:mapped};
        // Explicit master hours replace the fallback. Manual plan constraints
        // remain in the index; a holiday closure always wins above.
        calendar={...base,dailyOverrides:{...base.dailyOverrides,[date]:rule}};
      }
      const dayWindows=shiftWindows(machine,i,"OVERTIME",calendar,start);
      if (!dayWindows.length) closed.push([origin+i*1440,origin+(i+1)*1440]);
      windows.push(...dayWindows.map(w=>[origin+w.start,origin+w.end]));
    }
    // A night shift must stop at midnight when the following date is closed.
    return E.subtract(windows,closed).map(([a,b])=>[Math.max(origin,a),Math.min(end.getTime()/60000,b)]).filter(([a,b])=>b>a);
  }
  const machineWindows = new Map(machines.map(m=>[m.id,windowsFor(m)]));
  const windows = machines.length ? E.merge([...machineWindows.values()].flat()) : windowsFor({id:"__company__"},true);
  const closedDatesFor=spans=>dates.filter(d=>!spans.some(([a,b])=>a<E.at(d)+1440&&b>E.at(d)));
  return { windowsFor:m=>machineWindows.get(m.id)||[], closedDatesFor:m=>closedDatesFor(machineWindows.get(m.id)||[]), workingCalendar: {version:1,windows,closedDates:closedDatesFor(windows),source:"Working calendar, kalender tahunan, profil jam kerja dan kalender kapasitas"} };
}
module.exports = { buildCalendar };
