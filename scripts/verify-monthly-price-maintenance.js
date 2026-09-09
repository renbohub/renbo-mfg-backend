const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const pricing = require('../src/prisma/services/pricing/effectivePriceService');
const { normalizeMonthlyPriceInput: normalize, resolveEffectivePrice: resolve, saveMonthlyPrice: save } = pricing;
async function run() {
  const input = { pricingMode: 'MONTHLY', pricingYear: '2026', january: '100', august: '125', september: '', unitPrice: 999 };
  const data = normalize(input);
  assert.equal(data.unitPrice, null); assert.equal(data.september, null); assert.equal(data.pricingMode, undefined);
  assert.equal(data.effectiveFrom.toISOString(), '2026-01-01T00:00:00.000Z');
  assert.equal(resolve([data], '2026-07-01').unitPrice, 100);
  assert.equal(resolve([data], '2026-09-01').unitPrice, 125);
  assert.equal(resolve([data], '2027-01-01').record, null);
  assert.throws(()=>normalize({...input, pricingYear:2026.5}), /Tahun/);
  assert.throws(()=>normalize({...input, january:'100bad'}), /Harga/);
  assert.throws(()=>normalize({...input, august:-1}), /Harga/);
  assert.throws(()=>normalize({pricingMode:'MONTHLY',pricingYear:2026}), /minimal/);
  const vendor = normalize({pricingMode:'MONTHLY',pricingYear:'2026',details:JSON.stringify([{vendorProcessId:'process',unitPrice:999,january:45,september:50}])},{vendor:true});
  assert.equal(vendor.details[0].unitPrice,null); assert.equal(vendor.details[0].september,50); assert.equal(vendor.unitPrice,undefined);
  assert.throws(()=>normalize({...vendor,details:[vendor.details[0],vendor.details[0]]},{vendor:true}), /duplikat/);
  let conflict = false; const writes = [];
  const tx = {partPriceList:{findFirst:async()=>conflict?{id:'other'}:null,create:async({data})=>{writes.push(data);return {id:'new',...data}},update:async(args)=>{writes.push(args);return args.data}}};
  await save(tx,{model:'partPriceList',data,scopeWhere:{partId:'p',supplierId:'s'}});
  conflict=true;
  await assert.rejects(save(tx,{model:'partPriceList',id:'current',data,scopeWhere:{partId:'p',supplierId:'s'}}), e=>e.statusCode===409);
  assert.equal(writes.length,1,'duplicate must not mutate existing price');

  const periods = [
    {id:'april',supplierId:'s',partId:'p',currencyCode:'IDR',pricingYear:2026,unitPrice:13925,effectiveFrom:'2026-04-01',effectiveUntil:null,updatedAt:'2026-09-07T00:00:00.000Z'},
    {id:'january',supplierId:'s',partId:'p',currencyCode:'IDR',pricingYear:2026,unitPrice:13725,effectiveFrom:'2026-01-01',effectiveUntil:'2026-03-31',updatedAt:'2026-09-06T00:00:00.000Z'}
  ];
  const view = await pricing.monthlyPriceView({partPriceList:{findMany:async()=>periods}},'partPriceList',periods[1]);
  assert.equal(view.monthlyPlan.january,13725);assert.equal(view.monthlyPlan.march,null);
  assert.equal(view.monthlyPlan.april,13925);assert.equal(view.monthlyPlan.december,null);
  assert.equal(view.monthlyPlan.monthlyResolved.march,13725);assert.equal(view.monthlyPlan.monthlyResolved.december,13925);
  const merged=normalize({...view.monthlyPlan,monthlySourceVersions:view.monthlyPlan.sourceVersions}); delete merged.sourceCount;delete merged.sourceVersions;
  let archived=[];let annual;
  const mergeDb={partPriceList:{findUnique:async()=>periods[1],findMany:async()=>periods,updateMany:async({where})=>{archived.push(...where.id.in)},update:async({data})=>{annual=data;return data}}};
  await save(mergeDb,{model:'partPriceList',id:'january',data:merged,scopeWhere:{partId:'p',supplierId:'s'}});
  assert.deepEqual(archived,['april']);assert.equal(annual.monthlySourceVersions,undefined);assert.equal(annual.april,13925);
  periods[0].updatedAt='2026-09-07T01:00:00.000Z';archived=[];
  await assert.rejects(save(mergeDb,{model:'partPriceList',id:'january',data:merged,scopeWhere:{partId:'p',supplierId:'s'}}),e=>e.statusCode===409);
  assert.deepEqual(archived,[], 'stale form cannot archive or overwrite newer prices');
  periods[0].updatedAt=merged.monthlySourceVersions.april;
  mergeDb.partPriceList.findMany=async({where})=>where.id ? [periods[1]] : periods;
  await assert.rejects(save(mergeDb,{model:'partPriceList',id:'january',data:merged,scopeWhere:{partId:'p',supplierId:'s'}}),e=>e.statusCode===409);
  mergeDb.partPriceList.findMany=async({where})=>where.id ? [{...periods[0],isDeleted:true},periods[1]] : [periods[1]];
  await assert.rejects(save(mergeDb,{model:'partPriceList',id:'january',data:merged,scopeWhere:{partId:'p',supplierId:'s'}}),e=>e.statusCode===409);
  assert.deepEqual(archived,[], 'deleted source periods cannot be restored by a stale form');

  // Execute real controllers with a transaction double; no business records written.
  for (const type of ['Part','Material','Vendor']) {
    const model = type.toLowerCase()+'PriceList'; let saved;
    const hydrated=()=>({...saved,...(saved?.details?.create?{details:saved.details.create}:{})});
    const delegate={findFirst:async({where})=>where.id === "price" ? hydrated() : null,findUnique:async()=>hydrated(),findMany:async()=>saved?[hydrated()]:[],create:async({data})=>(saved={id:'price',updatedAt:new Date('2026-09-01'),...data}),update:async({data})=>{saved={...saved,...data,id:'price',updatedAt:new Date('2026-09-02')};return hydrated()}};
    const db={ [model]:delegate, part:{findFirst:async()=>({id:'part',itemType:'RAW',rawType:'PURCHASE_PART',status:'Active'})}, mBOMHeader:{findMany:async()=>[{id:'bom',partId:'fg',revision:0,effectiveDate:new Date('2020-01-01'),isDeleted:false,part:{status:'Active',isDeleted:false},details:[{partId:'part',category:'Vendor',isDeleted:false}]}]} };
    db.$transaction=async(fn)=>fn(db);
    const filename=path.resolve(__dirname,`../src/prisma/controllers/master-data/${type}PriceListController.js`);
    const exports={}; const requireHere=require('node:module').createRequire(filename);
    vm.runInNewContext(fs.readFileSync(filename,'utf8'),{exports,require:(name)=>name==='../../index'?{prisma:db}:name==='../../middleware/uploads'?{deleteQuotationFile(){}}:requireHere(name),console,process,Date,Number,Set,JSON},{filename});
    const body={...input,partId:'part',supplierId:'supplier',currencyCode:'IDR',uomCode:'pcs'};
    if(type==='Vendor'){delete body.supplierId;delete body.uomCode;delete body.unitPrice;Object.assign(body,{vendorId:'vendor',category:'INSPECTION',customerId:'',details:JSON.stringify([{vendorProcessId:'process',uomCode:'pcs',january:45,september:50}])});}
    if(type==='Material'){delete body.partId;Object.assign(body,{materialSubstanceId:'substance',materialGradeId:'grade',thickness:1});db.materialGrade={findFirst:async()=>({id:'grade',substanceId:'substance',thickness:1,gradeCode:'SPCC'})};}
    let error; const res={statusCode:200,status(code){this.statusCode=code;return this},json(value){this.body=value;return this}};
    await exports.create({body,user:{username:'test'}},res,e=>{error=e});
    if(error) throw error;
    assert.equal(res.statusCode,201,`${type}: ${JSON.stringify(res.body)}`);
    assert.equal(saved.pricingYear,2026);assert.equal(saved.pricingMode,undefined);
    if(type==='Vendor'){assert.equal(saved.details.create[0].unitPrice,null);assert.equal(saved.details.create[0].september,50);assert.equal(saved.customerId,null);}
    else {assert.equal(saved.unitPrice,null);assert.equal(saved.august,125);}
    const patch = type === 'Vendor' ? {...body, details:JSON.stringify([{vendorProcessId:'process',uomCode:'pcs',january:'',september:55}])} : {...body,january:'',september:150};
    error=null;res.statusCode=200;
    await exports.update({params:{id:'price'},body:patch,user:{username:'test'}},res,e=>{error=e});
    if(error) throw error;
    assert.equal(res.statusCode,200,`${type} update: ${JSON.stringify(res.body)}`);
    const row=type==='Vendor'?saved.details.create[0]:saved;
    assert.equal(row.january,null,`${type} blank month clears saved value`);
    assert.equal(row.september,type==='Vendor'?55:150);
    assert.equal(row.unitPrice,null,`${type} old flat price cannot override month edits`);
    // A PATCH that only introduces June must keep existing later changes.
    error=null;res.statusCode=200;
    const partial=type==='Vendor'?{pricingMode:'MONTHLY',details:JSON.stringify([{vendorProcessId:'process',june:0}])}:{pricingMode:'MONTHLY',june:0};
    await exports.update({params:{id:'price'},body:partial,user:{username:'test'}},res,e=>{error=e});
    if(error) throw error;
    assert.equal(res.statusCode,200,`${type} partial monthly update: ${JSON.stringify(res.body)}`);
    const partialRow=type==='Vendor'?saved.details.create[0]:saved;
    assert.equal(partialRow.june,0);assert.equal(partialRow.september,type==='Vendor'?55:150);
    if(type!=='Vendor')assert.equal(partialRow.august,125,`${type} omitted August override is preserved`);
    if(type==='Material')assert.equal(saved.materialId,undefined,'Material create and edit require no SKU');
  }
  console.log('Monthly pricing: annual periods, carry-forward, invalid prices, duplicate prevention, and three controller create/update payloads passed.');
}
run().catch(e=>{console.error(e);process.exitCode=1});
