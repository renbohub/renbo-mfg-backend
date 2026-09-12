'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const service=require('../src/prisma/services/planning/ppicWorkspaceReleaseService');
const domain=require('../../library/ppic-workspace/domain');
const copy=value=>JSON.parse(JSON.stringify(value));
const requestId='11111111-1111-4111-8111-111111111111',scenarioId='22222222-2222-4222-8222-222222222222';
function fresh(checks=[{id:'one',status:'OK',mandatory:true,reason:'Source confirmed'}]) {
  const bundle={version:2,policyVersion:service.POLICY_VERSION,sourceFingerprint:'source',month:'2026-09',scenario:{id:scenarioId,revision:3,payload:{seed:{nodes:[]},overrides:{}}},demand:[{id:'D1',dueAt:'2026-09-10T10:00:00Z',qty:100}],operations:[{id:'OP1',qty:100,planned:{start:10,end:20,segments:[[10,20]]}}],groups:[],checks};
  return {stale:false,scenarioId,scenarioName:'Test',month:'2026-09',scenarioRevision:3,sourceFingerprint:'source',bundleHash:service.bundleHash(bundle),checks,bundle};
}
const stored=review=>({id:requestId,scenario_id:scenarioId,month:'2026-09',revision:1,status:'SUBMITTED',submitted_actor_id:'planner',submitted_by:'Planner',scenario_revision:3,source_fingerprint:'source',bundle_hash:review.bundleHash,review:copy(review),created_at_utc:'2026-09-12T05:00:00.000Z',updated_at_utc:'2026-09-12T05:00:00.000Z'});
const row=stored(fresh());
test('server rejects self approval and release even for superadmin',()=>{
  for(const action of ['RETURN','APPROVE','RELEASE'])assert.throws(()=>service.assertDecision({...row,status:action==='RELEASE'?'APPROVED':'SUBMITTED'},action,{id:'planner',isSuperAdmin:true},fresh()),{code:'SELF_APPROVAL_FORBIDDEN',statusCode:403});
});
test('release requires approved state and approval requires submitted state',()=>{
  assert.throws(()=>service.assertDecision(row,'RELEASE',{id:'reviewer'},fresh()),{code:'RELEASE_STATE_CONFLICT'});
  assert.throws(()=>service.assertDecision({...row,status:'RETURNED'},'APPROVE',{id:'reviewer'},fresh()),{code:'RELEASE_STATE_CONFLICT'});
  assert.doesNotThrow(()=>service.assertDecision(row,'APPROVE',{id:'reviewer'},fresh()));
});
test('freshness, bundle and exact scenario revision are all required on server',()=>{
  for(const patch of [{stale:true},{scenarioRevision:4},{sourceFingerprint:'changed'},{bundleHash:'changed'}])assert.throws(()=>service.assertDecision(row,'APPROVE',{id:'reviewer'},{...fresh(),...patch}),{code:'RELEASE_SOURCE_CHANGED'});
});
test('mandatory unknown and blocker prevent approval; unapproved conditional cannot override them',()=>{
  for(const status of ['UNKNOWN','BLOCKER','CONDITIONAL']) {const review=fresh([{id:'required',status,mandatory:true,reason:'Evidence pending'}]);assert.throws(()=>service.assertDecision(stored(review),'APPROVE',{id:'reviewer'},review),{code:'RELEASE_BLOCKED'});}
  const empty=fresh([]);assert.throws(()=>service.assertDecision(stored(empty),'APPROVE',{id:'reviewer'},empty),{code:'RELEASE_BLOCKED'});
  assert.doesNotThrow(()=>service.assertDecision(row,'RETURN',{id:'reviewer'},null));
});
test('catalog never promotes official MPS PASS to independent scenario readiness',()=>{
  const workspace={readiness:['demand','bom-routing','material','resource','vendor'].map(id=>({id,status:'OK',issues:[],evidence:[]})),demand:{items:[{firm:true}]},source:{stale:false}};
  const record={stale:false,payload:{seed:{nodes:[{kind:'vendor'}]}}};
  const checks=service.inspect(workspace,record,{rows:[],groups:[]});
  assert.equal(checks.length,14);assert.equal(checks.find(c=>c.id==='bom').status,'UNKNOWN');assert.equal(checks.find(c=>c.id==='operator').status,'UNKNOWN');
  assert.equal(domain.evaluateReadiness(checks,{now:new Date().toISOString()}).canRelease,false);
  const forecast=service.inspect({...workspace,demand:{items:[{firm:false}]}},record,{rows:[],groups:[]});assert.equal(forecast.find(c=>c.id==='demand').status,'UNKNOWN');
});
test('mutations require individual submit/approve/release actions, scoped access and authentication',async()=>{
  const readOnly={id:'reader',listMenu:['mps','mrp','monthlyProductionPlan'].map(resource=>({resource,actions:['read']}))};
  await assert.rejects(()=>service.submit({}, {}, null),{statusCode:401});
  await assert.rejects(()=>service.submit({}, {}, readOnly),{code:'RELEASE_FORBIDDEN',statusCode:403});
  await assert.rejects(()=>service.decide({},'id','approve',{},readOnly),{code:'RELEASE_FORBIDDEN'});
  await assert.rejects(()=>service.list({}, {month:'2026-09',plant:'PLANT-A'},{id:'admin',isSuperAdmin:true}),{code:'PLANT_SCOPE_UNAVAILABLE'});
});

