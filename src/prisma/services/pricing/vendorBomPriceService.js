'use strict';
const { createHash } = require('node:crypto');
const { businessNow } = require('../../utils/businessClock');
const { resolveMbomRevision } = require('../planning/mbomRevisionService');
const { normalizeMonthlyPriceInput, monthlyPriceView, saveMonthlyPrice, MONTH_FIELDS } = require('./effectivePriceService');
const months = MONTH_FIELDS || ['january','february','march','april','may','june','july','august','september','october','november','december'];
const fail = (message, statusCode=400) => Object.assign(new Error(message), { statusCode });
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const code = value => String(value || '').trim().toUpperCase();
const active = row => row && !row.isDeleted && (!row.status || row.status === 'Active');
const partView = part => part && ({id:part.id,partCode:part.partCode,partNumber:part.partNumber,partName:part.partName});
const label = part => [part.partNumber,part.partName,part.partCode].filter(Boolean).join(' · ');
const yearValue = value => { const n=Number(value); if(!Number.isInteger(n)||n<2000||n>2100) throw fail('Tahun harga harus antara 2000 dan 2100.'); return n; };
const includePrice = { vendor:true,part:true,details:{where:{isDeleted:false},include:{vendorProcess:true}} };
const annual = year => ({OR:[{pricingYear:year},{effectiveFrom:{gte:new Date(Date.UTC(year,0,1)),lt:new Date(Date.UTC(year+1,0,1))}}]});

async function masters(db, at=businessNow()) {
  const [headers, processes, vendors, uoms, customers] = await Promise.all([
    db.mBOMHeader.findMany({where:{isDeleted:false},include:{part:true,details:{where:{isDeleted:false},include:{part:true,mbomProcesses:{where:{isDeleted:false},include:{process:true}}}}}}),
    db.vendorProcess.findMany({where:{isDeleted:false},include:{entityProcesses:{where:{entityType:'vendor'}}}}),
    db.vendor.findMany({where:{isDeleted:false,status:'Active'},select:{id:true,vendorCode:true,vendorName:true}}),
    db.uom.findMany({where:{isDeleted:false},select:{uomCode:true,uomName:true}}),
    db.customer.findMany({where:{isDeleted:false,status:'Active'},select:{id:true,customerCode:true}}),
  ]);
  const revisions=new Map(), current=new Map();
  for(const h of headers) { if(!active(h.part)) continue; if(!revisions.has(h.partId)) revisions.set(h.partId,[]); revisions.get(h.partId).push(h); }
  for(const [id,rows] of revisions) { const selected=resolveMbomRevision({revisions:rows,selectionDate:at}).revision; if(selected) current.set(id,selected); }
  return {headers,current,processes,vendors,uoms,customers,at};
}

