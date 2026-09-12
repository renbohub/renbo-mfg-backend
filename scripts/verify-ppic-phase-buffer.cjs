const {test}=require('node:test'),assert=require('node:assert/strict');
const {distributeBuffer,splitMonthlyQuantity,readSplitMetadata}=require('../src/prisma/services/planning/ppicPhaseBuffer');
test('monthly rounds once and delivery count determines equal base divisions plus default remainder',()=>{
 assert.deepEqual(splitMonthlyQuantity(100123,10).quantities,[...Array(10).fill(10000),1000]);
 assert.deepEqual(splitMonthlyQuantity(100123,7).quantities,[...Array(7).fill(14000),3000]);
 assert.deepEqual(splitMonthlyQuantity(10123,10,'PCS',{roundInitial:false}).quantities,[...Array(10).fill(1000),123]);
 assert.deepEqual(splitMonthlyQuantity(10000,10).quantities,Array(10).fill(1000));
 assert.equal(splitMonthlyQuantity(117,7).monthlyQty,1000);
 assert.equal(splitMonthlyQuantity(117,7).quantities.reduce((a,b)=>a+b,0),1000);
 assert.throws(()=>splitMonthlyQuantity(10,1.5));
});
test('11 customer deliveries retain dates and their original need; monthly total is not inflated per phase',()=>{
 const rows=[0,0,0,8203,10000,10000,10000,10000,10000,10000,10000].map((qtyPlanned,i)=>({id:'D',qtyPlanned,_deliveryPhaseId:'p'+i,_deliveryTargetId:'t'+i,_deliveryDemandQty:10000,endDate:'2026-09-'+String(i+1).padStart(2,'0')}));
 const before=structuredClone(rows),out=distributeBuffer(rows,60000);
 assert.deepEqual(rows,before);assert.deepEqual(out.map(r=>r.qtyPlanned),[...Array(11).fill(12000),7000]);
 assert.equal(out.reduce((s,r)=>s+r.qtyPlanned,0),139000);
 assert.equal(Math.round(out.reduce((s,r)=>s+r.bufferQty,0)),60000);
 assert.equal(Math.round(out.reduce((s,r)=>s+r._productionRoundingQty,0)),797);
 assert.equal(out.at(-1)._ppicSplit.isRemainder,true);assert.equal(out.at(-1)._deliveryDemandQty,0);
 assert.equal(out.at(-1).endDate,rows.at(-1).endDate);
 assert.equal(out[0]._ppicSplit.stockCoveredQty,10000);assert.equal(out[3]._ppicSplit.requiredProductionQty,8203);
 const note='MPS [PPIC-SPLIT:'+encodeURIComponent(JSON.stringify(out[0]._ppicSplit))+']';
 assert.deepEqual(readSplitMetadata(note),out[0]._ppicSplit);
});
test('multiple FG finish splits of one delivery count as one division; works without buffer',()=>{
 const rows=[{qtyPlanned:5000,_deliveryTargetId:'a',_deliveryPhaseId:'a1'},{qtyPlanned:5000,_deliveryTargetId:'a',_deliveryPhaseId:'a2'},{qtyPlanned:10000,_deliveryTargetId:'b'}];
 const out=distributeBuffer(rows,0);assert.deepEqual(out.map(r=>r.qtyPlanned),[10000,10000]);assert.equal(out[0]._ppicSplit.deliveryCount,2);
});
test('continuous units retain exact monthly total, zero total remains empty',()=>{
 const out=distributeBuffer([{qtyPlanned:.1},{qtyPlanned:.2}],.123456,'KG');
 assert.equal(Math.round(out.reduce((s,r)=>s+r.qtyPlanned,0)*1e6),423456);
 assert.equal(distributeBuffer([{qtyPlanned:0}],0),null);
 assert.equal(readSplitMetadata('[PPIC-SPLIT:bad]'),null);
});
