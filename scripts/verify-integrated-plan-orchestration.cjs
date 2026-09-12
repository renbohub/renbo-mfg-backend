process.env.NODE_ENV='test';
const assert=require('node:assert/strict');
const {Prisma}=require('@prisma/client');
const clone=value=>structuredClone(value);
let state={doc:{id:'mps',mpsNumber:'MPS-TEST',sourceKey:'MONTH:2026-10',status:'Draft',periodStart:new Date('2026-10-01'),periodEnd:new Date('2026-10-31'),revision:1},runs:[],requirements:[],allocations:[],plans:[],settings:[]};
let active,blocked=false;
function transaction(copy){
  const tx={};for(const model of Prisma.dmmf.datamodel.models)tx[model.name[0].toLowerCase()+model.name.slice(1)]={findMany:async()=>[]};
  Object.assign(tx.mPS,{findFirst:async()=>copy.doc,findUnique:async()=>copy.doc,findMany:async()=>[copy.doc]});
  tx.planningBaselineLock.findFirst=async()=>null;
  tx.mRPRun.findMany=async()=>copy.runs;
  tx.mRPRequirement.findMany=async args=>copy.requirements.filter(row=>!args.where?.orderType||row.orderType===args.where.orderType);
  tx.productionPlanAllocation.findMany=async()=>copy.allocations;
  tx.monthlyProductionPlan.findMany=async()=>copy.plans;
  tx.monthlyProductionPlan.findUnique=async args=>copy.plans.find(plan=>plan.planNumber===args.where.planNumber);
  tx.monthlyProductionPlan.update=async args=>Object.assign(copy.plans.find(plan=>plan.planNumber===args.where.planNumber),args.data);
  Object.assign(tx.systemSetting,{findMany:async()=>[],findUnique:async args=>copy.settings.find(row=>row.settingKey===args.where.settingKey),create:async args=>{copy.settings.push(args.data);return args.data;}});
  return tx;
}
const db={$transaction:async work=>{const copy=clone(state);active=copy;try{const result=await work(transaction(copy));state=copy;return result;}finally{active=null;}}};
function stub(relative,exports){require.cache[require.resolve(relative)]={id:require.resolve(relative),filename:require.resolve(relative),loaded:true,exports};}
stub('../src/prisma/services/planning/periodClosingService',{assertPeriodOpen:async()=>{}});
stub('../src/prisma/services/planning/monthlyPlanningService',{syncMonthlyMps:async()=>({docs:[active.doc]})});
stub('../src/prisma/services/planning/mpsAutomaticEvaluationService',{runAutomaticMpsEvaluation:async()=>({status:'COMPLETED'})});
stub('../src/prisma/services/planning/mpsWorkbenchService',{getMpsWorkbench:async()=>({mps:active.doc,items:[{partCode:'FG',components:[],phases:[]}],rccp:{approvalAllowed:true},deliveryGate:{officialGateStatus:'OFFICIAL'}})});
stub('../src/prisma/controllers/planning/MPSController',{confirm:async(req,res)=>{active.doc.status='Confirmed';res.json(active.doc);}});
const timing=require('../src/prisma/services/planning/integratedMaterialSchedule');
const netting=require('../src/prisma/services/planning/timePhasedNettingService');
stub('../src/prisma/controllers/planning/MRPController',{
  runMRP:async(req,res)=>{
    const run={id:String(active.runs.length+1),runNumber:'MRP-'+(active.runs.length+1),planRevision:active.runs.length+1,isCurrentPlan:false};active.runs.push(run);
    const parent={id:'parent-'+run.id,orderType:'Production',mbomDetailId:'child',partCode:'FG'};
    const raw={id:'raw-'+run.id,runNumber:run.runNumber,parentRequirementId:parent.id,orderType:'Purchase',mbomDetailId:'raw',partCode:'STEEL',mpsDetailId:'fg',deliveryTargetId:'phase',treePath:'1.1',materialSupplyType:'SUPPLIER_PURCHASE',grossRequirement:100,effectiveDemandQty:100,requiredDate:new Date('2026-10-08'),part:{baseUomCode:'KG',partBases:[]}};
    const purchase=timing.applySchedule([raw],req.body.integratedMaterialSchedule);
    const net=netting.netTimePhasedDemand({openingQty:20,supplyEvents:[{availableDate:'2026-10-08',qty:80,confidence:'FIRM'}],demandEvents:purchase.map(row=>({id:row.id,requiredDate:row.requiredDate,qty:row.grossRequirement}))});
    purchase.forEach(row=>{row.netRequirement=net.find(n=>n.id===row.id).netRequirement;});active.requirements=[parent,...purchase];res.json(run);
  },
  prepareProductionPreview:async()=>{},approve:async(req,res)=>{for(const run of active.runs)run.isCurrentPlan=run.runNumber===req.params.runNumber;res.json(active.runs.at(-1));},
  buildMaterialPlanningRules:()=>({planningUomByPartCode:{STEEL:'KG'}})
});
stub('../src/prisma/controllers/planning/MonthlyProductionPlanController',{
  createFromMps:async(req,res)=>{
    const parent=active.requirements.find(row=>row.orderType==='Production');
    const plan={id:'plan',planNumber:'MPP-TEST',status:'Draft',details:[{lineNumber:1,partCode:'FG',mrpRequirementIds:[parent.id],mrpRootRequirementId:parent.id}]};active.plans=[plan];
    active.allocations=[{id:'allocation',plan,planNumber:plan.planNumber,lineNumber:1,mbomProcess:{mbomDetailId:'child',sequence:1,process:{processCode:'CUT'}},machineId:'M1',machine:{machineCode:'MC1',shift1Start:'08:00',shift1End:'16:00'},scheduleDate:new Date('2026-10-06'),shift:'1',plannedStartTime:'08:00',plannedEndTime:'09:00',plannedQty:100,uomCode:'PCS',customerTargetDate:new Date('2026-10-09'),predecessorAllocationIds:[]}];
    res.json({items:[{...plan,capacityRecommendation:{ready:!blocked,error:blocked?'Fixture capacity conflict':null}}]});
  }
});
const service=require('../src/prisma/services/planning/integratedPlanService');
(async()=>{
  const before=clone(state),preview=await service.review(db,{mpsNumber:'MONTH:2026-10'});
  assert.deepEqual(state,before,'Preview rolls back every generated stage');assert.equal(preview.materialTimingStatus,'CONSISTENT');assert.equal(preview.materials[0].netRequirement,80);assert.equal(preview.materials[0].requiredDate.toISOString().slice(0,10),'2026-10-06');assert.equal(preview.lots.length,1);
  const request={mpsNumber:'MONTH:2026-10',expectedFingerprint:preview.fingerprint,operationId:'orchestration-confirm-0001'};
  const result=await service.confirm(db,request);assert.equal(result.planningRevision,preview.planningRevision);assert.equal(state.runs.filter(run=>run.isCurrentPlan).length,1);assert.equal(state.plans.length,1);assert.equal(state.settings.length,1);assert.equal(state.plans[0].recommendationSummary.integratedRevision.mrpRunNumber,result.mrpRunNumber);
  const committed=clone(state);assert.equal((await service.confirm(db,request)).replayed,true);assert.deepEqual(state,committed,'Repeat confirmation writes nothing');
  const next=await service.review(db,{mpsNumber:'MONTH:2026-10'});blocked=true;await assert.rejects(service.confirm(db,{mpsNumber:'MONTH:2026-10',expectedFingerprint:next.fingerprint,operationId:'orchestration-failure-0002'}),{code:'CAPACITY_CALCULATION_FAILED'});assert.deepEqual(state,committed,'Failure after MRP approval rolls back all stages');
  console.log('PASS integrated orchestration fixture: dated material/slot convergence, atomic revision metadata, single current MRP, preview cancellation, repeat confirmation and rollback after downstream failure.');
})().then(()=>process.exit(0)).catch(error=>{console.error(error);process.exit(1);});
