const crypto = require('crypto');
const { userHasPermission } = require('../ai/permissionEvaluator');
const TYPES = {
  CUSTOMER_MASTER: { model: 'customer', resource: 'customers', code: 'customerCode', name: 'customerName', fields: ['customerCode','customerName','contact','phone','email','billingAddress','shippingAddress','currencyCode','paymentTerms','taxId','notes'] },
  PRODUCT_MASTER: { model: 'part', resource: 'parts', code: 'partCode', name: 'partName', fields: ['partCode','partNumber','partName','customerCode','baseUomCode','salesUomCode','model','variant','notes'] },
};
const fail = (message,statusCode=400) => Object.assign(new Error(message),{statusCode});
const key = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g,'');
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function config(type) { if (!TYPES[type]) throw fail('Jenis import master tidak didukung.'); return TYPES[type]; }
function permission(user,type,action) { const c=config(type); if (!userHasPermission(user,{resourceCode:c.resource,moduleCode:'master-data',pageCode:c.resource,action})) throw fail(`Akses ${action} master ${c.resource} diperlukan.`,403); }
function normalizeRow(raw,index,type) {
  const c=config(type), source=raw?.sourceJson || raw?.data || raw;
  const row={ sheetName:String(raw?.sheetName || 'Master'), rowNumber:Number(raw?.rowNumber || index+2), operation:'', code:'', data:{}, errors:[], sourceJson:source };
  if (!source || typeof source!=='object' || Array.isArray(source)) { row.errors.push('Baris harus berupa object.');return row; }
  const allowed=new Map(c.fields.map(field=>[key(field),field]));allowed.set('operation','operation');
  for (const [column,input] of Object.entries(source)) {
    if (column==='__excelProvenance') continue; // Workbook parser metadata is retained in sourceJson, never mapped to a master field.
    if (input == null || String(input).trim()==='') continue;
    const field=allowed.get(key(column));
    if (!field) { row.errors.push(`Kolom ${column} tidak dikenal; gunakan template master.`);continue; }
    if (typeof input==='object') { row.errors.push(`Kolom ${column} harus berupa teks.`);continue; }
    const value=String(input).trim();
    if (value.length>2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {row.errors.push(`Nilai ${column} terlalu panjang/tidak valid.`);continue;}
    if (field==='operation') row.operation=value.toUpperCase();else row.data[field]=value;
  }
  row.code=row.data[c.code] || '';
  if (!['CREATE','UPDATE'].includes(row.operation)) row.errors.push('Operation wajib CREATE atau UPDATE.');
  if (!/^[A-Za-z0-9][A-Za-z0-9._/\-]{0,99}$/.test(row.code)) row.errors.push(`${c.code} wajib berupa kode stabil, maksimal 100 karakter.`);
  if (row.operation==='CREATE' && !row.data[c.name]) row.errors.push(`${c.name} wajib diisi untuk CREATE.`);
  if (row.data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.data.email)) row.errors.push('Email tidak valid.');
  return row;
}
async function preview(tx,type,rawRows,user) {
  const c=config(type);permission(user,type,'read');
  if (!Array.isArray(rawRows)||!rawRows.length||rawRows.length>500) throw fail('Import master memerlukan 1–500 baris per batch.');
  const rows=rawRows.map((row,i)=>normalizeRow(row,i,type));const seen=new Set(),provenance=new Set();
  for (const row of rows) {
    const identity=row.code.toLowerCase(),sourceKey=`${row.sheetName}|${row.rowNumber}`;
    if (seen.has(identity)) row.errors.push('Kode duplikat dalam batch.');seen.add(identity);
    if (!Number.isInteger(row.rowNumber)||row.rowNumber<1||provenance.has(sourceKey)) row.errors.push('Nomor baris/sheet duplikat atau tidak valid.');provenance.add(sourceKey);
    if (row.errors.length) continue;
    const existing=await tx[c.model].findFirst({where:{[c.code]:{equals:row.code,mode:'insensitive'}}});
    row.expected=existing?{id:existing.id,updatedAt:new Date(existing.updatedAt).toISOString()}:null;
    if (existing?.isDeleted) row.errors.push('Kode sudah dihapus; restore harus melalui master data.');
    if (existing && existing[c.code]!==row.code) row.errors.push('Huruf besar/kecil kode berbeda dari master; gunakan kode yang sama persis.');
    if (!existing && row.operation==='UPDATE') row.errors.push('UPDATE membutuhkan kode yang sudah ada.');
    if (type==='CUSTOMER_MASTER' && row.data.currencyCode && !await tx.currency.findFirst({where:{currencyCode:row.data.currencyCode,isDeleted:false}})) row.errors.push('Currency Code tidak ditemukan.');
    if (type==='PRODUCT_MASTER') {
      if (existing && existing.itemType!=='FG') row.errors.push('Import produk Sales hanya untuk part FG. WIP/RAW dikelola melalui master Part.');
      const customer=row.data.customerCode || existing?.customerCode,base=row.data.baseUomCode || existing?.baseUomCode,sales=row.data.salesUomCode || existing?.salesUomCode || base;
      if (!customer || !await tx.customer.findFirst({where:{customerCode:customer,isDeleted:false}})) row.errors.push('Customer Code aktif wajib tersedia; impor Customer lebih dahulu.');
      for (const uom of new Set([base,sales])) if (!uom || !await tx.uom.findFirst({where:{uomCode:uom,isDeleted:false}})) row.errors.push(`UOM ${uom || '(kosong)'} tidak ditemukan.`);
      if (existing) for (const field of ['customerCode','baseUomCode','salesUomCode']) if (row.data[field] && existing[field] && row.data[field]!==existing[field]) row.errors.push(`${field} tidak boleh diganti melalui migrasi karena terkait histori transaksi.`);
      if (!existing) Object.assign(row.data,{itemType:'FG',baseUomCode:base,salesUomCode:sales,stockUomCode:base,productionUomCode:base,planningPolicy:'MTO',status:'Active'});
    }
    row.diff=Object.entries(row.data).filter(([field,value])=>field!==c.code && (existing?.[field]??null)!==value).map(([field,after])=>({field,before:existing?.[field]??null,after}));
    row.action=existing?(row.diff.length?'UPDATE':'NOOP'):'CREATE';
    if (row.operation==='CREATE' && existing && row.diff.length) row.errors.push('CREATE bertabrakan dengan master berbeda; pilih UPDATE secara eksplisit.');
  }
  const errors=rows.flatMap(row=>row.errors.map(message=>({sheetName:row.sheetName,rowNumber:row.rowNumber,code:row.code,message})));
  const summary={validLineCount:rows.filter(row=>!row.errors.length).length,errorCount:errors.length,createCount:rows.filter(row=>row.action==='CREATE'&&!row.errors.length).length,updateCount:rows.filter(row=>row.action==='UPDATE'&&!row.errors.length).length,noopCount:rows.filter(row=>row.action==='NOOP'&&!row.errors.length).length};
  const lines=rows.map(({sourceJson,...row})=>row);
  return {importType:type,lines,errors,summary,previewHash:digest({type,lines})};
}
async function stage(prisma,input,user) {
  return prisma.$transaction(async tx=>{
    const plan=await preview(tx,input.importType,input.rows,user);
    if (plan.errors.length) throw fail('Preview master masih memiliki error; perbaiki data sebelum staging.',409);
    if (!input.previewHash || plan.previewHash!==input.previewHash) throw fail('Master/source berubah dari preview. Jalankan preview ulang.',409);
    const sourceChecksum=digest({type:input.importType,rows:input.rows});
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`legacy-master:${sourceChecksum}`}))`;
    const existing=await tx.excelImportBatch.findFirst({where:{sourceChecksum,importType:input.importType},orderBy:{createdAt:'desc'}});
    if(existing && (existing.status==='APPLIED' || existing.metadata?.previewHash===plan.previewHash))return{...existing,idempotent:true};
    const batchNumber=`IMP-MASTER-${new Date().toISOString().slice(0,10).replaceAll('-','')}-${crypto.randomUUID().slice(0,8).toUpperCase()}`;
    return tx.excelImportBatch.create({data:{batchNumber,fileName:String(input.fileName||'master.xlsx').slice(0,255),fileType:String(input.fileType||'xlsx'),importType:input.importType,sourceChecksum,sourcePeriod:String(input.sourcePeriod||'').slice(0,255)||null,status:'VALIDATED',rowCount:plan.lines.length,errorCount:0,metadata:{legacyMaster:true,previewHash:plan.previewHash},reconciliation:JSON.parse(JSON.stringify(plan.summary)),createdBy:user?.username||user?.email,rows:{create:plan.lines.map((line,index)=>({sheetName:line.sheetName,rowNumber:line.rowNumber,sourceJson:input.rows[index].sourceJson||input.rows[index].data||input.rows[index],mappedJson:JSON.parse(JSON.stringify(line)),status:'VALID'}))}}});
  },{timeout:30000});
}
async function apply(prisma,batchKey,user) {
  return prisma.$transaction(async tx=>{
    const candidate=await tx.excelImportBatch.findFirst({where:{OR:[{id:batchKey},{batchNumber:batchKey}]}});
    if(!candidate)throw fail('Batch master tidak ditemukan.',404);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`legacy-master-batch:${candidate.id}`}))`;
    const batch=await tx.excelImportBatch.findFirst({where:{id:candidate.id},include:{rows:{orderBy:[{sheetName:'asc'},{rowNumber:'asc'}]}}});
    if(!batch||!batch.metadata?.legacyMaster)throw fail('Batch master tidak ditemukan.',404);
    const c=config(batch.importType);permission(user,batch.importType,'read');
    if(batch.status==='APPLIED')return{batch,idempotent:true,reconciliation:batch.reconciliation};
    if(batch.status!=='APPROVED')throw fail('Batch master harus disetujui sebelum diterapkan.',409);
    const plan=await preview(tx,batch.importType,batch.rows,user);
    if(plan.errors.length)throw fail(`Validasi ulang gagal: ${plan.errors.map(e=>`${e.code}: ${e.message}`).join('; ')}`,409);
    const changes=[];
    for(const line of plan.lines){
      const stored=batch.rows.find(row=>row.sheetName===line.sheetName&&row.rowNumber===line.rowNumber)?.mappedJson;
      if(!stored||digest(stored.expected)!==digest(line.expected)||digest(stored.data)!==digest(line.data))throw fail(`Master ${line.code} berubah setelah staging; buat batch/preview baru.`,409);
      if(line.action==='NOOP')continue;
      permission(user,batch.importType,line.action==='CREATE'?'create':'update');
      let record;
      if(line.action==='CREATE')record=await tx[c.model].create({data:line.data});
      else {
        const { [c.code]:_code,...data}=line.data;
        const updated=await tx[c.model].updateMany({where:{id:line.expected.id,isDeleted:false,updatedAt:new Date(line.expected.updatedAt)},data});
        if(updated.count!==1)throw fail(`Master ${line.code} berubah bersamaan; terapkan ulang setelah preview.`,409);
        record={id:line.expected.id};
      }
      changes.push({code:line.code,id:record.id,action:line.action,diff:line.diff});
    }
    const reconciliation={...plan.summary,appliedCount:changes.length,appliedAt:new Date().toISOString(),appliedBy:user?.username||user?.email,changes};
    const updated=await tx.excelImportBatch.update({where:{id:batch.id},data:{status:'APPLIED',appliedCount:changes.length,reconciliation:JSON.parse(JSON.stringify(reconciliation))}});
    await tx.excelImportRow.updateMany({where:{batchId:batch.id},data:{status:'APPLIED'}});
    return{batch:updated,reconciliation};
  },{timeout:30000});
}
module.exports={TYPES,config,permission,normalizeRow,preview,stage,apply,digest};
