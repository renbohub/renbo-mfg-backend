const test=require('node:test'),assert=require('node:assert/strict'),path=require('path');
const indexPath=path.resolve(__dirname,'../src/prisma/index.js');require.cache[indexPath]={id:indexPath,filename:indexPath,loaded:true,exports:{prisma:{}}};
const service=require('../src/prisma/services/system/legacyMasterImportService');
const controller=require('../src/prisma/controllers/system/LegacyMasterImportController');
const XLSX=require('xlsx'),{parseWorkbookUpload}=require('../src/prisma/services/system/excelWorkbookImportService');
const admin={id:'admin',username:'admin',isSuperAdmin:true};
const row=data=>({sheetName:'Customers',rowNumber:2,sourceJson:data});
function fixture(){
 let seq=0,state={customer:[{id:'c0',customerCode:'C0',customerName:'Existing',isDeleted:false,updatedAt:new Date('2026-09-01')}],part:[],batches:[],rows:[]};
 const match=(r,w)=>Object.entries(w).every(([k,v])=>k==='OR'?v.some(sub=>match(r,sub)):v instanceof Date?new Date(r[k]).getTime()===v.getTime():v&&typeof v==='object'&&v.equals!==undefined?String(r[k]).toLowerCase()===String(v.equals).toLowerCase():r[k]===v);
 const tx={$executeRaw:async()=>0,currency:{findFirst:async({where})=>where.currencyCode==='IDR'?{currencyCode:'IDR'}:null},uom:{findFirst:async({where})=>['PCS','KG'].includes(where.uomCode)?{uomCode:where.uomCode}:null}};
 for(const model of ['customer','part'])tx[model]={findFirst:async({where})=>structuredClone(state[model].find(r=>match(r,where))||null),create:async({data})=>{if(state[model].some(r=>r[model==='part'?'partCode':'customerCode']===data[model==='part'?'partCode':'customerCode']))throw Error('Unique code conflict');const r={id:`m${++seq}`,isDeleted:false,...structuredClone(data),updatedAt:new Date(Date.now()+seq)};state[model].push(r);return r;},updateMany:async({where,data})=>{const r=state[model].find(r=>match(r,where));if(!r)return{count:0};Object.assign(r,structuredClone(data),{updatedAt:new Date(Date.now()+ ++seq)});return{count:1};}};
 tx.excelImportBatch={findFirst:async({where,include})=>{const r=state.batches.find(r=>match(r,where));return r?structuredClone({...r,...(include?{rows:state.rows.filter(row=>row.batchId===r.id)}:{})}):null;},create:async({data})=>{const {rows,...fields}=data,r={id:`b${++seq}`,...fields};state.batches.push(r);state.rows.push(...rows.create.map(line=>({id:`r${++seq}`,batchId:r.id,...line})));return structuredClone(r);},update:async({where,data})=>{const r=state.batches.find(r=>match(r,where));Object.assign(r,data);return structuredClone(r);}};
 tx.excelImportRow={updateMany:async({where,data})=>{state.rows.filter(r=>match(r,where)).forEach(r=>Object.assign(r,data));return{count:state.rows.length};}};
 return{tx,get state(){return state},prisma:{$transaction:async fn=>{const before=structuredClone(state);try{return await fn(tx);}catch(error){state=before;throw error;}}}};
}
async function stage(f,rows,type='CUSTOMER_MASTER'){
 const preview=await service.preview(f.tx,type,rows,admin);assert.equal(preview.errors.length,0,JSON.stringify(preview.errors));
 return service.stage(f.prisma,{importType:type,rows,fileName:'master.csv',fileType:'csv',previewHash:preview.previewHash},admin);
}
test('normalization rejects arbitrary fields, deletion and invalid operation',()=>{
 const result=service.normalizeRow(row({Operation:'DELETE',customerCode:'C1',isDeleted:true,password:'secret'}),0,'CUSTOMER_MASTER');
 assert.equal(result.errors.length,3);assert.equal(result.data.isDeleted,undefined);assert.equal(result.data.password,undefined);
});
test('preview returns complete old/new differences and validates duplicate/references',async()=>{
 const f=fixture(),result=await service.preview(f.tx,'CUSTOMER_MASTER',[row({Operation:'UPDATE',customerCode:'C0',customerName:'Updated'})],admin);
 assert.equal(result.lines[0].diff[0].before,'Existing');assert.equal(result.lines[0].diff[0].after,'Updated');assert.equal(f.state.customer[0].customerName,'Existing');
 const duplicate=await service.preview(f.tx,'CUSTOMER_MASTER',[row({Operation:'CREATE',customerCode:'C1',customerName:'One'}),{...row({Operation:'CREATE',customerCode:'c1',customerName:'Two'}),rowNumber:3}],admin);assert.match(duplicate.errors[0].message,/duplikat/);
 const currency=await service.preview(f.tx,'CUSTOMER_MASTER',[row({Operation:'CREATE',customerCode:'C2',customerName:'Two',currencyCode:'BAD'})],admin);assert.match(currency.errors[0].message,/Currency/);
});
test('stage rejects forged preview and repeated stage is idempotent',async()=>{
 const f=fixture(),rows=[row({Operation:'CREATE',customerCode:'C1',customerName:'New'})];
 await assert.rejects(service.stage(f.prisma,{importType:'CUSTOMER_MASTER',rows,previewHash:'forged'},admin),/preview ulang/);
 const first=await stage(f,rows),second=await stage(f,rows);assert.equal(second.id,first.id);assert.equal(second.idempotent,true);assert.equal(f.state.batches.length,1);assert.equal(f.state.customer.length,1);
});
test('apply requires approval and creates audited master once; repeat application does not duplicate',async()=>{
 const f=fixture(),batch=await stage(f,[row({Operation:'CREATE',customerCode:'C1',customerName:'New'})]);
 await assert.rejects(service.apply(f.prisma,batch.batchNumber,admin),/disetujui/);f.state.batches[0].status='APPROVED';
 const applied=await service.apply(f.prisma,batch.batchNumber,admin);assert.equal(applied.reconciliation.appliedCount,1);assert.equal(applied.reconciliation.changes[0].action,'CREATE');assert.equal(f.state.customer.length,2);
 assert.equal((await service.apply(f.prisma,batch.id,admin)).idempotent,true);assert.equal(f.state.customer.length,2);assert.equal(f.state.rows[0].status,'APPLIED');
});
test('apply checks separate master mutation permissions and fails atomically',async()=>{
 const f=fixture(),batch=await stage(f,[row({Operation:'CREATE',customerCode:'C1',customerName:'New'})]);f.state.batches[0].status='APPROVED';
 const reader={username:'reader',listMenu:[{resource:'customers',actions:['read']}]};
 await assert.rejects(service.apply(f.prisma,batch.id,reader),/Akses create/);assert.equal(f.state.customer.length,1);assert.equal(f.state.batches[0].status,'APPROVED');
 await assert.rejects(service.preview(f.tx,'CUSTOMER_MASTER',[row({Operation:'UPDATE',customerCode:'C0'})],{username:'outsider'}),/Akses read/);
});
test('master edited after stage cannot be overwritten by stale import',async()=>{
 const f=fixture(),batch=await stage(f,[row({Operation:'UPDATE',customerCode:'C0',customerName:'Imported'})]);f.state.batches[0].status='APPROVED';f.state.customer[0].customerName='Manual edit';f.state.customer[0].updatedAt=new Date('2026-09-02');
 await assert.rejects(service.apply(f.prisma,batch.id,admin),/berubah setelah staging/);assert.equal(f.state.customer[0].customerName,'Manual edit');assert.equal(f.state.batches[0].status,'APPROVED');
});
test('product imports validate customer/UOM and protect existing structural fields',async()=>{
 const f=fixture(),rows=[row({Operation:'CREATE',partCode:'FG-001',partName:'Product',customerCode:'C0',baseUomCode:'PCS'})];
 const batch=await stage(f,rows,'PRODUCT_MASTER');f.state.batches[0].status='APPROVED';await service.apply(f.prisma,batch.id,admin);assert.equal(f.state.part[0].itemType,'FG');assert.equal(f.state.part[0].stockUomCode,'PCS');
 const result=await service.preview(f.tx,'PRODUCT_MASTER',[row({Operation:'UPDATE',partCode:'FG-001',baseUomCode:'KG'})],admin);assert.equal(result.errors.some(e=>e.message.includes('histori')),true);
});
test('CSV UTF-8 preserves zero-prefixed codes and XLSX customer template roundtrips',async()=>{
 const csv=Buffer.from('Operation,customerCode,customerName\nCREATE,0001,PT Maju\n');const parsed=parseWorkbookUpload({originalname:'master.csv',buffer:csv});assert.equal(parsed.rows[0].sourceJson.customerCode,'0001');
 let buffer;controller.template({params:{kind:'customer'},user:admin},{set(){},send(value){buffer=value;}},error=>{throw error});
 const wb=XLSX.read(buffer,{type:'buffer'});XLSX.utils.sheet_add_aoa(wb.Sheets.Customers,[['CREATE','C2','PT Baru']],{origin:'A2'});const result=parseWorkbookUpload({originalname:'master.xlsx',buffer:XLSX.write(wb,{type:'buffer',bookType:'xlsx'})});
 const f=fixture(),preview=await service.preview(f.tx,'CUSTOMER_MASTER',result.rows,admin);assert.equal(preview.errors.length,0,JSON.stringify(preview.errors));assert.equal(preview.lines[0].code,'C2');
});
test('explicit master template header is not replaced by customer/address text',()=>{
 const csv=Buffer.from('Operation,customerCode,customerName,contact,shippingAddress\nCREATE,C1,Customer Part Company,Customer Admin,Customer Part Drawing Road\n');
 const parsed=parseWorkbookUpload({originalname:'master.csv',buffer:csv});
 assert.equal(parsed.rows.length,1);assert.equal(parsed.rows[0].sourceJson.customerCode,'C1');assert.equal(parsed.metadata.sheets[0].headerRow,1);
});
