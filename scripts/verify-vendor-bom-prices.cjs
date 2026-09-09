const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const env=require('dotenv').parse(fs.readFileSync(path.join(__dirname,'../.env')));
const {Pool}=require('pg'),{PrismaPg}=require('@prisma/adapter-pg'),{PrismaClient}=require('@prisma/client');
const pool=new Pool({connectionString:env.DATABASE_URL}),db=new PrismaClient({adapter:new PrismaPg(pool)});
const svc=require('../src/prisma/services/pricing/vendorBomPriceService');
const {legacyPriceValue}=require('../src/prisma/services/pricing/effectivePriceService');
const {withBusinessDate}=require('../src/prisma/utils/businessClock');
const rollback=new Error('ROLLBACK_VENDOR_BOM_TEST');
const rowInput=r=>({key:r.key,vendorId:r.vendorId,priceToken:r.priceToken,uomCode:r.uomCode||'PCS',...Object.fromEntries(svc.months.map(m=>[m,r[m]]))});
async function main(){
  const before=await db.vendorPriceList.findMany({include:{details:true},orderBy:{id:'asc'}});
  const fgs=await svc.fgList(db), fg=fgs.items.find(f=>f.partCode==='C003-0010-000');assert(fg);
  assert(fg.displayName.includes(fg.partNumber)&&fg.displayName.includes(fg.partName)&&fg.displayName.includes(fg.partCode));
  const bracket=fgs.items.find(f=>f.partCode==='C002-C004-000');assert(bracket.customerId,'Customer array on FG must prefill the single customer');
  const painting=await svc.preview(db,{fgPartId:bracket.id,pricingYear:2026,currencyCode:'IDR',customerId:bracket.customerId});
  assert.equal(painting.rows.find(r=>r.processCode==='PAINT').january,60,'FG customerCodes loads the correct existing Painting price');
  const input={fgPartId:fg.id,pricingYear:2026,currencyCode:'IDR',customerId:fg.customerId};
  const preview=await svc.preview(db,input);assert.equal(preview.bom.revision,7);
  assert.equal(preview.rows.length,2);assert(preview.rows.every(r=>r.part.id!==fg.id));
  const gsn=preview.rows.find(r=>r.processCode==='GSN');assert.equal(gsn.january,260);assert.equal(gsn.category,'OTHER');
  assert.equal(preview.rows.find(r=>r.processCode==='INSP-PACK').january,null,'Unpriced process must remain blank');
  const context=await svc.context(db,gsn.priceListId);assert.equal(context.fgPartId,fg.id);
  const noVendor=await svc.preview(db,{...input,vendorSelections:{[gsn.key]:null}});
  assert.equal(noVendor.rows.find(r=>r.key===gsn.key).vendorId,null,'Clearing a vendor must not silently choose a supplier');
  assert(noVendor.rows.find(r=>r.key===gsn.key).problem);
  const data=await svc.masters(db);const cloned=structuredClone(data);cloned.current=new Map(data.current);
  const root=structuredClone(data.current.get(fg.id)), detail=root.details.find(d=>d.partId===gsn.part.id), first=root.details.find(d=>d.mbomProcesses.some(r=>r.process?.processCode==='INSP-PACK'));
  detail.mbomProcesses=[{...structuredClone(first.mbomProcesses[0]),id:'SAME-PROCESS-OTHER-CHILD'}];cloned.current.set(fg.id,root);
  const graph=svc.graph(cloned,fg.id);assert.equal(graph.rows.length,2);assert.equal(new Set(graph.rows.map(r=>r.key)).size,2,'Same process on different children must stay separate');
  await assert.rejects(()=>svc.preview(db,{...input,fgPartId:'missing'}),/FG belum/);
  const legacy=before.find(p=>p.partId&&!fgs.items.some(f=>f.id===p.partId)&&p.id!==gsn.priceListId&&p.category==='INSPECTION');
  if(legacy)assert.equal((await svc.context(db,legacy.id)).readOnly,true);
  try{
    await db.$transaction(async tx=>{
      let p=await svc.preview(tx,input);const options={canCreate:true,canUpdate:true,actor:'rollback-verification'};
      const mk=rows=>({...input,bomFingerprint:p.bomFingerprint,rows});
      await assert.rejects(()=>svc.save(tx,{...mk([rowInput(p.rows[0])]),bomFingerprint:'stale'},options),e=>e.statusCode===409);
      await assert.rejects(()=>svc.save(tx,mk([{...rowInput(p.rows[0]),key:'forged-child|process'}]),options),/tidak berasal/);
      await assert.rejects(()=>svc.save(tx,mk([{...rowInput(p.rows[0]),priceToken:'stale'}]),options),e=>e.statusCode===409);
      const inspect=p.rows.find(r=>r.processCode==='INSP-PACK');
      await assert.rejects(()=>svc.save(tx,mk([{...rowInput(inspect),january:10}]),{canCreate:false,canUpdate:true}),e=>e.statusCode===403);
      await assert.rejects(()=>svc.save(tx,mk([{...rowInput(inspect),january:-1}]),options),/nol atau lebih/);
      // Existing non-BOM process pricing on the same child must survive editing the displayed process.
      const paint=await tx.vendorProcess.findUnique({where:{vendorProcessCode:'PAINT'}});
      await tx.vendorPriceList.update({where:{id:gsn.priceListId},data:{details:{create:{vendorProcessId:paint.id,uomCode:'PCS',january:999}}}});
      p=await svc.preview(tx,input);
      const selected=p.rows.map(r=>({...rowInput(r),january:r.processCode==='GSN'?270:0,june:r.processCode==='GSN'?310:null,september:r.processCode==='GSN'?330:null}));
      const result=await svc.save(tx,{...input,bomFingerprint:p.bomFingerprint,rows:selected},options);assert.equal(result.records.length,2);
      const saved=await tx.vendorPriceList.findMany({where:{id:{in:result.records.map(r=>r.id)}},include:{details:true}});
      assert(saved.every(r=>r.partId!==fg.id),'Canonical prices remain keyed by child part');
      const gsnRecord=saved.find(r=>r.partId===gsn.part.id);assert.equal(gsnRecord.vendorId,gsn.vendorId);assert.equal(gsnRecord.category,'OTHER');
      assert.equal(gsnRecord.details.find(d=>d.vendorProcessId===paint.id).january,999,'Unrelated process preserved');
      const rate=gsnRecord.details.find(d=>d.vendorProcessId===gsn.vendorProcessId);
      assert.equal(legacyPriceValue(rate,new Date('2026-08-01')),310);assert.equal(legacyPriceValue(rate,new Date('2026-10-01')),330);
      assert.equal(saved.find(r=>r.partId===inspect.part.id).details[0].january,0,'Zero price retained');
      await assert.rejects(()=>svc.save(tx,{...input,bomFingerprint:p.bomFingerprint,rows:selected},options),e=>e.statusCode===409,'Stale form must not overwrite saved values');
      const reloaded=await svc.preview(tx,{...input,recordId:gsnRecord.id});assert.equal(reloaded.rows.find(r=>r.processCode==='GSN').june,310);
      throw rollback;
    },{timeout:30000});
  }catch(error){if(error!==rollback)throw error;}
  const after=await db.vendorPriceList.findMany({include:{details:true},orderBy:{id:'asc'}});assert.deepEqual(after,before,'All test changes rolled back');
  console.log(JSON.stringify({ok:true,fg:fg.partCode,processes:preview.rows.map(r=>({part:r.part.partCode,process:r.processCode,january:r.january})),checks:'FG identity; revision; existing price; blank vs zero; separate children; legacy context; permissions; foreign rows; stale BOM/price; save/reload; retained processes; monthly inheritance; rollback',priceRecordsUnchanged:after.length},null,2));
}
withBusinessDate('2026-09-09',main).catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{await db.$disconnect();await pool.end()});
