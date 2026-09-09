"use strict";

const crypto = require("crypto");

const AUTOMATIC_NOTES = "Dibuat otomatis dari Sales Order";

function buildScheduleNumber(now = new Date(), uuid = crypto.randomUUID()) {
  const date = now.toISOString().slice(0, 10).replace(/-/g, "");
  return `DS-${date}-${uuid.slice(0, 8).toUpperCase()}`;
}

function phaseSchedules(details = []) {
  const groups = new Map();
  for (const row of details) {
    const phases = (row.deliveryTargets || []).filter(p => !p.isDeleted && p.status === 'ACTIVE');
    if (!phases.length || Math.abs(phases.reduce((sum,p) => sum + Number(p.qty), 0) - Number(row.qty)) > 0.000001) {
      throw Object.assign(new Error('Delivery phase SO harus lengkap dan total qty harus sama dengan qty item.'), {statusCode:400});
    }
    for (const phase of phases) {
      const date = new Date(phase.targetDate);
      if (!phase.targetDate || !Number.isFinite(date.getTime()) || !(Number(phase.qty) > 0)) throw Object.assign(new Error('Tanggal dan qty delivery phase SO tidak valid.'), {statusCode:400});
      const key = new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Jakarta',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
      if (!groups.has(key)) groups.set(key, {key,plannedDate:new Date(`${key}T00:00:00+07:00`),details:[]});
      groups.get(key).details.push({soDetailId:row.id,lineNumber:row.lineNumber,qty:Number(phase.qty),notes:[row.notes,`Delivery phase ${phase.phaseNumber} (${phase.id})`].filter(Boolean).join(' | ')});
    }
  }
  return [...groups.values()].sort((a,b)=>a.key.localeCompare(b.key));
}

async function syncAutomaticDeliverySchedule(tx, so, options = {}) {
  // Reload persisted targets: callers may still hold a document loaded before replaceDeliveryTargets.
  const lines = await tx.salesOrderDetail.findMany({where:{soNumber:so.soNumber,isDeleted:false},include:{deliveryTargets:{where:{isDeleted:false,status:'ACTIVE'}}},orderBy:{lineNumber:'asc'}});
  const groups = phaseSchedules(lines);
  const existing = await tx.deliverySchedule.findMany({
    where: {
      soNumber: so.soNumber,
      isDeleted: false,
      notes: AUTOMATIC_NOTES,
    }, include:{details:true}, orderBy:{createdAt:'asc'},
  });
  if (existing.some(s=>s.status!=='Scheduled'||s.pickedAt||s.packedAt||s.shippedAt||s.deliveredAt||s.actualDate||s.details.some(d=>d.qtyDelivered>0))) {
    throw Object.assign(new Error('Jadwal otomatis sudah diproses; delivery phase tidak boleh ditimpa.'),{statusCode:409});
  }
  const results=[],used=new Set();
  for (const group of groups) {
    const sameDay=existing.find(s=>!used.has(s.id)&&new Date(s.plannedDate).getTime()===group.plannedDate.getTime());
    const match=sameDay||existing.find(s=>!used.has(s.id));
    const data={plannedDate:group.plannedDate,deliveryAddress:so.shippingAddress||null,notes:AUTOMATIC_NOTES,details:{...(match?{deleteMany:{}}:{}),create:group.details}};
    if(match){used.add(match.id);results.push(await tx.deliverySchedule.update({where:{id:match.id},data,include:{details:true}}));}
    else results.push(await tx.deliverySchedule.create({data:{scheduleNumber:buildScheduleNumber(options.now,results.length===0?options.uuid:undefined),soNumber:so.soNumber,...data},include:{details:true}}));
  }
  const obsolete=existing.filter(s=>!used.has(s.id)).map(s=>s.id);
  if(obsolete.length)await tx.deliverySchedule.updateMany({where:{id:{in:obsolete}},data:{isDeleted:true}});
  return results;
}

module.exports = { AUTOMATIC_NOTES, buildScheduleNumber, phaseSchedules, syncAutomaticDeliverySchedule };