test('whole-bundle hash is deterministic but binds operations, checks, dates, quantities and policy',()=>{
  const original=fresh().bundle;
  const reordered=Object.fromEntries(Object.entries(copy(original)).reverse());
  reordered.evaluatedAt='2026-09-12T06:00:00Z';reordered.operations[0].elapsedMs=999;reordered.checks[0].evaluatedAt='2026-09-12T06:00:00Z';
  assert.equal(service.bundleHash(original),service.bundleHash(reordered));
  for(const mutate of [
    value=>{value.operations[0].planned.end=21;},
    value=>{value.operations[0].qty=200;},
    value=>{value.demand[0].dueAt='2026-09-11T10:00:00Z';},
    value=>{value.checks[0].status='UNKNOWN';},
    value=>{value.policyVersion='NEW_CALCULATION_POLICY';},
    value=>{value.demand[0].updatedAt='2026-09-12T06:00:00Z';},
    value=>{value.checks[0].mitigation={deadline:'2026-09-20T00:00:00Z',expiresAt:'2026-09-19T00:00:00Z',approvedAt:'2026-09-12T00:00:00Z'};}
  ]) {const changed=copy(original);mutate(changed);assert.notEqual(service.bundleHash(original),service.bundleHash(changed));}
});

test('changed computation cannot be hidden behind the old input-only hash or changed stored review',()=>{
  const reviewed=fresh(),changed=copy(reviewed);changed.bundle.operations[0].planned.end=999;
  assert.throws(()=>service.assertDecision(stored(reviewed),'APPROVE',{id:'reviewer'},changed),{code:'RELEASE_SOURCE_CHANGED'});
  const corrupted=stored(reviewed);corrupted.review.bundle.demand[0].qty=500;
  assert.throws(()=>service.assertDecision(corrupted,'APPROVE',{id:'reviewer'},reviewed),{code:'RELEASE_SOURCE_CHANGED'});
  const old=fresh();old.bundle.policyVersion='V1';old.bundleHash=service.bundleHash(old.bundle);
  assert.throws(()=>service.assertDecision(stored(old),'APPROVE',{id:'reviewer'},old),{code:'RELEASE_SOURCE_CHANGED'});
  const unknown=fresh([{id:'mandatory',status:'UNKNOWN',mandatory:true,reason:'Evidence absent'}]),inconsistent=copy(unknown);
  inconsistent.checks=[{id:'mandatory',status:'OK',mandatory:true,reason:'Unbound top-level check'}];
  assert.throws(()=>service.assertDecision(stored(unknown),'APPROVE',{id:'reviewer'},inconsistent),{code:'RELEASE_BLOCKED'});
});

const workspace=()=>({readiness:['demand','bom-routing','material','resource','vendor'].map(id=>({id,status:'OK',issues:[],evidence:[]})),demand:{items:[{firm:true}]},source:{fingerprint:'source',stale:false}});
test('actual engine placement errors are blockers while positive low spare is not lateness',()=>{
  const record={stale:false,payload:{seed:{nodes:[]}}};
  const rows=[{kind:'process',qty:100,planned:{error:'Machine unavailable',segments:[]}}];
  const missing=service.inspect(workspace(),record,{rows,groups:[]}).find(row=>row.id==='dependency');
  assert.equal(missing.status,'BLOCKER');assert.match(missing.reason,/1 aktivitas belum terjadwal/);
  const low=service.inspect(workspace(),record,{rows:[],groups:[{active:true,status:'risk',spareDays:1,targetSpareDays:1}]}).find(row=>row.id==='delivery');
  assert.equal(low.status,'UNKNOWN');assert.match(low.reason,/belum berarti terlambat/);
  const late=service.inspect(workspace(),record,{rows:[],groups:[{active:true,status:'late',targetSpareDays:-1}]}).find(row=>row.id==='delivery');
  assert.equal(late.status,'BLOCKER');
  const empty=service.inspect({...workspace(),demand:{items:[]}},record,{rows:[],groups:[]}).find(row=>row.id==='demand');assert.equal(empty.status,'UNKNOWN');
});

