require('dotenv').config({quiet:true});
process.env.NODE_ENV='test';
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {prisma}=require('../src/prisma');
const {readDemoDate,withBusinessDate}=require('../src/prisma/utils/businessClock');
const {sourceFingerprint}=require('../src/prisma/services/planning/integratedPlanService');
const {seed}=require('../src/prisma/services/planning/ppicSandboxCachedSeed');
const engine=require('../../library/ppic-planning/engine');
(async()=>{
  const month=process.argv[2]||'2026-09';
  await withBusinessDate(await readDemoDate(prisma),async()=>{
    const before=await sourceFingerprint(prisma,`MONTH:${month}`);
    const result=await seed(prisma,{mpsNumber:`MONTH:${month}`,user:{username:'ppic-preview-verification'}});
    const reused=await seed(prisma,{mpsNumber:`MONTH:${month}`,user:{username:'ppic-preview-verification'}});
    assert.equal(reused.cache.hit,true,'Unchanged source must reuse initial solver snapshot');
    assert.equal(reused.fingerprint,result.fingerprint);
    console.log(JSON.stringify({cold:result.cache,warm:reused.cache}));
    const after=await sourceFingerprint(prisma,`MONTH:${month}`);
    assert.equal(after,before,'Preview must roll back all planning writes');
    const computed=engine.calculate(result);
    for(const net of result.netting||[]){
      const phases=result.groups.filter(g=>g.partCode===net.partCode);
      assert.ok(Math.abs(phases.reduce((sum,g)=>sum+g.qty,0)-net.productionQty)<1e-5,'Distributed phases conserve official net FG production');
      assert.ok(phases.every(g=>g.bufferQty===0||g.customerProductionQty>0||g.customer==='Buffer'),'Buffer must not revive stock-covered deliveries');
    }
    for(const scenario of [computed,engine.calculate(result,{[result.nodes.find(n=>n.kind==='vendor').id]:{leadDays:2}})]){
      const {netTimePhasedDemand}=require('../src/prisma/services/planning/timePhasedNettingService');
      for(const pool of result.materialNetting.pools){
        const rows=scenario.rows.filter(n=>n.materialPoolId===pool.id&&n.nettingBasis).sort((a,b)=>a.requiredAt-b.requiredAt||a.id.localeCompare(b.id));
        const ready=at=>engine.fit(result.workingCalendar.windows,1,at,false)?.start;
        const supplies=pool.supplies.map(s=>({...s,availableDate:new Date(ready(Date.parse(s.availableAt+'Z')/60000)*60000)}));
        if(pool.openingQty>0)supplies.push({id:'opening:'+pool.id,qty:pool.openingQty,confidence:'FIRM',availableDate:new Date(ready(engine.at(result.businessDate,480))*60000)});
        const reference=netTimePhasedDemand({openingQty:0,supplyEvents:supplies,demandEvents:rows.map(n=>({id:n.id,qty:Math.round(n.grossQty*1e6)/1e6,requiredDate:new Date(n.requiredAt*60000)}))});
        const used=new Map();
        for(const n of rows){
          assert.ok(Math.abs(n.grossQty-n.qty-n.onHandQty-n.firmSupplyQty-n.plannedSupplyQty)<1e-6,'Material gross = allocated stock + firm + planned + net');
          assert.ok(Math.abs(n.qty-reference.find(r=>r.id===n.id).netRequirement)<2e-6,'Local netting agrees with independent dated MRP netting');
          for(const allocation of n.supplyTimeline){
            assert.ok(Date.parse(allocation.availableAt+'Z')/60000<=n.requiredAt,'No future supply allocated before ready');
            used.set(allocation.id,(used.get(allocation.id)||0)+allocation.qty);
          }
          assert.equal(n.requiredAt,Math.min(...scenario.rows.filter(r=>r.dependencies.includes(n.id)).map(r=>r.planned.start)),'Consumption date follows final process placement');
        }
        for(const [id,qty]of used)assert.ok(qty<=supplies.find(s=>s.id===id).qty+2e-6,'Stock and each shipment used once');
      }
      for(const group of scenario.groups){
        const members=scenario.rows.filter(n=>n.groupId===group.id),first=Math.min(...members.filter(n=>['process','vendor'].includes(n.kind)&&Number.isFinite(n.planned.start)).map(n=>n.planned.start));
        for(const material of members.filter(n=>n.kind==='material'&&Number.isFinite(n.planned.end)))assert.ok(material.planned.end<=first,'MRP kit must be ready before first FG process');
      }
      for(const n of scenario.rows.filter(n=>n.kind!=='fg'))for(const span of n.planned.segments){
        const windows=n.kind==='process'?result.resources.find(r=>r.id===n.machineId).windows:result.workingCalendar.windows;
        assert.ok(engine.subtract([span],windows).length===0,'All process/material/vendor segments must skip calendar closures');
      }
    }
    const byId=new Map(computed.rows.map(n=>[n.id,n]));
    for(const n of computed.rows){
      if(!Number.isFinite(n.planned.start))continue;
      for(const id of n.dependencies){const parent=byId.get(id);if(Number.isFinite(parent.planned.end))assert.ok(parent.planned.end<=n.planned.start+1e-6,`BOM precedence: ${parent.partCode} -> ${n.partCode}`);}
      if(n.kind==='process')assert.equal(n.planned.segments.reduce((sum,[a,b])=>sum+b-a,0),n.calculation.minutes,'CP-SAT segments conserve formula duration');
    }
    const reservations=new Map();
    for(const n of computed.rows.filter(n=>n.kind==='process')){
      const machine=result.resources.find(r=>r.id===n.machineId),tool=n.machineOptions.find(r=>r.machineId===n.machineId)?.diesId||n.diesId;
      for(const span of n.planned.segments){
        assert.ok(engine.subtract(machine.windows,machine.blocked).some(w=>span[0]>=w[0]&&span[1]<=w[1]),'Every segment fits an available machine window');
        for(const key of [n.machineId,tool].filter(Boolean)){const list=reservations.get(key)||[];list.push(span);reservations.set(key,list);}
      }
    }
    for(const spans of reservations.values()){spans.sort((a,b)=>a[0]-b[0]);for(let i=1;i<spans.length;i++)assert.ok(spans[i-1][1]<=spans[i][0],'Shared machine/dies must not overlap');}
    const dir=path.resolve(__dirname,'../../tmp/ppic-sandbox');fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(path.join(dir,'seed.json'),JSON.stringify(result));
    console.log(JSON.stringify({rollback:'PASS',materialNetting:'PASS',materialPools:computed.materialNetting,nodes:result.nodes.length,groups:computed.groups.length,initial:result.initial,computeMs:computed.elapsedMs,statuses:computed.groups.map(g=>({part:g.partCode,target:g.targetDate,purchase:g.firstPurchase,status:g.status,spare:g.spareDays,issues:g.issues.slice(0,3)})),issues:result.issues},null,2));
  });
})().then(()=>process.exit(0),error=>{console.error(error.stack);process.exit(1);});