function graph(data, fgPartId) {
  const root=data.current.get(fgPartId);
  if(!root || root.part.itemType!=='FG') throw fail('FG belum memiliki revisi BOM aktif pada tanggal kerja saat ini.');
  const rows=new Map(), visited=new Set(), selectedHeaders=[];
  function visit(header, chain=[]) {
    if(chain.includes(header.partId)) throw fail('Relasi BOM berulang. Perbaiki siklus BOM sebelum mengisi harga.');
    if(visited.has(header.id)) return;
    visited.add(header.id); selectedHeaders.push(header);
    for(const d of [...header.details].sort((a,b)=>a.levelComponent-b.levelComponent || String(a.part?.partCode).localeCompare(String(b.part?.partCode)))) {
      if(!active(d.part)) continue;
      const routes=d.mbomProcesses.filter(r=>d.category==='Vendor'||r.routingMode==='VENDOR');
      if(d.category==='Vendor' && !routes.length) routes.push({id:`missing:${d.id}`,process:null});
      for(const r of routes.sort((a,b)=>(a.sequence||0)-(b.sequence||0))) {
        let matches=data.processes.filter(p=>code(p.vendorProcessCode)===code(r.process?.processCode) && code(r.process?.processCode));
        if(!matches.length && r.process?.processName) matches=data.processes.filter(p=>code(p.vendorProcessName)===code(r.process.processName));
        const vp=matches.length===1?matches[0]:null;
        const key=`${d.partId}|${vp?.id||r.id}`;
        const availableVendorIds=[...new Set([...(vp?.entityProcesses||[]).map(e=>e.vendorId),r.vendorId,d.vendorId].filter(Boolean))];
        const availableVendors=data.vendors.filter(v=>!availableVendorIds.length||availableVendorIds.includes(v.id));
        const recommendedVendorId=[r.vendorId,d.vendorId,availableVendors.length===1?availableVendors[0].id:null].find(id=>availableVendors.some(v=>v.id===id))||null;
        const defaultVendorId=r.vendorId||d.vendorId||null;
        const bomDefault={routeId:r.id,bomNumber:header.noReg,vendorId:defaultVendorId,vendor:data.vendors.find(v=>v.id===defaultVendorId)||null};
        if(rows.has(key)) {
          const existing=rows.get(key); existing.routeIds.push(r.id); existing.bomDefaults.push(bomDefault);
          existing.availableVendors=[...new Map([...existing.availableVendors,...availableVendors].map(v=>[v.id,v])).values()];
          continue;
        }
        rows.set(key,{key,part:partView(d.part),vendorProcessId:vp?.id||null,processCode:r.process?.processCode||'',processName:r.process?.processName||'',
          vendorProcessCode:vp?.vendorProcessCode||'',vendorProcessName:vp?.vendorProcessName||'',category:vp?.category||'OTHER',routeIds:[r.id],bomNumber:header.noReg,
          uomCode:d.uomCode||d.part.purchaseUomCode||d.part.baseUomCode||d.part.productionUomCode||null,
          availableVendors,recommendedVendorId,bomDefaults:[bomDefault],
          problem:vp?null:!r.process?'Detail Vendor belum mempunyai routing proses.':`Proses ${r.process.processCode} belum dipetakan secara unik pada Master Proses Vendor.`,
        });
      }
      // A child with a separate BOM can add nested vendor work to the FG.
      const child=data.current.get(d.partId);
      if(d.partId!==header.partId && child) visit(child,[...chain,header.partId]);
    }
  }
  visit(root);
  const list=[...rows.values()];
  return {fg:partView(root.part),bom:{id:root.id,noReg:root.noReg,revision:root.revision,effectiveDate:root.effectiveDate,selectionDate:data.at},rows:list,
    fingerprint:hash({headers:selectedHeaders.map(h=>({id:h.id,updatedAt:h.updatedAt,details:h.details.map(d=>({id:d.id,updatedAt:d.updatedAt,partUpdatedAt:d.part?.updatedAt,routes:d.mbomProcesses.map(r=>({id:r.id,updatedAt:r.updatedAt}))}))})),rows:list})};
}

async function fgList(db, query={}) {
  const data=await masters(db); const q=code(query.q||query.search); const page=Math.max(1,Number(query.page)||1),limit=Math.min(100,Math.max(1,Number(query.limit)||25));
  const rows=[];
  for(const h of data.current.values()) {
    if(h.part.itemType!=='FG') continue;
    const g=graph(data,h.partId); if(!g.rows.length) continue;
    const customerCodes=new Set([h.part.customerCode,...(Array.isArray(h.part.customerCodes)?h.part.customerCodes:[])].filter(Boolean));
    const partCustomers=data.customers.filter(c=>customerCodes.has(c.customerCode));
    const p={...g.fg,displayName:label(g.fg),bomNumber:g.bom.noReg,revision:g.bom.revision,customerId:partCustomers.length===1?partCustomers[0].id:null};
    if(!q||code(label(p)).includes(q)) rows.push(p);
  }
  rows.sort((a,b)=>a.partCode.localeCompare(b.partCode));
  if(query.key) { const p=rows.find(p=>p.id===query.key||p.partCode===query.key); if(!p) throw fail('FG dengan proses vendor pada BOM aktif tidak ditemukan.',404); return p; }
  return {items:rows.slice((page-1)*limit,page*limit),total:rows.length,page,limit};
}

