"use strict";
// In-memory transaction double only: never creates partner commitments in a DB.
const assert = require("node:assert/strict");
const store = require("../src/prisma/services/purchasing/etaConfirmationStore");
const monitor = require("../src/prisma/services/purchasing/etaMonitorService");
const service = require("../src/prisma/services/purchasing/etaConfirmationService");
const permissions = require("../src/prisma/services/purchasing/etaPermissionService");
const base = {id:"MPSM:detail:phase:0",source:"MPS-202609",mpsNumber:"MPS-202609",mpsRevision:27,partnerCode:"SUP-1",code:"NUT",partCode:"NUT",uom:"PCS",qty:100,requiredQty:100,needDate:"2026-09-22",targetArrivalDate:"2026-09-18",leadTime:5,requiresQc:true,checkpoint:"MPS_MATERIAL",category:"PURCHASE_PART"};
const row = store.decorate(base,null);
const input = {id:row.id,month:"2026-09",mpsNumber:row.mpsNumber,sourceFingerprint:row.sourceFingerprint,requestId:"request-012345678901",qty:100,eta:"2026-09-18",readyDate:"2026-09-22",leadTimeDays:2,reference:"Fixture partner answer"};
const user = (resource,actions) => ({listMenu:[{resource,actions}]});
assert.equal(permissions.canConfirm(user("purchaseRequisition",["update"]),"mps"),true);
assert.equal(permissions.canRead(user("purchaseRequisition",["read"]),"mps"),true);
assert.equal(permissions.canConfirm(user("purchaseRequisition",["read"]),"mps"),false);
assert.equal(permissions.canRead(user("mps",["read"]),"mps"),true);
assert.equal(permissions.canConfirm(user("mps",["update"]),"mps"),false,"MPS planning permission alone cannot confirm on behalf of Purchasing");
assert.equal(permissions.canConfirm(user("purchaseRequisition",["update"]),"vendor-plans"),true);
assert.equal(permissions.canConfirm(null,"mps"),false);
assert.equal(permissions.canConfirm({isSuperAdmin:true},"arbitrary-source"),false);
const purchasingWildcard={roleAssignments:[{isActive:true,role:{isActive:true,permissions:[{moduleCode:"purchasing",pageCode:"*",resourceCode:"*",actions:["read","update"]}]}}]};
assert.equal(permissions.canConfirm(purchasingWildcard,"mps"),true,"fixed Purchasing context supports existing Purchasing role");
let status;
permissions.authorize("mps","update")({user:user("mps",["update"]),headers:{"x-page-module":"purchasing"}},{status:n=>{status=n;return {json:()=>{}};}},()=>{throw Error("Client audit header must not grant permission");});
assert.equal(status,403);
for (const leadTimeDays of [null,"",-1,Infinity,"abc",true,[],3651]) assert.throws(()=>store.validate({...input,leadTimeDays},row),/lead time/);
for (const leadTimeDays of [0,.25,"2",3650]) assert.equal(store.validate({...input,leadTimeDays},row).qty,100);
assert.throws(()=>store.validate({...input,sourceFingerprint:"stale"},row),e=>e.code==="ETA_SOURCE_CHANGED");
assert.throws(()=>store.validate({...input,readyDate:"2026-09-17"},row),/QC/);
assert.throws(()=>store.validate({...input,eta:"2026-02-30"},row),/ETA/);
assert.throws(()=>store.validate(input,{...row,canConfirm:false}),/Lengkapi/);

(async()=>{
  const records=[];
  const db={etaConfirmation:{
    findUnique:async({where})=>records.find(r=>r.requestId===where.requestId)||null,
    findMany:async()=>records.length?[records.at(-1)]:[],
    create:async({data})=>{const r={...data,id:`saved-${records.length}`,confirmedAt:new Date()};records.push(r);return r;},
  }};
  const original = monitor.list;
  monitor.list=async(_db,source,month,mpsNumber)=>{
    assert.equal(source,"mps");assert.equal(month,"2026-09");
    return {items:mpsNumber===base.mpsNumber?[store.decorate(base,records.at(-1))]:[]};
  };
  try {
    await assert.rejects(()=>service.confirm(db,"mps",{...input,mpsNumber:""}),/header MPS/);
    await assert.rejects(()=>service.confirm(db,"mps",{...input,mpsNumber:"MPS-OTHER"}),/tidak lagi tersedia/);
    const saved=await service.confirm(db,"mps",input,{username:"purchasing"});
    assert.equal(saved.item.confirmedLeadTimeDays,2);
    assert.equal(saved.item.readiness.ready,true);
    assert.equal(records[0].mpsNumber,"MPS-202609");assert.equal(records[0].mpsRevision,27);
    assert.equal(records[0].confirmedBy,"purchasing");
    assert.equal(records[0].sourceSnapshot.leadTimeDays,2);
    assert.equal(records[0].sourceSnapshot.masterLeadTimeDays,5);
    assert.equal(base.leadTime,5,"confirmation must not edit the master LT");
    assert.equal((await service.confirm(db,"mps",input,{username:"purchasing"})).duplicate,true);
    assert.equal(records.length,1,"idempotent retry cannot double-confirm");
    await assert.rejects(()=>service.confirm(db,"mps",{...input,requestId:"stale-dialog-01234567"},{username:"purchasing"}),e=>e.code==="ETA_CONFIRMATION_CHANGED");
    await assert.rejects(()=>service.confirm(db,"mps",{...input,qty:99},{username:"purchasing"}),/Identitas/);
    await assert.rejects(()=>service.confirm(db,"mps",input,{username:"another-user"}),/Identitas/);
    const decorated=store.decorate(base,records[0]);
    assert.equal(decorated.sourceFingerprint,row.sourceFingerprint,"confirmed LT cannot self-invalidate the source");
    assert.equal(store.readiness(store.decorate({...base,mpsRevision:28},records[0])).ready,false);
    assert.equal(store.readiness(store.decorate({...base,needDate:"2026-09-21"},records[0])).ready,false);
    assert.equal(store.readiness(store.decorate({...base,stale:true},records[0])).ready,false);
    assert.equal(store.readiness({...decorated,confirmedQty:50}).ready,false);
    assert.equal(store.readiness({...decorated,eta:"2026-09-21"}).ready,false);
    assert.equal(store.readiness({...decorated,confirmedLeadTimeDays:null}).ready,false);
    const attached=(await store.attach(db,[base]))[0];
    assert.equal(attached.purchaseMaxDate,"2026-09-16","confirmed 2-day LT changes PO deadline while material readiness stays fixed");
    assert.equal(attached.needDate,"2026-09-22");assert.equal(attached.targetArrivalDate,"2026-09-18");
    console.log("PASS MPS ETA: Purchasing permissions, exact header/revision, required LT, QC/dates, stale-source protection, actor-bound idempotency, LT-dependent Purchase Max. No DB writes.");
  } finally {monitor.list=original;}
})().catch(e=>{console.error(e);process.exitCode=1;});
