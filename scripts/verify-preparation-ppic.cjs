const test=require('node:test'),assert=require('node:assert/strict');
const D=require('../src/prisma/services/planning/preparationDomain');
const M=require('../../renbo-mfg-frontend/public/js/ppic-preparation-model');
const empty=()=>({name:'Test',month:'2026-09',delivery:[],production:[],material:[]});
test('date and quantity validation rejects invalid and out-of-period edits',()=>{
  const w=empty();w.production=[{id:'p',partCode:'P',uomCode:'PCS',days:{'2026-09-31':1}}];assert.throws(()=>D.normalize(w),/tanggal/);
  w.production[0].days={'2026-09-01':-1};assert.throws(()=>D.normalize(w),/angka/);
  w.production[0].days={'2026-09-01':10};w.production[0].materialOffsetDays=1.5;assert.throws(()=>D.normalize(w),/hari bulat/);
});
test('material stock cannot be counted twice; separate units and owners stay separate',()=>{
  const row={id:'a',partCode:'STEEL',uomCode:'KG',openingStock:100,days:{}};const w=empty();w.material=[row,{...row,id:'b'}];assert.throws(()=>D.normalize(w),/digabung/);
  w.material[1].uomCode='PCS';assert.equal(D.normalize(w).material.length,2);
  w.material[1]={...row,id:'b',supplyType:'CUSTOMER_SUPPLIED',customerCode:'C1'};assert.equal(D.normalize(w).material.length,2);
});
test('later arrivals do not erase earlier shortages or double count daily deficits',()=>{
  const result=D.ledger('2026-09',0,{'2026-09-10':100},{'2026-09-02':40,'2026-09-03':10});
  assert.equal(result.maxShortage,50);assert.equal(result.firstShortageDate,'2026-09-02');assert.equal(result.closingBalance,50);
});
test('delivery groups share production once and preserve units',()=>{
  const w=empty();w.delivery=[{partCode:'P',uomCode:'PCS',days:{'2026-09-02':50}},{partCode:'P',uomCode:'PCS',days:{'2026-09-02':70}}];w.production=[{partCode:'P',uomCode:'PCS',days:{'2026-09-02':100}}];
  const result=D.deliveryBalance(w);assert.equal(result.length,1);assert.equal(result[0].maxShortage,20);
});
test('Excel paste parses Indonesian numbers atomically, never writes totals',()=>{
  const cols=M.columns('production','2026-09'),start=cols.findIndex(c=>c.field==='d01'),rows=M.flatten([M.blank('production','p')],'2026-09');
  const next=M.paste(rows,cols,0,start,'1.000\t2,5\n3\t4',()=>M.flatten([M.blank('production','new')],'2026-09')[0]);
  assert.equal(next[0].d01,1000);assert.equal(next[0].d02,2.5);assert.equal(next[1].d01,3);assert.equal(rows[0].d01,0);
  assert.throws(()=>M.paste(rows,cols,0,start,'10\t-2',()=>({})));assert.equal(rows[0].d01,0);
  assert.throws(()=>M.paste(rows,cols,0,cols.length-1,'10',()=>({})),/otomatis/);
  assert.throws(()=>M.quantity('=SUM(A1:A2)'));assert.equal(M.dates('2028-02').length,29);
});
test('flatten/inflate roundtrip retains schedule and simulation parameters',()=>{
  const rows=[{id:'a',partCode:'P',partName:'A',uomCode:'PCS',resource:'M1',shift:'2',materialOffsetDays:2,days:{'2026-09-01':12.5}}];assert.deepEqual(M.inflate(M.flatten(rows,'2026-09'),'production','2026-09'),rows);
});
test('JSONB key ordering never creates a false unsaved edit',()=>{assert.equal(M.stable({name:'Draft',days:{b:1,a:2}}),M.stable({days:{a:2,b:1},name:'Draft'}));});