async function context(db, recordId) {
  const record=await db.vendorPriceList.findFirst({where:{id:recordId,isDeleted:false},include:includePrice});
  if(!record) throw fail('Harga vendor tidak ditemukan.',404);
  const data=await masters(db), candidates=[];
  for(const h of data.current.values()) {
    if(h.part.itemType!=='FG') continue;
    const g=graph(data,h.partId);
    if(g.rows.some(r=>r.part.id===record.partId && record.details.some(d=>d.vendorProcessId===r.vendorProcessId))) candidates.push({...g.fg,displayName:label(g.fg)});
  }
  return {recordId:record.id,pricingYear:record.pricingYear,currencyCode:record.currencyCode,customerId:record.customerId,vendorId:record.vendorId,
    fgPartId:candidates.length===1?candidates[0].id:null,candidates,part:partView(record.part),quotationFiles:record.quotationFiles||[],
    readOnly:!candidates.length,message:candidates.length?null:'Harga historis ini belum mempunyai proses vendor yang cocok pada BOM FG aktif. Detail lama tetap tersedia.'};
}

const scopeKey = scope => JSON.stringify(scope);
const quoteKey = (key,vendorId) => JSON.stringify([key,vendorId||null]);
async function preview(db, input, dataInput) {
  const year=yearValue(input.pricingYear), currencyCode=String(input.currencyCode||'IDR'), customerId=input.customerId||null;
  const data=dataInput||await masters(db), g=graph(data,input.fgPartId);
  const record=input.recordId?await db.vendorPriceList.findFirst({where:{id:input.recordId,isDeleted:false},include:includePrice}):null;
  if(input.recordId&&!record) throw fail('Harga yang diedit tidak ditemukan.',404);
  if(record&&Number(record.pricingYear)!==year) throw fail('Tahun harga saat edit tidak dapat diubah.');
  if(record&&!g.rows.some(r=>r.part.id===record.partId&&record.details.some(d=>d.vendorProcessId===r.vendorProcessId))) throw fail('FG yang dipilih tidak memuat child part/proses harga yang diedit.');
  const prices=await db.vendorPriceList.findMany({where:{isDeleted:false,currencyCode,customerId,...annual(year),partId:{in:g.rows.map(r=>r.part.id)}},include:includePrice,orderBy:[{effectiveFrom:'desc'},{updatedAt:'desc'}]});
  const groups=new Map();
  const rows=[];
  for(const source of g.rows) {
    const editMatch=record&&record.partId===source.part.id&&record.details.some(d=>d.vendorProcessId===source.vendorProcessId);
    const quotedVendors=[...new Set(prices.filter(p=>p.partId===source.part.id&&p.details.some(d=>d.vendorProcessId===source.vendorProcessId)&&source.availableVendors.some(v=>v.id===p.vendorId)).map(p=>p.vendorId))];
    const defaults=source.bomDefaults.map(d=>d.vendorId).filter(id=>source.availableVendors.some(v=>v.id===id));
    const selection=Object.prototype.hasOwnProperty.call(input.vendorSelections||{},source.key)
      ? input.vendorSelections[source.key]
      : [...new Set([...defaults,...(editMatch?[record.vendorId]:[]),...quotedVendors])];
    const vendorIds=Array.isArray(selection)?[...selection]:(selection||null)===null?[null]:[selection];
    if(!vendorIds.length) vendorIds.push(source.recommendedVendorId||null);
    if(vendorIds.length>100||vendorIds.some(id=>id!==null&&typeof id!=='string')) throw fail('Pilihan supplier tidak valid.');
    if(new Set(vendorIds.map(id=>id||null)).size!==vendorIds.length) throw fail('Supplier yang sama tidak boleh diulang dalam satu proses.');
    for(const selectedVendorId of vendorIds) {
    const vendorId=selectedVendorId||null;
    const editVendorMatch=editMatch&&record.vendorId===vendorId;
    const vendorOk=source.availableVendors.some(v=>v.id===vendorId);
    const candidates=prices.filter(p=>p.vendorId===vendorId&&p.partId===source.part.id&&p.details.some(d=>d.vendorProcessId===source.vendorProcessId));
    const categories=[...new Set(candidates.map(p=>p.category))];
    const category=editVendorMatch?record.category:categories.length===1?categories[0]:source.category;
    const scope={vendorId,partId:source.part.id,customerId,category,currencyCode};
    const matching=prices.filter(p=>p.vendorId===vendorId&&p.partId===source.part.id&&p.category===category);
    const canonical=matching.find(p=>p.id===record?.id)||matching[0];
    const groupKey=scopeKey(scope);
    if(!groups.has(groupKey)) {
      const view=canonical?await monthlyPriceView(db,'vendorPriceList',canonical):null;
      groups.set(groupKey,{scope,id:canonical?.id||null,view,record:canonical||null,priceToken:hash(matching.map(p=>[p.id,new Date(p.updatedAt).toISOString()]).sort())});
    }
    const group=groups.get(groupKey), rate=group.view?.monthlyPlan?.details?.find(d=>d.vendorProcessId===source.vendorProcessId);
    rows.push({...source,vendorId,quoteKey:quoteKey(source.key,vendorId),isBomDefault:source.bomDefaults.some(d=>d.vendorId&&d.vendorId===vendorId),category,groupKey,priceToken:group.priceToken,priceListId:group.id,
      uomCode:rate?.uomCode||source.uomCode,minimumOrderQty:rate?.minimumOrderQty??null,orderMultipleQty:rate?.orderMultipleQty??null,minimumCharge:rate?.minimumCharge??null,notes:rate?.notes||'',
      ...Object.fromEntries(months.map(m=>[m,rate?.[m]??null])),monthlyOverrides:rate?.monthlyOverrides||{},
      priceSource:rate?'Harga tersimpan':'Belum ada harga',quotationFiles:group.record?.quotationFiles||[],
      problem:source.problem||(!vendorOk?'Pilih supplier aktif yang melayani proses ini.':categories.length>1&&!editVendorMatch?'Ada harga pada beberapa kategori untuk child part/proses ini. Rapikan kategori harga sebelum menyimpan.':null)});
    }
  }
  if(rows.length>500) throw fail('Terlalu banyak harga supplier dalam satu form.');
  return {fg:g.fg,bom:g.bom,bomFingerprint:g.fingerprint,pricingYear:year,currencyCode,customerId,rows,uoms:data.uoms,_groups:groups};
}