function captureFixture(patch={}) {
  const record={id:scenarioId,name:'Scenario',month:'2026-09',revision:3,sourceFingerprint:'seed-source',stale:false,payload:{seed:{nodes:[]},overrides:{}}};
  const currentRow={revision:3,month:'2026-09',source_fingerprint:'seed-source',source_data_fingerprint:'source',...patch};
  let readOnly=false,transactionOptions;
  const db={$transaction:async(fn,options)=>{transactionOptions=options;return fn({$executeRaw:async strings=>{readOnly=strings.join('').includes('READ ONLY');},$queryRaw:async()=>[currentRow]});}};
  return {db,record,dependencies:{getScenario:async()=>record,snapshot:async()=>workspace(),sourceFingerprint:async()=> 'source',calculate:()=>({rows:[],groups:[]})},assertSnapshot:()=>{assert.equal(readOnly,true);assert.equal(transactionOptions.isolationLevel,'RepeatableRead');}};
}
test('capture rechecks scenario revision and stored source fingerprint in the same final readonly snapshot',async()=>{
  const race=captureFixture({source_data_fingerprint:'older-source'});
  const review=await service.capture(race.db,scenarioId,{}, {id:'reader',isSuperAdmin:true},race.dependencies);
  race.assertSnapshot();assert.equal(review.stale,true);assert.equal(review.checks.find(check=>check.id==='version').status,'BLOCKER');
  const revision=captureFixture({revision:4});await assert.rejects(()=>service.capture(revision.db,scenarioId,{}, {id:'reader',isSuperAdmin:true},revision.dependencies),{code:'RELEASE_SOURCE_CHANGED'});
  const changed=captureFixture();changed.dependencies.sourceFingerprint=async()=> 'changed-after-workspace';await assert.rejects(()=>service.capture(changed.db,scenarioId,{}, {id:'reader',isSuperAdmin:true},changed.dependencies),{code:'RELEASE_SOURCE_CHANGED'});
});

test('raw PostgreSQL UTC text is used instead of the adapter-shifted Date object',()=>{
  const data=service.publicRow({...row,created_at:new Date('2026-09-12T12:45:00Z'),updated_at:new Date('2026-09-12T12:46:00Z'),created_at_utc:'2026-09-12T05:45:00.000Z',updated_at_utc:'2026-09-12T05:46:00.000Z'});
  assert.equal(data.createdAt,'2026-09-12T05:45:00.000Z');assert.equal(data.updatedAt,'2026-09-12T05:46:00.000Z');
});

