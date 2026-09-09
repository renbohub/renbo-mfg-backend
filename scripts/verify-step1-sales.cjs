const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
// Isolate the database: these tests run real policy/approval functions on a transactional fake.
const indexPath = path.resolve(__dirname,'../src/prisma/index.js');
require.cache[indexPath] = { id:indexPath,filename:indexPath,loaded:true,exports:{prisma:{}} };
const workflow = require('../src/prisma/services/sales/salesOrderWorkflowService');
const attachment = require('../src/prisma/services/sales/salesOrderAttachmentService');
const history = require('../src/prisma/controllers/planning/ForecastHistoryController');
const XLSX = require('xlsx');
const { parseWorkbookUpload } = require('../src/prisma/services/system/excelWorkbookImportService');

function fixture() {
  let sequence = 0;
  const users = [{id:'author',username:'sales'}, {id:'checker',username:'checker'}, {id:'manager',username:'manager'}];
  const rule = {id:'rule',requireSequential:true,allowSelfApproval:false,priority:1,moduleCode:'sales',pageCode:'sales-orders',actionCode:'approve',minAmount:null,maxAmount:null,steps:[{id:'s1',stepOrder:1,stepName:'Check',approverRoleId:'check',requiredApprovals:1},{id:'s2',stepOrder:2,stepName:'Approve',approverRoleId:'manage',requiredApprovals:1}]};
  let state = {doc:{id:'so-id',soNumber:'SO-2026-001',customerPoNumber:'CLIENT-PO-001',status:'Draft',totalAmount:100,currencyCode:'IDR',details:[{id:'line',partCode:'FG-001',qty:10,unitPrice:10,deliveryTargets:[{id:'target',qty:10,targetDate:'2026-09-30'}]}],attachments:[]},requests:[],actions:[],notifications:[],postings:0};
  const decorate = row => row ? structuredClone({...row,rule,actions:state.actions.filter(a=>a.requestId===row.id)}) : null;
  const matches = (row,where) => Object.entries(where).every(([key,value]) => key==='isDeleted' ? !row.isDeleted : value && typeof value==='object' && Array.isArray(value.in) ? value.in.includes(row[key]) : row[key]===value);
  const tx = {
    $executeRaw:async()=>0,
    approvalRule:{findMany:async()=>[rule]},
    approvalRequest:{
      findFirst:async({where})=>decorate(state.requests.find(row=>matches(row,where))),
      findUnique:async({where})=>decorate(state.requests.find(row=>row.id===where.id)),
      create:async({data})=>{const row={id:`r${++sequence}`,...data};state.requests.push(row);return decorate(row);},
      update:async({where,data})=>{const row=state.requests.find(r=>r.id===where.id);Object.assign(row,data);return decorate(row);},
    },
    approvalAction:{create:async({data})=>{const row={id:`a${++sequence}`,...data};state.actions.push(row);return row;}},
    salesOrderHeader:{update:async({data})=>{Object.assign(state.doc,data);return structuredClone(state.doc);}},
    user:{findMany:async()=>users},
    userRole:{findMany:async({where})=>where.userId==='checker'?[{roleId:'check'}]:where.userId==='manager'?[{roleId:'manage'}]:[]},
    rolePermission:{findMany:async()=>[]},
    notification:{create:async({data})=>{const row={id:`n${++sequence}`,...data};state.notifications.push(row);return row;}},
  };
  return {tx,rule,users,get state(){return state},postConfirm:async()=>{state.postings++;state.doc.status='Confirmed';return structuredClone(state.doc);},async transaction(fn){const before=structuredClone(state);try{return await fn();}catch(error){state=before;throw error;}}};
}
test('SO Draft input cannot force lifecycle status',()=>{
  for (const status of ['Confirmed','In Approval','Delivered','Cancelled']) assert.throws(()=>workflow.assertDraftInput({status}),/workflow/);
  assert.doesNotThrow(()=>workflow.assertDraftInput({customerPoNumber:'PO-A'}));
});
test('two distinct authorized levels required; final posting occurs only once all levels complete',async()=>{
  const f=fixture(); await workflow.submit(f.tx,f.state.doc,f.users[0]);
  assert.equal(f.state.doc.status,'In Approval');
  assert.equal(f.state.notifications.some(n=>n.userId==='checker'),true);
  assert.equal(f.state.notifications.some(n=>n.userId==='manager'),false);
  await assert.rejects(workflow.decide(f.tx,f.state.doc,f.users[2],'Approved','',f.postConfirm),/step aktif/);
  await assert.rejects(workflow.decide(f.tx,f.state.doc,f.users[0],'Approved','',f.postConfirm),/Self approval/);
  const first=await workflow.decide(f.tx,f.state.doc,f.users[1],'Approved','Sesuai PO',f.postConfirm);
  assert.equal(first.final,false);assert.equal(f.state.postings,0);assert.equal(f.state.doc.status,'In Approval');
  assert.equal(f.state.notifications.some(n=>n.userId==='manager'),true);
  await assert.rejects(workflow.decide(f.tx,f.state.doc,f.users[1],'Approved','',f.postConfirm),/berbeda/);
  const last=await workflow.decide(f.tx,f.state.doc,f.users[2],'Approved','Disetujui',f.postConfirm);
  assert.equal(last.final,true);assert.equal(f.state.doc.status,'Confirmed');assert.equal(f.state.postings,1);
  await assert.rejects(workflow.decide(f.tx,f.state.doc,f.users[2],'Approved','',f.postConfirm),/harus diajukan/);
});
test('unsubmitted, externally manufactured and stale versions cannot approve',async()=>{
  const f=fixture(); await assert.rejects(workflow.decide(f.tx,f.state.doc,f.users[1],'Approved','',f.postConfirm),/harus diajukan/);
  await workflow.submit(f.tx,f.state.doc,f.users[0]); f.state.doc.customerPoNumber='CHANGED';
  await assert.rejects(workflow.decide(f.tx,f.state.doc,f.users[1],'Approved','',f.postConfirm),/Versi SO berbeda/);
  assert.equal(f.state.actions.length,0);
  f.state.doc.customerPoNumber='CLIENT-PO-001';delete f.state.requests[0].context.source;
  await assert.rejects(workflow.decide(f.tx,f.state.doc,f.users[1],'Approved','',f.postConfirm),/Versi SO berbeda/);
});
test('posting failure rolls back final approval so inventory retry is safe',async()=>{
  const f=fixture();await workflow.submit(f.tx,f.state.doc,f.users[0]);await workflow.decide(f.tx,f.state.doc,f.users[1],'Approved','',f.postConfirm);
  await assert.rejects(f.transaction(()=>workflow.decide(f.tx,f.state.doc,f.users[2],'Approved','',async()=>{throw Error('stock posting failure')})),/stock posting failure/);
  assert.equal(f.state.requests[0].status,'In Approval');assert.equal(f.state.actions.length,1);
  await f.transaction(()=>workflow.decide(f.tx,f.state.doc,f.users[2],'Approved','',f.postConfirm));assert.equal(f.state.postings,1);
});
test('rejection and owner withdrawal preserve decisions and allow a fresh submission',async()=>{
  const f=fixture();await workflow.submit(f.tx,f.state.doc,f.users[0]);
  await assert.rejects(workflow.withdraw(f.tx,f.state.doc,f.users[2],'cancel'),/pengaju/);
  await assert.rejects(workflow.decide(f.tx,f.state.doc,f.users[1],'Rejected','',f.postConfirm),/Alasan/);
  await workflow.decide(f.tx,f.state.doc,f.users[1],'Rejected','Harga tidak sesuai',f.postConfirm);
  assert.equal(f.state.doc.status,'Draft');assert.equal(f.state.requests[0].status,'Rejected');assert.equal(f.state.postings,0);
  await workflow.submit(f.tx,f.state.doc,f.users[0]);await workflow.withdraw(f.tx,f.state.doc,f.users[0],'Perbaiki PO');
  assert.equal(f.state.doc.status,'Draft');assert.equal(f.state.requests[1].status,'Cancelled');assert.equal(f.state.actions.at(-1).notes,'Perbaiki PO');
});
test('unsafe or absent approval configurations fail closed',()=>{
  assert.throws(()=>workflow.assertRule(null));
  const f=fixture();f.rule.steps.pop();assert.throws(()=>workflow.assertRule(f.rule),/minimal dua/);
});
test('attachment validates content, extension, size and private path',()=>{
  const pdf=attachment.validateFile({originalname:'../../PO.pdf',buffer:Buffer.from('%PDF-1.7\n%%EOF')});assert.equal(pdf.fileName,'PO.pdf');assert.match(pdf.storageKey,/\.pdf$/);
  assert.throws(()=>attachment.validateFile({originalname:'PO.pdf',buffer:Buffer.from('evil')}),/sesuai PDF/);
  assert.throws(()=>attachment.validateFile({originalname:'PO.js',buffer:Buffer.from('alert(1)')}),/hanya/);
  assert.throws(()=>attachment.validateFile({originalname:'PO.xlsx',buffer:Buffer.from('not zip')}),/Office/);
  assert.throws(()=>attachment.validateFile({originalname:'PO.pdf',buffer:Buffer.alloc(attachment.MAX_BYTES+1)}),/maksimal/);
  assert.throws(()=>attachment.storedPath('../../private.pdf'),/Referensi/);
  const workbook=XLSX.utils.book_new();XLSX.utils.book_append_sheet(workbook,XLSX.utils.aoa_to_sheet([['PO'],['A']]),'PO');
  assert.equal(attachment.validateFile({originalname:'PO.xlsx',buffer:XLSX.write(workbook,{type:'buffer',bookType:'xlsx'})}).fileType.includes('spreadsheet'),true);
});
test('attachment metadata hides storage keys and download enforces order ownership',async()=>{
  const visible=attachment.publicAttachment({id:'attachment',soNumber:'SO-A',files:[{fileName:'PO.pdf',storageKey:'private.pdf',fileType:'application/pdf',fileSize:10}]});
  assert.equal(JSON.stringify(visible).includes('storageKey'),false);assert.match(visible.files[0].downloadUrl,/SO-A/);
  let query;const db={salesOrderAttachment:{findFirst:async arg=>{query=arg;return null;}}};
  await assert.rejects(attachment.download(db,{params:{soNumber:'OTHER',attachmentId:'attachment',fileIndex:'0'}},{}),/tidak ditemukan/);
  assert.equal(query.where.soNumber,'OTHER');assert.equal(query.where.isDeleted,false);assert.equal(query.where.soHeader.isDeleted,false);
});
test('forecast template matches importer headers and survives workbook upload parsing',()=>{
  const workbook=XLSX.read(history.buildTemplate(),{type:'buffer'});assert.deepEqual(workbook.SheetNames,['Forecast']);
  XLSX.utils.sheet_add_aoa(workbook.Sheets.Forecast,[['C001','FG-001','','PCS','2026-09-01',125,500,'PO planning']],{origin:'A2'});
  const buffer=XLSX.write(workbook,{type:'buffer',bookType:'xlsx'});
  const parsed=parseWorkbookUpload({originalname:'forecast.xlsx',buffer});
  const row=parsed.rows[0].sourceJson;assert.equal(row['Customer Code'],'C001');assert.equal(row['Part Code'],'FG-001');assert.equal(row['Forecast Qty'],125);assert.equal(row['Forecast Month'],'2026-09-01');
});
test('forecast history compares added, removed and changed parts without mixing UOM',()=>{
  const result=history.compareVersions([{forecastNumber:'F1',details:[{partCode:'A',uomCode:'PCS',M1Forecast:'2026-09-01',M1Qty:100},{partCode:'B',uomCode:'KG',M1Forecast:'2026-09-01',M1Qty:10}]},{forecastNumber:'F2',details:[{partCode:'A',uomCode:'PCS',M1Forecast:'2026-09-01',M1Qty:125}]}]);
  assert.equal(result[1].rows.find(r=>r.partCode==='A').deltaQty,25);assert.equal(result[1].rows.find(r=>r.partCode==='B').deltaQty,-10);assert.equal(result[1].rows.find(r=>r.partCode==='B').qty,0);
});
