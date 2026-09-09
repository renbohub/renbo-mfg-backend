const fail=(message,statusCode=400)=>{throw Object.assign(new Error(message),{statusCode});};
const text=value=>String(value??'').trim();
const ROUTING_INCLUDE={part:{select:{id:true,partCode:true,partName:true,itemType:true,rawType:true,category:true}},operations:{include:{workCenter:true},orderBy:{sequence:'asc'}}};
function routingInput(body,existing=null){
  if(!body||typeof body!=='object'||Array.isArray(body))fail('Isi routing harus berupa object yang valid.');
  const allowed=new Set(['routingCode','partId','revision','status','effectiveFrom','effectiveUntil','notes','operations','expectedUpdatedAt']);
  if(Object.keys(body||{}).some(key=>!allowed.has(key)))fail('Field routing tidak dikenal. Gunakan form routing terstruktur.');
  const merged={...(existing||{}),...body};
  const routingCode=text(merged.routingCode),partId=text(merged.partId),revision=text(merged.revision||'1'),status=text(merged.status||'DRAFT').toUpperCase();
  if(!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(routingCode)||!partId||!revision||revision.length>30)fail('Kode routing, part dan revisi wajib diisi dengan benar.');
  if(!['DRAFT','ACTIVE','INACTIVE'].includes(status))fail('Status routing harus DRAFT, ACTIVE atau INACTIVE.');
  const date=value=>{if(value===null||value===undefined||value==='')return null;const d=new Date(value);if(!Number.isFinite(d.getTime()))fail('Tanggal efektif routing tidak valid.');return d;};
  const effectiveFrom=date(merged.effectiveFrom),effectiveUntil=date(merged.effectiveUntil);
  if(effectiveFrom&&effectiveUntil&&effectiveUntil<effectiveFrom)fail('Tanggal berakhir harus setelah tanggal mulai.');
  const raw=body.operations??existing?.operations??[];
  if(!Array.isArray(raw)||raw.length>200||(status==='ACTIVE'&&!raw.length))fail('Routing aktif memerlukan operasi; maksimal 200 operasi.');
  const sequences=new Set();
  const operations=raw.map(row=>{
    if(!row||typeof row!=='object'||Array.isArray(row))fail('Setiap operasi routing harus berupa object proses yang valid.');
    const sequence=Number(row.sequence),processId=text(row.processId),workCenterId=text(row.workCenterId)||null;
    if(!Number.isSafeInteger(sequence)||sequence<1||sequence>99999||sequences.has(sequence))fail('Urutan proses harus bilangan bulat positif dan unik.');sequences.add(sequence);
    if(!processId)fail('Setiap operasi wajib memilih proses dari master.');
    const number=(key,fallback,max=Infinity)=>{const n=Number(row[key]??fallback);if(!Number.isFinite(n)||n<0||n>max)fail(`Nilai ${key} tidak valid.`);return n;};
    const flag=(key,fallback)=>{if(row[key]===undefined)return fallback;if(typeof row[key]!=='boolean')fail(`${key} harus boolean.`);return row[key];};
    return{sequence,processId,workCenterId,setupMinutes:number('setupMinutes',0),cycleSeconds:number('cycleSeconds',0),runMinutes:number('runMinutes',0),yieldPercent:number('yieldPercent',100,100),isSubcontract:flag('isSubcontract',false),isActive:flag('isActive',true),notes:text(row.notes).slice(0,2000)||null};
  }).sort((a,b)=>a.sequence-b.sequence);
  if(status==='ACTIVE'&&!operations.some(row=>row.isActive))fail('Routing aktif harus mempunyai operasi aktif.');
  return{data:{routingCode,partId,revision,status,effectiveFrom,effectiveUntil,notes:text(merged.notes).slice(0,2000)||null},operations};
}
async function findPart(db,key,purchaseOnly=false){
  const part=await db.part.findFirst({where:{OR:[{id:key},{partCode:key}],isDeleted:false},select:{id:true,partCode:true,partName:true,itemType:true,rawType:true,category:true,status:true}});
  if(!part)fail('Part tidak ditemukan.',404);
  if(part.status&&part.status!=='Active')fail('Part tidak aktif.',409);
  if(purchaseOnly&&(part.itemType!=='RAW'||part.rawType!=='PURCHASE_PART'))fail('Halaman ini untuk routing Purchase Part.',400);
  return part;
}
async function enrich(db,rows){
  const ids=[...new Set(rows.flatMap(row=>row.operations.map(op=>op.processId)).filter(Boolean))];
  const processes=ids.length?await db.process.findMany({where:{id:{in:ids}},select:{id:true,processCode:true,processName:true,isDeleted:true}}):[];
  return rows.map(row=>({...row,operations:row.operations.map(op=>({...op,process:processes.find(process=>process.id===op.processId)||null}))}));
}
async function listPartRoutings(db,key){const part=await findPart(db,key,true);const rows=await db.routingHeader.findMany({where:{partId:part.id,isDeleted:false},include:ROUTING_INCLUDE,orderBy:[{createdAt:'desc'}]});return{part,items:await enrich(db,rows)};}
async function validateReferences(tx,input){
  await findPart(tx,input.data.partId);
  const processIds=[...new Set(input.operations.map(row=>row.processId))];
  const processes=await tx.process.findMany({where:{id:{in:processIds},isDeleted:false},select:{id:true}});
  if(processes.length!==processIds.length)fail('Proses tidak ditemukan atau telah dinonaktifkan.');
  const centerIds=[...new Set(input.operations.map(row=>row.workCenterId).filter(Boolean))];
  if(centerIds.length&&(await tx.workCenter.count({where:{id:{in:centerIds},isActive:true}}))!==centerIds.length)fail('Work center tidak aktif atau tidak ditemukan.');
}
async function saveRouting(db,body,{key=null,partKey=null}={}){
  if(!body||typeof body!=='object'||Array.isArray(body))fail('Isi routing harus berupa object yang valid.');
  const result=await db.$transaction(async tx=>{
    let existing=null;
    if(key){
      existing=await tx.routingHeader.findFirst({where:{OR:[{id:key},{routingCode:key}],isDeleted:false},include:ROUTING_INCLUDE});
      if(!existing)fail('Routing master tidak ditemukan. Routing proyeksi BOM dikelola dari BOM.',404);
      await tx.$queryRaw`SELECT id FROM "tbl_routing_header" WHERE id = ${existing.id} FOR UPDATE`;
      existing=await tx.routingHeader.findUnique({where:{id:existing.id},include:ROUTING_INCLUDE});
      if(!existing||existing.isDeleted)fail('Routing tidak tersedia.',409);
      if(body.expectedUpdatedAt&&new Date(body.expectedUpdatedAt).getTime()!==new Date(existing.updatedAt).getTime())fail('Routing telah berubah; muat ulang sebelum menyimpan.',409);
      if(await tx.mBOMProcess.count({where:{routingOperationId:{in:existing.operations.map(row=>row.id)}}}))fail('Routing sudah ditautkan ke BOM. Buat routing/revisi baru agar referensi historis tetap utuh.',409);
    }
    let inputBody={...body};
    if(partKey){const part=await findPart(tx,partKey,true);if(existing&&existing.partId!==part.id)fail('Routing bukan milik part ini.',404);if(body.partId&&body.partId!==part.id)fail('Part routing tidak sesuai halaman.',400);inputBody.partId=part.id;}
    const input=routingInput(inputBody,existing);await validateReferences(tx,input);
    if(existing){
      if(input.data.partId!==existing.partId)fail('Part routing tidak dapat diganti. Buat routing baru.',409);
      await tx.routingOperation.deleteMany({where:{routingHeaderId:existing.id}});
      return tx.routingHeader.update({where:{id:existing.id},data:{...input.data,operations:{create:input.operations}},include:ROUTING_INCLUDE});
    }
    return tx.routingHeader.create({data:{...input.data,operations:{create:input.operations}},include:ROUTING_INCLUDE});
  },{isolationLevel:'Serializable'});
  return (await enrich(db,[result]))[0];
}
async function removeRouting(db,key,partKey=null){
  return db.$transaction(async tx=>{
    const row=await tx.routingHeader.findFirst({where:{OR:[{id:key},{routingCode:key}],isDeleted:false},include:{operations:{select:{id:true}}}});
    if(!row)fail('Routing master tidak ditemukan.',404);
    await tx.$queryRaw`SELECT id FROM "tbl_routing_header" WHERE id = ${row.id} FOR UPDATE`;
    if(partKey){const part=await findPart(tx,partKey,true);if(row.partId!==part.id)fail('Routing bukan milik part ini.',404);}
    if(await tx.mBOMProcess.count({where:{routingOperationId:{in:row.operations.map(op=>op.id)}}}))fail('Routing yang direferensikan BOM tidak dapat dihapus. Pertahankan untuk histori.',409);
    await tx.routingOperation.updateMany({where:{routingHeaderId:row.id},data:{isActive:false}});
    await tx.routingHeader.update({where:{id:row.id},data:{isDeleted:true,status:'INACTIVE'}});return{ok:true};
  },{isolationLevel:'Serializable'});
}
async function linkMbomProcess(db,id,body){
  if(!body||typeof body!=='object'||Array.isArray(body)||!Object.hasOwn(body,'routingOperationId')||Object.keys(body).some(key=>key!=='routingOperationId'))fail('Pilih operasi routing, atau kirim null untuk melepas tautan.');
  if(body.routingOperationId!==null&&(typeof body.routingOperationId!=='string'||!body.routingOperationId.trim()))fail('ID operasi routing tidak valid.');
  const routingOperationId=body.routingOperationId===null?null:body.routingOperationId.trim();
  return db.$transaction(async tx=>{
    let operation=null;
    if(routingOperationId){
      operation=await tx.routingOperation.findUnique({where:{id:routingOperationId},include:{routingHeader:true}});
      if(!operation)fail('Operasi routing tidak ditemukan.',404);
      // Match the header lock used by routing edits/removal so references cannot
      // appear while an editor is replacing operations on the same header.
      await tx.$queryRaw`SELECT id FROM "tbl_routing_header" WHERE id = ${operation.routingHeaderId} FOR UPDATE`;
      operation=await tx.routingOperation.findUnique({where:{id:routingOperationId},include:{routingHeader:true}});
      if(!operation?.isActive||operation.routingHeader?.isDeleted||operation.routingHeader?.status!=='ACTIVE')fail('Operasi dan header routing harus aktif.',409);
    }
    await tx.$queryRaw`SELECT id FROM "tbl_mbomprocess" WHERE id = ${id} FOR UPDATE`;
    const process=await tx.mBOMProcess.findFirst({where:{id,isDeleted:false},include:{process:true,mbomDetail:{include:{mbomHeader:true,part:true}}}});
    if(!process||!process.mbomDetail||process.mbomDetail.isDeleted||process.mbomDetail.mbomHeader?.isDeleted)fail('Proses BOM aktif tidak ditemukan.',404);
    if(operation){
      if(process.process?.isDeleted||!process.process||process.processId!==operation.processId)fail('Proses master pada routing harus sama dengan proses BOM.',400);
      if(!process.mbomDetail.partId||process.mbomDetail.partId!==operation.routingHeader.partId)fail('Routing harus milik part pada detail BOM yang ditautkan.',400);
      if(!process.mbomDetail.part||process.mbomDetail.part.isDeleted||(process.mbomDetail.part.status&&process.mbomDetail.part.status!=='Active'))fail('Part pada detail BOM tidak aktif.',409);
    }
    return tx.mBOMProcess.update({where:{id},data:{routingOperationId},include:{routingOperation:true,machine:true,process:true}});
  },{isolationLevel:'Serializable'});
}
module.exports={routingInput,findPart,enrich,listPartRoutings,saveRouting,removeRouting,linkMbomProcess,ROUTING_INCLUDE};
