process.env.NODE_ENV='test';
const assert=require('node:assert/strict');
const {buildProductionLots,machineWindows}=require('../src/prisma/services/planning/productionLotPlanService');
const {aggregate}=require('../src/prisma/services/planning/productionActualsService');
const scope=require('../src/prisma/services/planning/planningTransactionContext');
const {confirm,sourceFingerprint}=require('../src/prisma/services/planning/integratedPlanService');
const {Prisma}=require('@prisma/client');
const base={scheduleDate:'2026-10-02',machineId:'M1',shift:'1',partCode:'P1',processCode:'CUT',uomCode:'pcs',qty:100,minutes:60};
const lots=buildProductionLots([{...base,allocationId:'a',customerCode:'A',woNumber:'WO1'},{...base,allocationId:'b',customerCode:'B',woNumber:'WO2'},{...base,allocationId:'a',customerCode:'A',woNumber:'WO1'}]);
assert.equal(lots.lots.length,1);assert.equal(lots.lots[0].qty,200);assert.equal(lots.lots[0].allocations.length,2);
assert.equal(buildProductionLots([{...base,plannedStartTime:'08:00',plannedEndTime:'10:00'},{...base,plannedStartTime:'11:00',plannedEndTime:'12:00'}]).lots.length,1,'Downtime does not create a second lot');
const machine={shift1Start:'08:00',shift1End:'16:00',shift2Start:'16:00',shift2End:'24:00',shift3Start:'00:00',shift3End:'08:00'};
for(const [start,end,dates] of [['15:00','17:00',['2026-10-02','2026-10-02']],['23:00','01:00',['2026-10-02','2026-10-03']]]){
 const row={...base,allocationId:'cross',plannedStartTime:start,plannedEndTime:end,qty:101};const result=buildProductionLots([row],{windowsFor:r=>machineWindows(machine,r)});assert.equal(result.lots.length,2);assert.equal(result.lots.reduce((n,r)=>n+r.qty,0),101);assert.deepEqual(result.lots.map(r=>r.scheduleDate),dates);
}
assert.equal(buildProductionLots([{...base,machineId:null,vendorId:'V1',shift:null}]).exceptions.length,1);
assert.equal(buildProductionLots([{...base,scheduleDate:'2026-02-30'}]).lots.length,0);
assert.equal(buildProductionLots([{...base,qty:-1}]).exceptions.length,1);
const sourceSplit=buildProductionLots([{...base,allocationId:'source-split',plannedStartTime:'15:00',plannedEndTime:'17:00',qty:101,demandSources:[{sourceNumber:'SO1',qty:61},{sourceNumber:'SO2',qty:40}]}],{windowsFor:r=>machineWindows(machine,r)});
for (const [index,total] of [[0,61],[1,40]]) assert.equal(sourceSplit.lots.reduce((sum,lot)=>sum+lot.allocations[0].demandSources[index].qty,0),total,'Split source quantities are conserved');
const trace=buildProductionLots([{...base,allocationId:'up'},{...base,allocationId:'down',processCode:'PACK',predecessorAllocationIds:['up']}]);assert.deepEqual(trace.lots[1].predecessorLotKeys,[trace.lots[0].key]);
const actual=aggregate({machines:[{id:'M1',machineCode:'MC1'}],schedules:[{machineId:'M1',partCode:'P1',mbomProcess:{process:{processCode:'CUT'}},uomCode:'pcs',scheduleDate:'2026-10-02',plannedQty:100}],logs:[{machineCode:'MC1',processCode:'CUT',logDate:'2026-10-02',qtyGood:80,qtyReject:20,downtime:15,workOrder:{partCode:'P1',uomCode:'PCS'}}]},'2026-10');assert.equal(actual.rows.length,1);assert.equal(actual.rows[0].shortfall,20);assert.equal(actual.rows[0].ng,20);
async function transactions(){
 let state=[],effects=0;
 const raw={$transaction:async work=>{const copy=[...state];const tx={write:async x=>copy.push(x),read:async()=>[...copy]};const result=await work(tx);state=copy;return result;},read:async()=>[...state]};const db=scope.scopedClient(raw);
 const preview=await scope.atomic(db,async()=>{await db.write('preview');scope.afterCommit(()=>effects++);return db.read();},{preview:true});assert.deepEqual(preview,['preview']);assert.deepEqual(state,[]);assert.equal(effects,0);
 await assert.rejects(scope.atomic(db,async()=>{await db.write('failed');scope.afterCommit(()=>effects++);throw Error('rollback');}),/rollback/);assert.deepEqual(state,[]);assert.equal(effects,0);
 await scope.atomic(db,async()=>{await db.$transaction(tx=>tx.write('committed'));scope.afterCommit(()=>effects++);});assert.deepEqual(state,['committed']);assert.equal(effects,1);
 const concurrent=await Promise.all(['one','two'].map(name=>scope.atomic(db,async()=>{await db.write(name);await new Promise(resolve=>setTimeout(resolve,5));return db.read();},{preview:true})));assert.deepEqual(concurrent,[['committed','one'],['committed','two']]);assert.deepEqual(state,['committed']);
}
async function confirmations(){
 let reads=0;const tx={systemSetting:{findUnique:async()=>null}};
 for(const model of Prisma.dmmf.datamodel.models){const key=model.name[0].toLowerCase()+model.name.slice(1);tx[key]||={};tx[key].findMany=async()=>{reads++;return [];};}
 const db={$transaction:async work=>work(tx)};
 const digest=await sourceFingerprint(tx,'MONTH:2026-10');assert.match(digest,/^[a-f0-9]{64}$/);assert(reads>30,'Fingerprint covers routing, tooling, receipts and stock');
 await assert.rejects(confirm(db,{mpsNumber:'MONTH:2026-10',expectedFingerprint:'0'.repeat(64),operationId:'test-operation-1234'}),{code:'PLAN_SOURCE_CHANGED'});
 const crypto=require('node:crypto'),options={safetyDays:2,machineSelections:{}},requestHash=crypto.createHash('sha256').update(JSON.stringify(['MONTH:2026-10',digest,options])).digest('hex');
 tx.systemSetting.findUnique=async()=>({settingValue:JSON.stringify({requestHash,result:{mpsNumber:'MPS-TEST',mrpRunNumber:'MRP-TEST',plans:[{planNumber:'MPP-TEST'}]}})});
 const replay=await confirm(db,{mpsNumber:'MONTH:2026-10',expectedFingerprint:digest,operationId:'test-operation-1234'});assert.equal(replay.replayed,true);assert.equal(replay.mrpRunNumber,'MRP-TEST');
 await assert.rejects(confirm(db,{mpsNumber:'MONTH:2026-10',expectedFingerprint:digest,operationId:'test-operation-1234',safetyDays:3}),/berbeda/);
}
transactions().then(confirmations).then(()=>{console.log('PASS PPIC R3: lot identity, source trace, shift/midnight split, NG shortfall, preview rollback, failure rollback, nested transaction, concurrent isolation, stale review and idempotent replay.');process.exit(0);}).catch(error=>{console.error(error);process.exit(1);});