function transactionDb(request,{failAudit=false,scenarioRevision=3,sourceDataFingerprint='source'}={}) {
  const db={state:{request:copy(request),baselines:[],logs:[]}};
  db.$queryRaw=async(strings,...values)=>{
    const sql=strings.join('?');
    if(sql.includes('WHERE o.operation_id=')) {const log=db.state.logs.find(row=>row.operationId===values[0]);return log?[{request_hash:log.hash,result:log.result,created_at_utc:request.created_at_utc,updated_at_utc:'2026-09-12T05:30:00.000Z'}]:[];}
    if(sql.includes('FROM tbl_ppic_workspace_scenario'))return [{revision:scenarioRevision,source_data_fingerprint:sourceDataFingerprint}];
    if(sql.includes('FROM tbl_ppic_released_baseline'))return copy(db.state.baselines);
    if(sql.includes('FROM tbl_ppic_release_operation'))return [];
    if(sql.includes('FROM tbl_ppic_release_request'))return [copy(db.state.request)];
    if(sql.startsWith('UPDATE tbl_ppic_release_request')) {db.state.request.status=values[0];db.state.request.revision++;if(values[1]==='APPROVE')db.state.request.approved_by=values[2];db.state.request.note=values[3];db.state.request.updated_at_utc='2026-09-12T05:30:00.000Z';return [copy(db.state.request)];}
    throw new Error(`Unexpected query: ${sql}`);
  };
  db.$executeRaw=async(strings,...values)=>{
    const sql=strings.join('?');
    if(sql.startsWith('INSERT INTO tbl_ppic_released_baseline')){db.state.baselines.push({id:values[0],bundle:JSON.parse(values[6]),hash:values[5]});return 1;}
    if(sql.startsWith('INSERT INTO tbl_ppic_release_operation')){if(failAudit)throw new Error('Audit write failed');db.state.logs.push({operationId:values[0],hash:values[2],action:values[3],result:JSON.parse(values[7])});return 1;}
    throw new Error(`Unexpected write: ${sql}`);
  };
  db.$transaction=async(fn,options)=>{assert.equal(options.isolationLevel,'Serializable');const before=copy(db.state);try{return await fn(db);}catch(error){db.state=before;throw error;}};
  return db;
}
const publisher={id:'publisher',username:'Publisher',isSuperAdmin:true},decisionBody={operationId:'publish_operation_1234',expectedRevision:1,note:'Verified release'};
test('publication stores the exact reviewed bundle even when fresh evaluation timing differs',async()=>{
  const review=fresh();review.bundle.checks[0].evaluatedAt='2026-09-12T05:00:00Z';review.bundleHash=service.bundleHash(review.bundle);
  const request={...stored(review),status:'APPROVED'},freshReview=copy(review);freshReview.bundle.checks[0].evaluatedAt='2026-09-12T05:30:00Z';
  const db=transactionDb(request),dependencies={capture:async()=>freshReview,sourceFingerprint:async()=> 'source'};
  const result=await service.decide(db,requestId,'RELEASE',decisionBody,publisher,dependencies);
  assert.equal(result.status,'RELEASED');assert.equal(db.state.baselines.length,1);assert.equal(db.state.logs.length,1);
  assert.deepEqual(db.state.baselines[0].bundle,request.review.bundle);assert.notDeepEqual(db.state.baselines[0].bundle,freshReview.bundle);
  const replay=await service.decide(db,requestId,'RELEASE',decisionBody,publisher,dependencies);
  assert.equal(replay.replayed,true);assert.equal(db.state.baselines.length,1);assert.equal(db.state.logs.length,1);
});

test('audit failure rolls back baseline, request state and log together; source/revision races publish nothing',async()=>{
  const review=fresh(),request={...stored(review),status:'APPROVED'},dependencies={capture:async()=>review,sourceFingerprint:async()=> 'source'};
  const failure=transactionDb(request,{failAudit:true});
  await assert.rejects(()=>service.decide(failure,requestId,'RELEASE',decisionBody,publisher,dependencies),/Audit write failed/);
  assert.equal(failure.state.request.status,'APPROVED');assert.equal(failure.state.request.revision,1);assert.equal(failure.state.baselines.length,0);assert.equal(failure.state.logs.length,0);
  for(const options of [{scenarioRevision:4},{sourceDataFingerprint:'new-source'}]) {const raced=transactionDb(request,options);await assert.rejects(()=>service.decide(raced,requestId,'RELEASE',decisionBody,publisher,dependencies),{code:'RELEASE_SOURCE_CHANGED'});assert.equal(raced.state.baselines.length,0);assert.equal(raced.state.request.status,'APPROVED');}
});

test('serialization/unique conflict replays only the committed actor-bound request hash',async()=>{
  for(const error of [{code:'P2034'},{code:'P2002'},{code:'P2010',meta:{code:'23505'}}]) {
    const db={$transaction:async()=>{throw error;},$queryRaw:async()=>[{request_hash:'actor-A-request',result:{status:'APPROVED',createdAt:'wrong',updatedAt:'wrong'},created_at_utc:'2026-09-12T05:00:00.000Z',updated_at_utc:'2026-09-12T05:30:00.000Z'}]};
    const replay=await service.consistent(db,async()=>null,{operationId:'operation-id',hash:'actor-A-request'});
    assert.equal(replay.replayed,true);assert.equal(replay.updatedAt,'2026-09-12T05:30:00.000Z');
    await assert.rejects(()=>service.consistent(db,async()=>null,{operationId:'operation-id',hash:'actor-B-request'}),{code:'OPERATION_ID_CONFLICT'});
  }
});

test('malformed release UUIDs fail before querying storage',async()=>{
  await assert.rejects(()=>service.get({},'-'.repeat(36),{},publisher),/Identitas paket/);
});

