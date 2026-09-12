"use strict";
const { randomUUID, createHash } = require("node:crypto");
const day = value => value ? new Date(value).toISOString().slice(0, 10) : null;
const keyFor = row => JSON.stringify([row.mpsDetailId, row.deliveryTargetId, row.mbomDetailId, row.partCode, row.materialSupplyType, row.supplyCustomerCode, row.treePath]);
const round = value => Math.round(value * 1e6) / 1e6;

function deriveSchedule(requirements, allocations) {
  const byId = new Map(requirements.map(row => [row.id, row])), schedule = {}, exceptions = [];
  for (const row of requirements.filter(row => row.orderType === "Purchase" && row.grossRequirement > 0)) {
    const key = keyFor(row);
    if (schedule[key]) continue;
    let parent = byId.get(row.parentRequirementId), candidates = [], visited = new Set();
    while (parent && !visited.has(parent.id)) {
      visited.add(parent.id);
      candidates = allocations.filter(allocation => {
        const detail = allocation.plan?.details?.find(detail => detail.lineNumber === allocation.lineNumber);
        const ids = detail?.mrpRequirementIds || [detail?.mrpRequirementId];
        return ids.includes(parent.id) && (!parent.mbomDetailId || allocation.mbomProcess?.mbomDetailId === parent.mbomDetailId) && Number(allocation.plannedQty) > 0;
      });
      if (candidates.length) break;
      parent = byId.get(parent.parentRequirementId);
    }
    if (!candidates.length) { exceptions.push({ partCode: row.partCode, requirementId: row.id, reason: "Tanggal material belum terhubung dengan slot proses pemakai" }); continue; }
    // A component is consumed by the first operation of its producing stage.
    // Later operations and split lots do not consume the same material again.
    const firstSequence = Math.min(...candidates.map(a => Number(a.mbomProcess?.sequence) || 0));
    candidates = candidates.filter(a => (Number(a.mbomProcess?.sequence) || 0) === firstSequence);
    const dates = new Map();
    for (const allocation of candidates) { const date=day(allocation.vendorSendDate || allocation.scheduleDate); if(date)dates.set(date,(dates.get(date)||0)+Number(allocation.plannedQty)); }
    const sum=[...dates.values()].reduce((a,b)=>a+b,0);
    schedule[key]=[...dates].sort(([a],[b])=>a.localeCompare(b)).map(([date,qty])=>({date,weight:round(qty/sum)}));
  }
  return { schedule, exceptions };
}

function applySchedule(rows, schedule = {}) {
  const quantities = ["grossRequirement", "forecastQty", "soConsumedQty", "effectiveDemandQty", "bufferBaseQty", "bufferQty"];
  return rows.flatMap(row => {
    const slots = schedule[keyFor(row)];
    if (!slots?.length) return [row];
    const total=slots.reduce((sum,slot)=>sum+slot.weight,0), assigned={};
    if (!(total>0)) throw new Error("Invalid material schedule weights");
    return slots.map((slot,index)=>{
      const result={...row,id:index===0?row.id:randomUUID(),requiredDate:new Date(slot.date+'T00:00:00Z'),materialRequiredDate:new Date(slot.date+'T00:00:00Z'),scheduleSource:"INTEGRATED_PROCESS_SLOT"};
      for(const field of quantities){const full=Number(row[field]||0),value=index===slots.length-1?round(full-(assigned[field]||0)):round(full*slot.weight/total);result[field]=value;assigned[field]=(assigned[field]||0)+value;}
      return result;
    });
  });
}
function signature(schedule) {return createHash('sha256').update(JSON.stringify(Object.entries(schedule).sort(([a],[b])=>a.localeCompare(b)))).digest('hex');}
module.exports={deriveSchedule,applySchedule,signature,keyFor};
