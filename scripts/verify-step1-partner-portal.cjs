const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
// Isolated in-memory fixtures; never open the application's PostgreSQL pool.
require.cache[require.resolve('../src/prisma/index')] = { exports: { prisma: {} } };
const domain = require('../src/prisma/services/incoming/partnerPortalDomain');
const docs = require('../src/prisma/services/incoming/incomingDocumentService');
const { createPartnerAccessMiddleware, publicAccess } = require('../src/prisma/middleware/partnerAccess');
const { createPartnerPortalRouter } = require('../src/prisma/routes/incoming/partner-portal');
const { createIncomingEvidenceRouter } = require('../src/prisma/routes/incoming/documents-checklist');
const supplierA = { id: 'binding-a', userId: 'a', supplierCode: 'SUP-A', vendorCode: null, isActive: true, supplier: { supplierName: 'Supplier A', status: 'Active', isDeleted: false } };
const supplierB = { ...supplierA, id: 'binding-b', userId: 'b', supplierCode: 'SUP-B', supplier: { ...supplierA.supplier, supplierName: 'Supplier B' } };
const lineA = { id: 'detail-a', qty: 10, qtyReceived: 2, uomCode: 'PCS', materialCode: 'M-A' };
const poA = { poNumber: 'PO-A', supplierCode: 'SUP-A', status: 'Sent', details: [lineA] };
const noticeBody = { poNumber: 'PO-A', deliveryNoteNumber: 'SJ-A', expectedDate: '2026-09-09', details: [{ poDetailId: 'detail-a', qty: 3, supplierLotNumber: 'LOT-1' }] };
const fullChecklist = () => domain.CHECKLIST.map(row => ({ ...row, result: 'PASS', notes: '' }));
const fixtures = () => {
  const calls = [], writes = [], data = { notices: [{ id: 'notice-a', poNumber: 'PO-A', status: 'Submitted', details: noticeBody.details, po: poA }], checklist: null };
  const db = {
    partnerAccess: { findUnique: async q => ({ a: supplierA, b: supplierB, suspended: { ...supplierA, isActive: false } })[q.where.userId] || null },
    $queryRaw: async (...args) => { calls.push(['lock', args]); return []; },
    purchaseOrder: { findFirst: async q => { calls.push(['po', q]); return q.where.poNumber === 'PO-A' && q.where.supplierCode === 'SUP-A' ? poA : null; }, findMany: async q => { calls.push(['orders', q]); return []; } },
    partnerDeliveryNotice: { findFirst: async q => { calls.push(['notice', q]); return q.where.id === 'notice-a' && q.where.po.supplierCode === 'SUP-A' ? data.notices[0] : null; }, findMany: async q => { calls.push(['notices', q]); return q.where.poNumber ? [] : []; }, create: async q => { writes.push(q); return { id:'new-notice', noticeNumber:q.data.noticeNumber, status:'Submitted' }; }, update: async q => { writes.push(q); data.notices[0].status = q.data.status; return {id:'notice-a',status:q.data.status}; } },
    goodsReceipt: { findMany: async q => { calls.push(['receipts',q]); return []; } },
    incomingDocument: { findFirst: async q => { calls.push(['document',q]); return null; } },
    vendorProcessOrder: { findMany: async q => { calls.push(['vendor',q]); return []; } },
    incomingInspection: { findFirst: async q => q.where.inspectionNumber === 'IQC-A' ? { id:'iqc-a', status:'Open', details:[{id:'iqc-line-a'}] } : null },
    incomingInspectionDetail: { update: async q => { writes.push(q); data.checklist=q.data.checklist; return q.data; } },
  };
  db.$transaction = async fn => fn(db);
  return { db, calls, writes, data };
};
async function serve(t, db, fn) {
  const app = express(); app.use(express.json());
  app.use((req,res,next) => { req.user = { id:req.get('x-test-user') || 'a', username:'fixture', isSuperAdmin:req.get('x-test-user') === 'internal' }; next(); });
  const guard = createPartnerAccessMiddleware(db);
  app.get('/internal', guard.loadPartnerAccess, guard.internalOnly, (req,res) => res.json({ok:true}));
  app.use('/partner', createPartnerPortalRouter(db)); app.use('/incoming', createIncomingEvidenceRouter(db));
  app.use((error,req,res,next) => res.status(error.statusCode || 500).json({message:error.message}));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  await fn((route, opts = {}, user = 'a') => fetch(url+route, { ...opts, headers: { 'x-test-user':user, ...(opts.body instanceof FormData ? {} : {'content-type':'application/json'}), ...opts.headers } }));
}
test('tenant scope fails closed for missing/suspended/ambiguous bindings', () => {
  for (const access of [null, {...supplierA,isActive:false}, {...supplierA,vendorCode:'V-1'}]) assert.throws(() => domain.partyScope(access), /Akses partner/);
  assert.deepEqual(domain.partyScope(supplierA), {supplierCode:'SUP-A'});
  assert.deepEqual(Object.keys(publicAccess(supplierA)).sort(), ['isActive','partyCode','partyName','partyType']);
});
test('bound and suspended partners cannot access internal endpoints; unbound staff can', async t => {
  const f=fixtures(); await serve(t,f.db,async fetcher => { assert.equal((await fetcher('/internal')).status,403); assert.equal((await fetcher('/internal',{},'suspended')).status,403); assert.equal((await fetcher('/internal',{},'internal')).status,200); assert.equal((await fetcher('/partner/me',{},'suspended')).status,403); });
});
test('own PO registration is atomic and never posts stock; foreign PO/line rejected', async t => {
  const f=fixtures(); await serve(t,f.db,async fetcher => {
    const foreign = await fetcher('/partner/notices',{method:'POST',body:JSON.stringify(noticeBody)},'b'); assert.equal(foreign.status,404); assert.equal(f.writes.length,0);
    const invalid = await fetcher('/partner/notices',{method:'POST',body:JSON.stringify({...noticeBody,details:[{poDetailId:'foreign-detail',qty:3,supplierLotNumber:'L'}]})}); assert.equal(invalid.status,400);
    const own = await fetcher('/partner/notices',{method:'POST',body:JSON.stringify({...noticeBody,supplierCode:'SUP-B',status:'Received',grNumber:'forged'})}); assert.equal(own.status,201); assert.equal(f.writes.length,1); assert.equal(f.writes[0].data.partnerAccessId,'binding-a'); assert.equal(f.writes[0].data.status,undefined); assert.equal(f.writes[0].data.grNumber,undefined); assert.ok(f.calls.some(c=>c[0]==='lock'));
  });
});
test('registration rejects overbooked, duplicate-line, fractional discrete and nonfinite quantities', () => {
  assert.throws(()=>domain.validateNotice({...noticeBody,details:[{...noticeBody.details[0],qty:7}]},poA,new Map([['detail-a',2]])),/melebihi/);
  assert.throws(()=>domain.validateNotice({...noticeBody,details:[{...noticeBody.details[0],qty:5},{...noticeBody.details[0],qty:5}]},poA),/melebihi/);
  for (const qty of [Infinity,NaN,-2,0]) assert.throws(()=>domain.validateNotice({...noticeBody,details:[{...noticeBody.details[0],qty}]},poA));
  assert.throws(()=>domain.validateNotice({...noticeBody,details:[{...noticeBody.details[0],qty:0.5}]},poA));
});
test('all dashboard queries apply trusted party scope; query-string party cannot override', async t => {
  const f=fixtures(); await serve(t,f.db,async fetcher => { const r=await fetcher('/partner/dashboard?from=2026-09-01&to=2026-09-30&supplierCode=SUP-B'); assert.equal(r.status,200); for (const [name,q] of f.calls.filter(c=>['notices','receipts'].includes(c[0]))) assert.equal(q.where.po.supplierCode,'SUP-A',name); });
});
test('foreign notice cancel/upload and foreign file download return 404, without writes', async t => {
  const f=fixtures(); await serve(t,f.db,async fetcher => {
    assert.equal((await fetcher('/partner/notices/notice-a/cancel',{method:'POST',body:'{}'},'b')).status,404);
    const form=new FormData(); form.append('document',new Blob(['%PDF-1.7\nfixture'],{type:'application/pdf'}),'sj.pdf');
    assert.equal((await fetcher('/partner/notices/notice-a/documents',{method:'POST',body:form},'b')).status,404);
    assert.equal((await fetcher('/partner/documents/foreign-file',{},'b')).status,404);
    const q=f.calls.find(c=>c[0]==='document')[1]; assert.equal(q.where.OR[0].notice.po.supplierCode,'SUP-B'); assert.equal(q.where.OR[1].gr.po.supplierCode,'SUP-B'); assert.equal(f.writes.length,0);
  });
});
test('upload signature/extension checks reject disguises; filenames and storage keys cannot escape', () => {
  const file={originalname:'../../surat.pdf',mimetype:'application/pdf',buffer:Buffer.from('%PDF-1.7 fixture'),size:16};
  assert.equal(domain.validateFile(file).fileName,'surat.pdf');
  assert.throws(()=>domain.validateFile({...file,buffer:Buffer.from('<script>evil</script>')}),/Format/);
  assert.throws(()=>domain.validateFile({...file,originalname:'surat.exe'}),/Format/);
  assert.throws(()=>domain.validateFile({...file,size:11*1024*1024}),/10 MB/);
  assert.throws(()=>docs.documentPath('../secret.env'),/tersedia/);
});
test('private upload persists metadata and cleans file if database write fails', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'step1-doc-test-'));
  t.after(async()=>{ const entries=await fs.readdir(root); for(const file of entries) await fs.unlink(path.join(root,file)); await fs.rmdir(root); });
  const file={originalname:'sj.pdf',mimetype:'application/pdf',buffer:Buffer.from('%PDF-1.7 fixture'),size:16};
  const db={incomingDocument:{count:async()=>0,create:async q=>({id:'d1',...q.data})}};
  const saved=await docs.saveDocument(db,{file,grNumber:'GR-A',actor:'internal',root});
  assert.equal(saved.saved.grNumber,'GR-A'); assert.equal((await fs.readdir(root)).length,1); await saved.cleanup(); assert.equal((await fs.readdir(root)).length,0);
  db.incomingDocument.create=async()=>{throw new Error('db failure');};
  await assert.rejects(docs.saveDocument(db,{file,grNumber:'GR-A',actor:'internal',root}),/db failure/); assert.equal((await fs.readdir(root)).length,0);
});
test('checklist enforces all criteria, unique codes, final outcomes, reasons and audit identity', () => {
  const rows=fullChecklist(); assert.equal(domain.normalizeChecklist(rows,{final:true,actor:'qc'}).checkedBy,'qc');
  assert.throws(()=>domain.normalizeChecklist(rows.slice(1)),/standar/);
  assert.throws(()=>domain.normalizeChecklist([...rows,rows[0]]),/duplikat/);
  assert.throws(()=>domain.normalizeChecklist(rows.map((r,i)=>i===0?{...r,result:'PENDING'}:r),{final:true}),/Lengkapi/);
  for(const result of ['FAIL','NA']) assert.throws(()=>domain.normalizeChecklist(rows.map((r,i)=>i===0?{...r,result}:r)),/alasan/);
});
test('checklist save locks inspection, rejects cross-document lines and stores actor', async t => {
  const f=fixtures(); await serve(t,f.db,async fetcher => {
    const foreign=await fetcher('/incoming/incoming-inspections/IQC-A/checklist',{method:'PUT',body:JSON.stringify({lines:[{id:'other-line',rows:fullChecklist()}]})},'internal'); assert.equal(foreign.status,400); assert.equal(f.writes.length,0);
    const own=await fetcher('/incoming/incoming-inspections/IQC-A/checklist',{method:'PUT',body:JSON.stringify({lines:[{id:'iqc-line-a',rows:fullChecklist()}]})},'internal'); assert.equal(own.status,200); assert.equal(f.data.checklist.checkedBy,'fixture'); assert.ok(f.calls.some(c=>c[0]==='lock'));
    assert.equal((await fetcher('/incoming/incoming-inspections/IQC-A/checklist',{method:'PUT',body:JSON.stringify({lines:[]})})).status,403);
  });
});
test('period respects Jakarta whole days and summary never mixes UOM or draft results', () => {
  const period=domain.dateRange({from:'2026-09-01',to:'2026-09-01'}); assert.equal(period.where.gte.toISOString(),'2026-08-31T17:00:00.000Z'); assert.equal(period.where.lt.toISOString(),'2026-09-01T17:00:00.000Z');
  assert.throws(()=>domain.dateRange({from:'2026-02-31',to:'2026-03-01'}),/valid/);
  const rows=domain.summarizeUnits([{details:[{qtyReceived:10,uomCode:'PCS',incomingInspectionDetails:[{qtyAccepted:7,qtyRejected:3,inspection:{status:'Completed'}},{qtyAccepted:100,qtyRejected:100,inspection:{status:'Open'}}]}]}],[{qtyReceived:50,qtyAccepted:45,qtyReject:5,uomCode:'KG'}]);
  assert.deepEqual(rows,[{uomCode:'PCS',received:10,accepted:7,rejected:3},{uomCode:'KG',received:50,accepted:45,rejected:5}]);
});
test('partner login and profile redact internal employee, menus, permissions even when suspended', async () => {
  const db = require('../src/prisma/index').prisma;
  const bcrypt = require('bcrypt');
  const record = { id:'portal-user', username:'portal-fixture', fullName:'Portal User', password:bcrypt.hashSync('local-test-password',4), isSuperAdmin:true, listMenu:[{resource:'private'}], employeeId:'private-employee', employee:{employeeId:'private-employee',signature:'private-signature'}, roleAssignments:[{role:{isActive:true,id:'r',roleName:'Private admin',permissions:[]}}], partnerAccess:{...supplierA,isActive:false} };
  db.user = { findFirst:async()=>record, findUnique:async()=>record };
  const ctrl = require('../src/prisma/controllers/AuthController');
  let body;
  const res = { status(code) { this.code=code; return this; }, json(value) { body=value; return this; } };
  await ctrl.login({body:{identifier:record.username,password:'local-test-password'}},res,error=>{throw error;});
  assert.equal(body.user.partnerAccess.isActive,false); assert.equal(body.user.isSuperAdmin,false); assert.deepEqual(body.user.roles,[]); assert.deepEqual(body.user.listMenu,[]); assert.equal(body.user.employee,null); assert.ok(!JSON.stringify(body.user).includes('private-'));
  await ctrl.profile({user:{id:record.id}},res,error=>{throw error;}); assert.equal(body.partnerAccess.partyCode,'SUP-A'); assert.ok(!JSON.stringify(body).includes('private-'));
});
test('IQC completion refuses missing checklist and preserves finalized audit with accepted quantities', async () => {
  const db = require('../src/prisma/index').prisma;
  const line = {id:'il',grDetailId:'gdl',lineNumber:1};
  const item={id:'iqc',inspectionNumber:'IQC-1',grNumber:'GR-1',status:'Open',details:[line],gr:{details:[{id:'gdl',qtyReceived:3,uomCode:'PCS',poDetail:{}}]}};
  const writes=[];
  const tx={ $queryRaw:async()=>[], incomingInspection:{findFirst:async()=>item,update:async q=>{writes.push(q);return q.data;}}, incomingInspectionDetail:{update:async q=>{writes.push(q);return q.data;}}, goodsReceiptDetail:{update:async()=>({})}, goodsReceipt:{update:async()=>({})} };
  db.$transaction=async fn=>fn(tx);
  const ctrl=require('../src/prisma/controllers/incoming/IncomingTransactionController');
  const req={params:{inspectionNumber:'IQC-1'},user:{id:'qc',username:'QC Inspector'},body:{decisions:[{grDetailId:'gdl',qtyAccepted:3,qtyRejected:0}]}};
  let status=200,body;
  const res={status(code){status=code;return this;},json(value){body=value;return this;}};
  await ctrl.completeInspection(req,res,error=>{throw error;}); assert.equal(status,400);assert.match(body.message,/Checklist/);assert.equal(writes.length,0);
  line.checklist=domain.normalizeChecklist(fullChecklist(),{actor:'QC Inspector'});status=200;
  await ctrl.completeInspection(req,res,error=>{throw error;});assert.equal(status,200);assert.equal(body.acceptedTotal,3);assert.equal(writes[0].data.checklist.checkedBy,'QC Inspector');assert.equal(writes[1].data.status,'Completed');
});
test('vendor month summaries use owned arrival movements and dated QC, not cumulative order totals', async t => {
  const f=fixtures();
  f.db.partnerAccess.findUnique=async()=>({id:'bv',userId:'v',vendorCode:'VEN-A',supplierCode:null,isActive:true,vendor:{vendorName:'Vendor A',status:'Active',isDeleted:false}});
  f.db.vendorProcessOrder.findMany=async q=>{assert.equal(q.where.vendorCode,'VEN-A');return [{orderNumber:'VP-A',qtyReceived:100,qtyAccepted:90,qtyReject:10,sentAt:new Date('2026-08-01'),receivedAt:new Date('2026-08-02'),status:'Partial Received',uomCode:'PCS',qualityInspections:[{inspectionNumber:'QC-old',status:'Completed',approvedAt:new Date('2026-08-03'),qtyPassed:86,qtyFailed:9},{inspectionNumber:'QC-new',status:'Completed',approvedAt:new Date('2026-09-03'),qtyPassed:4,qtyFailed:1}]}];};
  f.db.stockMovement={findMany:async q=>{assert.deepEqual(q.where.referenceNumber.in,['VP-A']);assert.equal(q.where.transactionType,'QC_HOLD');assert.equal(q.where.direction,'IN');assert.equal(q.where.movementDate.gte.toISOString(),'2026-08-31T17:00:00.000Z');return[{referenceNumber:'VP-A',movementDate:new Date('2026-09-02'),qty:5}];}};
  await serve(t,f.db,async fetcher=>{const response=await fetcher('/partner/dashboard?from=2026-09-01&to=2026-09-30',{},'v');assert.equal(response.status,200);const result=await response.json();assert.equal(result.vendorOrders[0].qtyReceived,5);assert.equal(result.vendorOrders[0].qtyAccepted,4);assert.deepEqual(result.summaryByUom,[{uomCode:'PCS',received:5,accepted:4,rejected:1}]);});
});