function scenarioEvidence() {return {materials:{rows:[{id:'M1',partCode:'RAW',grossQty:1123,onHandQty:1000,firmSupplyQty:0,plannedSupplyQty:0,shortageQty:123,uncoveredQty:123,needBy:'2026-09-10T08:00:00+07:00',status:'BLOCKER',issues:[],supplies:[]}]},capacity:{resources:[{id:'R1',code:'Machine',operationIds:['OP1'],availableMinutes:480,existingMinutes:0,plannedMinutes:100,unscheduledOperationIds:[],issues:[]}],conflicts:[],issues:[]}};}
test('release uses actual edited-scenario material and interval evidence instead of official MPS status',()=>{
  const result={rows:[{id:'OP1',kind:'process',qty:1123,uom:'PCS',machineId:'R1',planned:{start:1,end:101}},{id:'FG1',kind:'fg',qty:1123,uom:'PCS'}],groups:[]},record={stale:false,payload:{seed:{nodes:[]},overrides:{FG1:{qty:1123}}}},analysis=scenarioEvidence();
  const checks=service.inspect(workspace(),record,result,analysis);
  assert.equal(checks.find(row=>row.id==='material').status,'BLOCKER');assert.equal(checks.find(row=>row.id==='material').evidence[0].shortageQty,123);
  assert.equal(checks.find(row=>row.id==='machine').status,'OK');assert.equal(checks.find(row=>row.id==='bom').status,'UNKNOWN');assert.equal(checks.find(row=>row.id==='operator').status,'UNKNOWN');
  analysis.capacity.conflicts=[{type:'MACHINE_OVERLAP',resourceId:'R1'}];assert.equal(service.inspect(workspace(),record,result,analysis).find(row=>row.id==='machine').status,'BLOCKER');
  analysis.capacity.conflicts=[];analysis.capacity.resources[0].availableMinutes=null;assert.equal(service.inspect(workspace(),record,result,analysis).find(row=>row.id==='machine').status,'UNKNOWN');
  analysis.materials.rows[0]={...analysis.materials.rows[0],grossQty:null,onHandQty:null,shortageQty:null,uncoveredQty:null,status:'UNKNOWN'};
  const unknown=service.inspect(workspace(),record,result,analysis);assert.equal(unknown.find(row=>row.id==='material').status,'UNKNOWN');assert.equal(unknown.find(row=>row.id==='incoming').status,'UNKNOWN');
});
test('manual integer adjustments are valid quantity shapes; fractional discrete units block release',()=>{
  const record={payload:{seed:{nodes:[]},overrides:{FG1:{qty:1123}}}},result={rows:[{id:'FG1',kind:'fg',partCode:'FG',qty:1123,uom:'PCS'}],groups:[]};
  const valid=service.inspect(workspace(),record,result).find(row=>row.id==='quantity');assert.equal(valid.status,'UNKNOWN');assert.equal(valid.evidence[0].quantityShapeValid,true);assert.equal(valid.evidence[0].manuallyAdjusted,true);assert.match(valid.reason,/1123/);
  for(const qty of [1123.5,-1,NaN]) {const invalid=service.inspect(workspace(),record,{...result,rows:[{...result.rows[0],qty}]}).find(row=>row.id==='quantity');assert.equal(invalid.status,'BLOCKER');}
  const missing=service.inspect(workspace(),record,{...result,rows:[{...result.rows[0],uom:null}]}).find(row=>row.id==='quantity');assert.equal(missing.status,'BLOCKER');
});
test('inactive vendor work is not required and forecast unknown cannot hide a known demand blocker',()=>{
  const record={payload:{seed:{nodes:[{kind:'vendor',qty:10}]},overrides:{}}};
  assert.equal(service.inspect(workspace(),record,{rows:[{kind:'vendor',qty:0}],groups:[]}).find(row=>row.id==='vendor').status,'NA');
  assert.equal(service.inspect(workspace(),record,{rows:[{kind:'vendor',qty:10}],groups:[]}).find(row=>row.id==='vendor').status,'UNKNOWN');
  const source=workspace();source.demand.items=[{firm:false}];source.readiness.find(row=>row.id==='demand').status='BLOCKER';source.readiness.find(row=>row.id==='demand').issues=['Source line invalid'];
  const check=service.inspect(source,record,{rows:[],groups:[]}).find(row=>row.id==='demand');assert.equal(check.status,'BLOCKER');assert.match(check.reason,/Source line invalid/);
});
