"use strict";
const {randomUUID}=require('node:crypto');
const domain=require('./preparationDomain');
const {explodeDemandBom}=require('./demandFeasibilityService');
const day=value=>value && Number.isFinite(new Date(value).getTime())?new Date(value).toISOString().slice(0,10):'';
const notFound=()=>Object.assign(new Error('Skenario tidak ditemukan.'),{statusCode:404});
const record=row=>({...row,createdAt:row.created_at,updatedAt:row.updated_at,createdBy:row.created_by,updatedBy:row.updated_by});
async function list(tx,month){domain.monthKey(month);return (await tx.$queryRaw`SELECT id,name,month,revision,created_by,updated_by,created_at,updated_at FROM tbl_ppic_preparation WHERE month=${month} ORDER BY updated_at DESC`).map(record);}
async function get(tx,id){const rows=await tx.$queryRaw`SELECT * FROM tbl_ppic_preparation WHERE id=${id}`;if(!rows[0])throw notFound();return record(rows[0]);}
async function save(tx,input,actor,id=null){
  const payload=domain.normalize(input),json=JSON.stringify(payload);
  if(!id){const newId=randomUUID();const rows=await tx.$queryRaw`INSERT INTO tbl_ppic_preparation (id,name,month,payload,created_by,updated_by) VALUES (${newId},${payload.name},${payload.month},${json}::jsonb,${actor},${actor}) RETURNING *`;return record(rows[0]);}
  if(!Number.isInteger(input.revision)||input.revision<1)throw Object.assign(new Error('Revisi skenario wajib diisi.'),{statusCode:400});
  const rows=await tx.$queryRaw`UPDATE tbl_ppic_preparation SET name=${payload.name},payload=${json}::jsonb,revision=revision+1,updated_by=${actor},updated_at=CURRENT_TIMESTAMP WHERE id=${id} AND month=${payload.month} AND revision=${input.revision} RETURNING *`;
  if(!rows[0])throw Object.assign(new Error('Skenario sudah berubah di sesi lain. Buka ulang skenario sebelum menyimpan; edit Anda belum ditimpa.'),{statusCode:409});return record(rows[0]);
}
async function seed(tx,month){
  domain.monthKey(month);const {items}=await require('./deliveryCalendarService').deliveryCalendar(tx);
  const workbook={name:'Preparation '+month,month,delivery:[],production:[],material:[],sourceAt:new Date().toISOString(),sourceNotes:['Production Schedule berisi usulan FG selesai sesuai tanggal kebutuhan, belum memperhitungkan kapasitas mesin.','Stok awal material dimulai dari 0. Isi proyeksi stok awal bulan pada Material Arrival.']};
  const delivery=new Map(),production=new Map(),materials=new Map();
  for(const item of items)for(const split of item.effectiveDeliverySplits?.length?item.effectiveDeliverySplits:[{targetDate:item.targetDate,qty:item.demandQty}]){
    const date=day(split.targetDate);if(!date.startsWith(month))continue;
    const qty=Math.max(Number(split.remainingQty??split.qty)||0,0);if(!qty)continue;
    const uomCode=String(item.uomCode||'PCS').toUpperCase(),identity=domain.key(item.partCode,uomCode,item.customerCode);
    if(!delivery.has(identity))delivery.set(identity,{id:randomUUID(),partCode:item.partCode,partName:'',customerCode:item.customerCode||'',uomCode,days:{}});
    const row=delivery.get(identity);row.days[date]=(row.days[date]||0)+qty;
    const pi=domain.key(item.partCode,uomCode);if(!production.has(pi))production.set(pi,{id:randomUUID(),partCode:item.partCode,partName:'',uomCode,resource:'',shift:'1',materialOffsetDays:0,days:{}});
    const prod=production.get(pi),finish=day(split.fgRequiredDate||item.fgRequiredDate||date);
    if(finish.startsWith(month))prod.days[finish]=(prod.days[finish]||0)+qty;
    else workbook.sourceNotes.push(`${item.partCode}: kebutuhan FG ${finish} di luar bulan; alokasi produksi perlu ditentukan.`);
  }
  const parts=await tx.part.findMany({where:{isDeleted:false,partCode:{in:[...production.values()].map(row=>row.partCode)}},select:{id:true,partCode:true,partName:true}});
  const byCode=new Map(parts.map(part=>[part.partCode,part]));
  for(const row of [...delivery.values(),...production.values()])row.partName=byCode.get(row.partCode)?.partName||'';
  for(const part of parts){try{
    const bom=await explodeDemandBom(tx,{partId:part.id,partCode:part.partCode,quantity:1,effectiveAt:new Date(month+'-01T00:00:00Z')});
    if(!bom.rootHeader)workbook.sourceNotes.push(`${part.partCode}: belum ada BOM efektif.`);
    for(const material of bom.componentRequirements){const owner=material.materialSupplyType==='CUSTOMER_SUPPLIED'?material.supplyCustomerCode||'':'';const id=domain.key(material.partCode,material.uomCode,owner);if(!materials.has(id))materials.set(id,{id:randomUUID(),partCode:material.partCode,partName:material.partName||'',uomCode:String(material.uomCode||'PCS').toUpperCase(),supplyType:owner?'CUSTOMER_SUPPLIED':'SUPPLIER_PURCHASE',customerCode:owner,openingStock:0,days:{}});}
  }catch(error){workbook.sourceNotes.push(`${part.partCode}: ${error.message}`);}}
  const start=new Date(month+'-01T00:00:00Z'),end=new Date(start);end.setUTCMonth(end.getUTCMonth()+1);
  const poRows=await tx.purchaseOrderDetail.findMany({where:{isDeleted:false,po:{isDeleted:false,status:{in:['Approved','Ordered','Sent','Partially Received','Confirmed']}}},select:{partCode:true,materialCode:true,partName:true,materialName:true,uomCode:true,qty:true,qtyReceived:true,deliveryDate:true,po:{select:{deliveryDate:true,poNumber:true}}}});
  for(const po of poRows){const date=po.deliveryDate||po.po.deliveryDate;if(!date||date<start||date>=end)continue;const qty=Math.max(Number(po.qty)-Number(po.qtyReceived),0),code=po.partCode;if(!qty)continue;if(!code||!po.uomCode){workbook.sourceNotes.push(`${po.po.poNumber}: kedatangan tanpa kode part/satuan belum dimasukkan.`);continue;}
    const identity=domain.key(code,po.uomCode);if(!materials.has(identity))materials.set(identity,{id:randomUUID(),partCode:code,partName:po.partName||po.materialName||'',uomCode:po.uomCode.toUpperCase(),supplyType:'SUPPLIER_PURCHASE',customerCode:'',openingStock:0,days:{}});
    const row=materials.get(identity),day=date.toISOString().slice(0,10);row.days[day]=(row.days[day]||0)+qty;
  }
  workbook.delivery=[...delivery.values()];workbook.production=[...production.values()];workbook.material=[...materials.values()];return domain.normalize(workbook);
}
async function simulate(tx,input){
  const workbook=domain.normalize(input),requirements=new Map(),warnings=[],jobs=new Map();
  for(const row of workbook.production)for(const [date,qty]of Object.entries(row.days)){
    const id=JSON.stringify([row.partCode,row.uomCode,date,row.materialOffsetDays]);if(!jobs.has(id))jobs.set(id,{...row,date,qty:0});jobs.get(id).qty+=qty;
  }
  if(jobs.size>1000)throw Object.assign(new Error('Simulasi dibatasi 1.000 kombinasi part/tanggal. Pisahkan menjadi beberapa skenario.'),{statusCode:400});
  const parts=await tx.part.findMany({where:{isDeleted:false,partCode:{in:[...new Set([...jobs.values()].map(row=>row.partCode))]}},select:{id:true,partCode:true,productionUomCode:true,baseUomCode:true}}),partByCode=new Map(parts.map(p=>[p.partCode,p]));
  for(const job of jobs.values()){
    const part=partByCode.get(job.partCode);if(!part){warnings.push(`${job.partCode}: part tidak ditemukan, kebutuhan material belum dihitung.`);continue;}
    try{
      const bom=await explodeDemandBom(tx,{partId:part.id,partCode:job.partCode,quantity:job.qty,effectiveAt:new Date(job.date+'T00:00:00Z')});
      if(!bom.rootHeader){warnings.push(`${job.partCode} ${job.date}: BOM efektif belum tersedia.`);continue;}
      const header=await tx.mBOMHeader.findUnique({where:{id:bom.rootHeader.id},select:{uomCode:true}}),unit=header?.uomCode||part.productionUomCode||part.baseUomCode;
      if(!unit||unit.toUpperCase()!==job.uomCode){warnings.push(`${job.partCode}: satuan produksi ${job.uomCode} belum cocok dengan BOM (${unit||'belum diisi'}).`);continue;}
      const needed=new Date(job.date+'T00:00:00Z');needed.setUTCDate(needed.getUTCDate()-job.materialOffsetDays);const date=needed.toISOString().slice(0,10);
      for(const component of bom.componentRequirements){
        if(!component.uomCode){warnings.push(`${component.partCode}: satuan BOM belum tersedia.`);continue;}
        const owner=component.materialSupplyType==='CUSTOMER_SUPPLIED'?component.supplyCustomerCode||'':'';
        if(component.materialSupplyType==='CUSTOMER_SUPPLIED'&&!owner){warnings.push(`${component.partCode}: pemilik pasokan customer belum tersedia.`);continue;}
        const id=domain.key(component.partCode,component.uomCode,owner);
        if(!requirements.has(id))requirements.set(id,{partCode:component.partCode,partName:component.partName,uomCode:component.uomCode.toUpperCase(),customerCode:owner,days:{},sources:[]});
        const material=requirements.get(id);material.days[date]=(material.days[date]||0)+component.qty;material.sources.push({partCode:job.partCode,productionDate:job.date,requiredDate:date,quantity:component.qty,bomNumber:bom.rootHeader.noReg});
      }
    }catch(error){warnings.push(`${job.partCode} ${job.date}: ${error.message}`);}
  }
  const arrivals=new Map(workbook.material.map(row=>[domain.key(row.partCode,row.uomCode,row.customerCode),row]));
  const materials=[...requirements].map(([id,row])=>{
    const supply=arrivals.get(id)||{openingStock:0,days:{}},outside=Object.entries(row.days).filter(([date])=>!date.startsWith(workbook.month)).map(([date,quantity])=>({date,quantity}));
    if(outside.length)warnings.push(`${row.partCode}: ada kebutuhan sebelum periode, perlu persiapan bulan sebelumnya.`);
    return {...row,...domain.ledger(workbook.month,supply.openingStock,supply.days,row.days),outsidePeriod:outside};
  });
  return {month:workbook.month,simulatedAt:new Date().toISOString(),delivery:domain.deliveryBalance(workbook),materials,warnings:[...new Set(warnings)],basis:'Simulasi FG selesai vs delivery tanpa stok FG; kebutuhan material dari BOM efektif pada tanggal produksi, dimajukan sesuai offset material. Kapasitas mesin, MOQ, dan konfirmasi rencana resmi tidak dijalankan.'};
}
module.exports={list,get,save,seed,simulate};
