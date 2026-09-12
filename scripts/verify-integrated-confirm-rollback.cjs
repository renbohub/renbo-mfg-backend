// Exercise final confirmation without permitting a database commit, even if
// every gate succeeds. Uses the existing local data and preserves all records.
process.env.NODE_ENV='test';
const assert=require('node:assert/strict'),fs=require('node:fs'),crypto=require('node:crypto');
const {prisma}=require('../src/prisma/index');
const service=require('../src/prisma/services/planning/integratedPlanService');
(async()=>{
  const doc=await prisma.mPS.findFirst({where:{isDeleted:false,sourceKey:{startsWith:'MONTH:'},status:{in:['Draft','Confirmed']}},orderBy:{periodStart:'desc'}});assert(doc);
  const before=await service.sourceFingerprint(prisma,doc.mpsNumber);let completed=false,result,error;
  const sentinel=new Error('TEST_FORCED_ROLLBACK');
  const neverCommit={$transaction:async(callback,options)=>prisma.$transaction(async tx=>{result=await callback(tx);completed=true;throw sentinel;},options)};
  try{await service.confirm(neverCommit,{mpsNumber:doc.mpsNumber,expectedFingerprint:before,operationId:crypto.randomUUID(),user:{username:'ppic-r3-verification'}});}catch(failure){error=failure;}
  assert(error,'No final confirmation may commit in this check');
  assert.equal(await service.sourceFingerprint(prisma,doc.mpsNumber),before,'Rejected/forced-rollback confirmation must preserve all source and planning records');
  const evidence={mpsNumber:doc.mpsNumber,committed:false,pipelineReachedEnd:completed,code:error.code||error.message,message:error.message,sourceUnchanged:true};
  fs.mkdirSync('../output/ppic-r3',{recursive:true});fs.writeFileSync('../output/ppic-r3/confirm-rollback.json',JSON.stringify(evidence,null,2));
  console.log('PASS integrated confirmation rollback:',JSON.stringify(evidence));
})().then(()=>process.exit(0)).catch(error=>{console.error(error.stack);process.exit(1);});
