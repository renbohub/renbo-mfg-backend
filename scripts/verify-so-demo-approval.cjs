const assert=require('node:assert/strict');
const entry=require.resolve('../src/prisma/index');
require.cache[entry]={id:entry,filename:entry,loaded:true,exports:{prisma:{}}};
const clock=require('../src/prisma/utils/businessClock');
const approvals=require('../src/prisma/services/approvalRuleService');
const workflow=require('../src/prisma/services/sales/salesOrderWorkflowService');
function fixture(){
 const doc={id:'so-id',soNumber:'SO-TEST',status:'In Approval',details:[]};
 const request={id:'request',...workflow.KEY,documentType:'SalesOrderHeader',documentId:doc.id,status:'Pending',currentStep:1,requestedByUserId:'author',requestedBy:'author',actions:[],context:{source:'sales-order-workflow-v1',fingerprint:workflow.fingerprint(doc)},rule:{allowSelfApproval:false,requireSequential:true,steps:[1,2].map(n=>({id:'step'+n,stepOrder:n,requiredApprovals:1}))}};
 const tx={approvalRequest:{findFirst:async()=>request,findUnique:async()=>request,update:async({data})=>Object.assign(request,data)},approvalAction:{create:async({data})=>{request.actions.push(data);return data}},userRole:{findMany:async()=>[]},user:{findMany:async()=>[]},notification:{create:async({data})=>data}};
 return {doc,request,tx,user:{id:'author',username:'author',isSuperAdmin:true}};
}
async function main(){
 const normal=fixture();
 await assert.rejects(approvals.processApprovalAction({...normal,requestId:'request'}),/Self approval/);
 await clock.withBusinessDate('2026-08-20',async()=>{
  const f=fixture();let posted=0;
  const postConfirm=async()=>{posted++;return {...f.doc,status:'Confirmed'}};
  const first=await workflow.decide(f.tx,f.doc,f.user,'Approved',null,postConfirm);
  assert.equal(first.final,false);assert.equal(f.request.currentStep,2);assert.equal(posted,0);
  const second=await workflow.decide(f.tx,f.doc,f.user,'Approved',null,postConfirm);
  assert.equal(second.final,true);assert.equal(posted,1);
  assert.deepEqual(f.request.actions.map(a=>a.stepOrder),[1,2]);
  assert(f.request.actions.every(a=>a.metadata.demoApproval&&a.metadata.demoDate==='2026-08-20'));
  assert.equal(f.request.rule.allowSelfApproval,false);
  const other=fixture();other.request.pageCode='forecasts';
  await assert.rejects(approvals.processApprovalAction({...other,requestId:'request'}),/Self approval/);
  const denied=fixture();denied.user.isSuperAdmin=false;
  await assert.rejects(approvals.processApprovalAction({...denied,requestId:'request'}),/tidak termasuk approver/);
 });
 const distinct=fixture();distinct.request.requestedByUserId='other';distinct.request.requestedBy='other';distinct.request.currentStep=2;distinct.request.actions=[{action:'Approved',actedByUserId:'author',stepOrder:1}];
 await assert.rejects(workflow.decide(distinct.tx,distinct.doc,distinct.user,'Approved',null,async()=>{}),/pengguna yang berbeda/);
 const reset=fixture();await clock.withBusinessDate(null,()=>assert.rejects(approvals.processApprovalAction({...reset,requestId:'request'}),/Self approval/));
 assert.equal(clock.isDemoMode(),false);
 console.log('PASS: SO demo permits sequential self approval, records demo audit, retains permissions and normal-mode restrictions.');
}
main().catch(e=>{console.error(e);process.exitCode=1});
