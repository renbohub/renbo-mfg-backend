"use strict";
const E = require("../../../../../library/ppic-planning/engine");

// CP-SAT optimizes the initial machine queue with the same duration formula as
// the browser. A process may span shifts; every segment retains BOM precedence
// and reserves its physical machine and dies. Later edits never call this solver.
async function initialize(seed) {
  const candidate = E.calculate(seed);
  const scheduled = candidate.rows.filter(n => ["process", "vendor"].includes(n.kind) && Number.isFinite(n.planned.start) && n.planned.end > n.planned.start);
  if (!scheduled.length) return { status: "NO_SCHEDULABLE_PROCESSES", feasible: false, taskCount: 0 };
  const offset = Math.max(E.at(seed.horizonStart), Math.floor(Math.min(...scheduled.map(n=>n.planned.start))/1440)*1440 - 7*1440);
  const end = Math.min(E.at(seed.horizonEnd), Math.ceil(Math.max(...candidate.groups.map(g=>E.at(g.targetDate,17*60)), ...scheduled.map(n=>n.planned.end))/1440)*1440+7*1440);
  const graph = E.topology(candidate.rows), tasks = [], segments = new Map(), rowById=new Map(candidate.rows.map(n=>[n.id,n]));
  for (const n of scheduled) {
    const source = n.planned.segments.length ? n.planned.segments : [[n.planned.start,n.planned.end]];
    segments.set(n.id, source.map((s,i)=>({id:`${n.id}:${i}`,range:s})));
  }
  function predecessors(id) {
    const predecessor=segments.get(id);
    return predecessor?.length ? [predecessor.at(-1).id] : (graph.byId.get(id)?.dependencies||[]).flatMap(predecessors);
  }
  for (const n of scheduled) {
    const machine=n.machineOptions?.find(m=>m.machineId===n.machineId), diesId=machine?.diesId||n.diesId;
    const due=E.at(candidate.groups.find(g=>g.id===n.groupId).targetDate,17*60)-offset;
    segments.get(n.id).forEach((s,i,list)=>tasks.push({id:s.id,durationMinutes:Math.ceil(s.range[1]-s.range[0]),resourceId:n.kind==="process"?n.machineId:`external:${n.id}`,requiredResourceIds:n.kind==="process"&&diesId?[`dies:${diesId}`]:[],predecessorIds:i?[list[i-1].id]:n.dependencies.flatMap(predecessors),releaseMinute:0,dueMinute:due,baselineStartMinute:Math.round(s.range[0]-offset),...(n.kind==="vendor"?{fixedStartMinute:Math.round(s.range[0]-offset)}:{}),required:true,tardinessWeight:1000000,backwardWeight:1,movementWeight:2}));
  }
  const used=new Set(scheduled.filter(n=>n.kind==="process").map(n=>n.machineId));
  const blocks=seed.resources.filter(r=>used.has(r.id)).flatMap(r=>E.subtract([[offset,end]],E.subtract(r.windows,r.blocked||[])).map(([a,b])=>({resourceId:r.id,startMinute:Math.round(a-offset),durationMinutes:Math.round(b-a)})));
  const solved=await (await import("./solver/planningCpSatSolver.mjs")).solveFiniteSchedule({tasks,horizonMinutes:Math.round(end-offset),resourceBlockedIntervals:blocks,scheduleDirection:"BACKWARD",options:{maxTimeInSeconds:8,numSearchWorkers:2,randomSeed:1}});
  if (!solved.feasible) return { status: solved.status, feasible: false, taskCount: tasks.length };
  const byId=new Map(solved.tasks.map(t=>[t.id,t])),placements={};
  for(const n of scheduled){const spans=segments.get(n.id).map(s=>{const t=byId.get(s.id);return [offset+t.startMinute,offset+t.endMinute];});placements[n.id]={start:spans[0][0],end:spans.at(-1)[1],segments:spans};}
  // Procurement has no machine capacity. Re-derive its latest date from the
  // actual CP-SAT consumer slot, retaining calendar-vs-working-day semantics.
  for(const id of [...graph.ordered].reverse()){
    const n=rowById.get(id);if(placements[id])continue;
    if(n.kind==="fg"){placements[id]=n.planned;continue;}
    const successors=graph.successors.get(id).map(s=>placements[s]);
    if(["material","vendor"].includes(n.kind)&&successors.length&&successors.every(p=>Number.isFinite(p?.start))){const finish=Math.min(...successors.map(p=>p.start));placements[id]=E.externalPlacement(n,finish,true,seed.workingCalendar)||{error:"Hari kerja tidak cukup dalam horizon snapshot.",segments:[]};}
    else placements[id]=n.planned;
  }
  seed.initialSchedule=placements;
  seed.initialCalendarVersion=seed.workingCalendar?.version;
  return {status:solved.status,feasible:true,taskCount:tasks.length,wallTimeSeconds:solved.wallTimeSeconds||0,unplacedCount:candidate.rows.filter(n=>["process","vendor"].includes(n.kind)&&!Number.isFinite(n.planned.start)).length};
}
module.exports={initialize};
