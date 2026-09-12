const assert=require('node:assert/strict');
const {prisma}=require('../src/prisma');
const service=require('../src/prisma/services/planning/preparationService');
(async()=>{
  const rollback=Error('EXPECTED_TEST_ROLLBACK');
  try{await prisma.$transaction(async tx=>{
    const body={name:'Preparation verification only',month:'2026-09',delivery:[],production:[{id:'line1',partCode:'TEST-PART',uomCode:'PCS',resource:'TEST-MACHINE',shift:'1',materialOffsetDays:0,days:{'2026-09-01':123}}],material:[]};
    const created=await service.save(tx,body,'verification');assert.equal(created.revision,1);
    const loaded=await service.get(tx,created.id);assert.equal(loaded.payload.production[0].days['2026-09-01'],123);
    const updated=await service.save(tx,{...body,revision:1,name:'Updated verification'},'verification',created.id);assert.equal(updated.revision,2);
    await assert.rejects(()=>service.save(tx,{...body,revision:1},'verification',created.id),error=>error.statusCode===409);
    assert.equal((await service.get(tx,created.id)).name,'Updated verification');
    assert.ok((await service.list(tx,'2026-09')).some(row=>row.id===created.id));
    throw rollback;
  },{timeout:20000});}catch(error){if(error!==rollback)throw error;}
  console.log('PASS preparation persistence: create, reload, revision update, stale-write rejection; transaction rolled back');
})().catch(error=>{console.error(error.message);process.exitCode=1;}).finally(async()=>{await prisma.$disconnect();process.exit(process.exitCode||0);});
