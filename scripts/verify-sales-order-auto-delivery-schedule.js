const assert=require('node:assert/strict');
const {syncAutomaticDeliverySchedule,phaseSchedules}=require('../src/prisma/services/outgoing/automaticDeliveryScheduleService');
async function main(){
 const phase=(id,date,qty)=>({id,phaseNumber:1,status:'ACTIVE',targetDate:date,qty});
 const lines=[{id:'line1',lineNumber:1,qty:12,deliveryTargets:[phase('a','2026-09-01',5),phase('b','2026-09-10',7)]},{id:'line2',lineNumber:2,qty:3,deliveryTargets:[phase('c','2026-09-01',3)]}];
 const state=[];let next=0;
 const tx={salesOrderDetail:{findMany:async()=>lines},deliverySchedule:{findMany:async()=>state.filter(s=>!s.isDeleted),create:async({data})=>{const row={...data,id:String(++next),status:'Scheduled',details:data.details.create};state.push(row);return row},update:async({where,data})=>{const row=state.find(s=>s.id===where.id);Object.assign(row,data,{details:data.details.create});return row},updateMany:async({where,data})=>state.filter(s=>where.id.in.includes(s.id)).forEach(s=>Object.assign(s,data))}};
 const so={soNumber:'SO1',deliveryDate:new Date('2030-01-01'),soDate:new Date('2026-01-01'),details:[],shippingAddress:'A'};
 let result=await syncAutomaticDeliverySchedule(tx,so);
 assert.equal(result.length,2);assert.equal(result[0].plannedDate.toISOString(),'2026-08-31T17:00:00.000Z');assert.deepEqual(result.map(s=>s.details.reduce((n,d)=>n+d.qty,0)),[8,7]);
 const ids=result.map(s=>s.id);result=await syncAutomaticDeliverySchedule(tx,so);assert.deepEqual(result.map(s=>s.id),ids);assert.equal(state.length,2);
 lines[0].deliveryTargets=[phase('a','2026-09-01',12)];result=await syncAutomaticDeliverySchedule(tx,so);assert.equal(result.length,1);assert.equal(state.filter(s=>!s.isDeleted).length,1);assert.equal(result[0].details.reduce((n,d)=>n+d.qty,0),15);
 result[0].shippedAt=new Date();await assert.rejects(syncAutomaticDeliverySchedule(tx,so),/sudah diproses/);
 assert.throws(()=>phaseSchedules([{id:'missing',qty:1,deliveryTargets:[]}]),/phase/);
 assert.throws(()=>phaseSchedules([{id:'mismatch',qty:5,deliveryTargets:[phase('x','2026-09-01',2)]}]),/total qty/);
 console.log('PASS: persisted phases, quantities, Jakarta dates, repeat sync, obsolete schedules and shipped protection.');
}
main().catch(e=>{console.error(e);process.exitCode=1});
