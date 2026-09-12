require('dotenv').config({quiet:true});process.env.NODE_ENV='test';const assert=require('node:assert/strict');const {randomUUID}=require('node:crypto');const {prisma}=require('../src/prisma');const {linkMbomProcess}=require('../src/prisma/services/engineering/partRoutingService');const marker='QA-L02-'+randomUUID();const rollback=new Error('L02_ROLLBACK');
(async()=>{const host=new URL(process.env.DATABASE_URL).hostname;assert.ok(['localhost','127.0.0.1','::1'].includes(host),'Only run on the verified local database');let checks=0;try{await prisma.$transaction(async tx=>{
const sample=await tx.mBOMProcess.findFirst({where:{isDeleted:false,routingMode:'INHOUSE',mbomDetail:{isDeleted:false,part:{isDeleted:false}}},include:{mbomDetail:true}});assert.ok(sample);
const h=await tx.mBOMHeader.create({data:{noReg:marker,partId:sample.mbomDetail.partId,uomCode:sample.mbomDetail.uomCode}});
const d=await tx.mBOMDetail.create({data:{noReg:marker,partId:sample.mbomDetail.partId,qty:1,uomCode:sample.mbomDetail.uomCode,category:'inHouse'}});
const p=await tx.mBOMProcess.create({data:{noReg:marker,mbomDetailId:d.id,processId:sample.processId,sequence:10,cycleTime:4}});
const rh=await tx.routingHeader.create({data:{routingCode:marker,partId:d.partId,status:'ACTIVE',operations:{create:{sequence:10,processId:p.processId,yieldPercent:98,cycleSeconds:4}}},include:{operations:true}});
const client={$transaction:async fn=>fn(tx)};const saved=await linkMbomProcess(client,p.id,{routingOperationId:rh.operations[0].id,expectedUpdatedAt:p.updatedAt.toISOString()});assert.equal(saved.routingOperationId,rh.operations[0].id);checks++;
const reread=await tx.mBOMProcess.findUnique({where:{id:p.id},include:{routingOperation:true}});assert.equal(reread.routingOperation.yieldPercent,98);checks++;
await assert.rejects(()=>linkMbomProcess(client,p.id,{routingOperationId:null,expectedUpdatedAt:'2000-01-01'}),e=>e.statusCode===409);checks++;
const unlinked=await linkMbomProcess(client,p.id,{routingOperationId:null,expectedUpdatedAt:reread.updatedAt.toISOString()});assert.equal(unlinked.routingOperationId,null);checks++;
throw rollback;},{isolationLevel:'Serializable',timeout:30000});}catch(e){if(e!==rollback)throw e;}
assert.equal(await prisma.mBOMHeader.count({where:{noReg:marker}}),0);assert.equal(await prisma.routingHeader.count({where:{routingCode:marker}}),0);checks++;console.log('L02 routing-link DB checks: '+checks+'/5 PASS; all fixtures rolled back.');})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>prisma.$disconnect());
