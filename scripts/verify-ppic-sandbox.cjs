const {test}=require('node:test');const assert=require('node:assert/strict');
const {buildGraph}=require('../src/prisma/services/planning/ppicSandboxService');
const E=require('../../library/ppic-planning/engine');
test('snapshot preserves repeated BOM occurrences, stable IDs and full-quantity precedence',()=>{
  const req=(id,parent,part,path,detail,qty=100)=>({id,parentRequirementId:parent,rootRequirementId:'R',partCode:part,fgPartCode:'FG',treePath:path,mbomDetailId:detail,netRequirement:qty,grossRequirement:qty,orderType:part==='RAW'?'Purchase':'Production',requiredDate:'2026-09-10',targetDeliveryDate:'2026-09-11',deliveryTargetId:'target',mpsDetailId:'mps-detail'});
  const requirements=[req('R',null,'FG','root',null),req('A','R','WIP','root.1','bomA'),req('B','R','WIP','root.2','bomB'),req('RA','A','RAW','root.1.1','rawA'),req('RB','B','RAW','root.2.1','rawB')];
  const route=id=>({id,mbomDetailId:id==='a'?'bomA':'bomB',sequence:1,cycleTime:3,routingMode:'INHOUSE',process:{processName:'Press'}});
  const policies=new Map(['a','b'].map(id=>[id,{primaryMachineId:'M',resources:[{machineId:'M',cycleTimeSeconds:3}],errors:[]}]));
  const graph=buildGraph(requirements,[route('a'),route('b')],policies);E.topology(graph.nodes);
  const materialIds=graph.nodes.filter(n=>n.kind==='material').map(n=>n.id);
  for(const op of graph.nodes.filter(n=>n.kind==='process'))for(const id of materialIds)assert.ok(op.dependencies.includes(id),'Every first process waits for all FG materials');
  assert.equal(graph.groups.length,1);assert.equal(graph.nodes.filter(n=>n.kind==='material').length,2);assert.equal(graph.nodes.filter(n=>n.kind==='process').length,2);assert.equal(graph.nodes.find(n=>n.kind==='fg').dependencies.length,2);
  const revised=requirements.map(r=>({...r,id:r.id+'new',parentRequirementId:r.parentRequirementId?r.parentRequirementId+'new':null}));
  assert.deepEqual(buildGraph(revised,[route('a'),route('b')],policies).nodes.map(n=>n.id),graph.nodes.map(n=>n.id));
});
test('FG need uses completion date, not the MRP production start',()=>{
 const graph=buildGraph([{id:'r',partCode:'FG',grossRequirement:10,netRequirement:10,bufferQty:2,requiredDate:'2026-09-10',productionRequiredDate:'2026-09-01',targetDeliveryDate:'2026-09-11',treePath:'r',customerPegging:[{qty:20}]}],[],new Map());
 assert.equal(graph.groups[0].targetDate,'2026-09-10');assert.equal(graph.groups[0].customerProductionQty,8);assert.equal(graph.groups[0].stockCoveredQty,12);
});
test('missing routing cannot become a feasible FG through an empty dependency list',()=>{
  const graph=buildGraph([{id:'r',partCode:'FG',grossRequirement:100,netRequirement:100,requiredDate:'2026-09-10',treePath:'r'}],[],new Map());
  const missing=graph.nodes.find(n=>n.title==='Routing belum tersedia');assert.ok(missing);assert.deepEqual(graph.nodes.find(n=>n.kind==='fg').dependencies,[missing.id]);
});
test('covered subassembly retains its firm receipt gate and skips producing its children',()=>{
  const rows=[{id:'r',partCode:'FG',grossRequirement:100,netRequirement:100,requiredDate:'2026-09-10',treePath:'r'},{id:'s',parentRequirementId:'r',partCode:'SUB',grossRequirement:100,netRequirement:0,firmSupplyQty:100,requiredDate:'2026-09-10',treePath:'r.s',supplyTimeline:[{qty:100,status:'CONFIRMED',availableDate:'2026-09-12'}]},{id:'raw',parentRequirementId:'s',partCode:'RAW',grossRequirement:100,netRequirement:100,requiredDate:'2026-09-10',treePath:'r.s.raw',orderType:'Purchase'}];
  const graph=buildGraph(rows,[],new Map());assert.equal(graph.nodes.length,2);const stock=graph.nodes.find(n=>n.coverageOnly);assert.equal(stock.firmAvailableDate,'2026-09-12');assert.deepEqual(graph.nodes.find(n=>n.kind==='fg').dependencies,[stock.id]);
});
