require('dotenv').config({quiet:true});process.env.NODE_ENV='test';
const {prisma}=require('../src/prisma');
const {buildLedger,attachPhaseNetting}=require('../src/prisma/services/planning/mpsWorkbenchService');
(async()=>{
 const doc=await prisma.mPS.findFirst({where:{sourceKey:'MONTH:2026-09',isDeleted:false,status:{not:'Superseded'}},orderBy:{updatedAt:'desc'},include:{details:{where:{isDeleted:false},include:{demandSources:true}},deliveryPlans:true}});
 const stocks=await prisma.stockBalance.findMany({where:{partCode:{in:doc.details.map(d=>d.partCode)},isDeleted:false,warehouse:{isDeleted:false,availableForProduction:true}},select:{partCode:true,qtyOnHand:true,qtyAvailable:true,qtyReserved:true,qtyQC:true}});
 const reservations=await prisma.stockReservation.findMany({where:{partCode:{in:doc.details.map(d=>d.partCode)},isDeleted:false,status:{equals:'Active',mode:'insensitive'}}});
 const result=doc.details.map(d=>{const l=buildLedger({detail:d,stockLines:stocks.filter(s=>s.partCode===d.partCode),reservations:reservations.filter(s=>s.partCode===d.partCode),receipts:[]});return {id:d.id,part:d.partCode,planned:d.qtyPlanned,opening:d.openingAvailableQty,buffer:d.bufferQty,mode:d.calculationTrace?.bufferAllocationMode,phases:attachPhaseNetting(l.phases,l.ledger),plans:doc.deliveryPlans.filter(p=>p.mpsDetailId===d.id).map(p=>({target:p.sourceDeliveryTargetId,qty:p.qtyPlanned,fg:p.fgRequiredDate,delivery:p.plannedDate,split:p.fgFinishSplitNumber}))};});
 require('fs').writeFileSync('../tmp/ppic-sandbox/source-phases.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result.map(r=>({...r,phases:r.phases.map(p=>({target:p.deliveryTargetId,qty:p.qty,stock:p.stockUsedQty,produce:p.plannedProductionQty,fg:p.fgRequiredDate,delivery:p.targetDeliveryDate}))})),null,2));
})().then(()=>process.exit(0),e=>{console.error(e);process.exit(1)});