function cleanDetail(row) {
  const d={vendorProcessId:row.vendorProcessId,sequence:row.sequence||1,uomCode:row.uomCode||null,notes:row.notes||null,unitPrice:null};
  for(const k of ['minimumOrderQty','orderMultipleQty','minimumCharge']) {
    if(row[k]!=null&&row[k]!==''&&!['number','string'].includes(typeof row[k])) throw fail(`${k} harus berupa angka.`);
    const n=row[k]===null||row[k]===undefined||row[k]===''?null:Number(row[k]);
    if(n!==null&&(!Number.isFinite(n)||n<0)) throw fail(`${k} harus nol atau lebih.`);
    d[k]=n;
  }
  for(const m of months) d[m]=row[m]??null;
  return d;
}

async function save(db, input, options={}) {
  const work=async tx=>{
    if(!Array.isArray(input.rows)||!input.rows.length) throw fail('Pilih minimal satu proses yang harganya akan disimpan.');
    if(input.rows.some(r=>!r||typeof r!=='object'||Array.isArray(r)||typeof r.key!=='string')) throw fail('Baris harga BOM tidak valid.');
    if(input.rows.length>500) throw fail('Terlalu banyak proses dalam satu penyimpanan.');
    const keys=input.rows.map(r=>quoteKey(r.key,r.vendorId)); if(new Set(keys).size!==keys.length) throw fail('Supplier yang sama tidak boleh diulang untuk child part/proses yang sama.');
    const vendorSelections=Object.create(null);
    for(const row of input.rows) (vendorSelections[row.key] ||= []).push(row.vendorId||null);
    const fresh=await preview(tx,{...input,vendorSelections});
    if(input.bomFingerprint!==fresh.bomFingerprint) throw fail('BOM berubah sejak form dibuka. Muat ulang proses sebelum menyimpan.',409);
    const currency=await tx.currency.findFirst({where:{currencyCode:fresh.currencyCode,isDeleted:false}}); if(!currency) throw fail('Mata uang tidak ditemukan.');
    if(fresh.customerId&&!await tx.customer.findFirst({where:{id:fresh.customerId,isDeleted:false,status:'Active'}})) throw fail('Customer tidak aktif atau tidak ditemukan.');
    const changes=new Map();
    for(const row of input.rows) {
      const source=fresh.rows.find(r=>r.key===row.key&&r.vendorId===(row.vendorId||null)); if(!source) throw fail('Child part/proses tidak berasal dari BOM FG yang dipilih.');
      if(source.problem) throw fail(`${source.part.partCode}: ${source.problem}`);
      if(row.priceToken!==source.priceToken) throw fail('Harga berubah sejak form dibuka. Muat ulang agar harga terbaru tidak tertimpa.',409);
      if(!fresh.uoms.some(u=>u.uomCode===row.uomCode)) throw fail(`Pilih UOM harga yang valid untuk ${source.part.partCode}.`);
      if(!changes.has(source.groupKey)) changes.set(source.groupKey,[]);
      changes.get(source.groupKey).push(cleanDetail({...row,vendorProcessId:source.vendorProcessId}));
    }
    const results=[];
    for(const [key,changed] of [...changes].sort(([a],[b])=>a.localeCompare(b))) {
      const group=fresh._groups.get(key);
      if(group.id&&!options.canUpdate) throw fail('Diperlukan izin mengubah harga vendor yang sudah ada.',403);
      if(!group.id&&!options.canCreate) throw fail('Diperlukan izin membuat harga vendor untuk proses baru.',403);
      const retained=(group.view?.monthlyPlan?.details||[]).filter(d=>!changed.some(c=>c.vendorProcessId===d.vendorProcessId)).map(cleanDetail);
      const normalized=normalizeMonthlyPriceInput({pricingMode:'MONTHLY',pricingYear:fresh.pricingYear,...group.scope,isActive:group.record?.isActive??true,
        details:[...retained,...changed].map((d,i)=>({...d,sequence:i+1}))},{vendor:true,existing:group.view});
      const {details,...header}=normalized;
      const files=options.filesForGroup?await options.filesForGroup(results.length):[];
      const data={...header,createdBy:group.record?.createdBy||options.actor||'system',notes:group.record?.notes||null,
        quotationFiles:[...(group.record?.quotationFiles||[]),...files],
        ...(group.view?{monthlySourceVersions:group.view.monthlyPlan.sourceVersions}:{}),
        details:{...(group.id?{deleteMany:{}}:{}),create:details.map(cleanDetail)}};
      const saved=await saveMonthlyPrice(tx,{model:'vendorPriceList',id:group.id||undefined,data,scopeWhere:group.scope});
      results.push({id:saved.id,partId:saved.partId,vendorId:saved.vendorId,processes:changed.length});
    }
    return {ok:true,fg:fresh.fg,records:results,processes:new Set(input.rows.map(r=>r.key)).size,supplierPrices:input.rows.length};
  };
  return db.$transaction?db.$transaction(work,{isolationLevel:'Serializable',timeout:30000}):work(db);
}
module.exports={masters,graph,fgList,context,preview,save,cleanDetail,months};
