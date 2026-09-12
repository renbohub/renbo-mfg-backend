const {test}=require('node:test');
const assert=require('node:assert/strict');
const {netMpsBucket,buildMpsCalculationTrace}=require('../src/prisma/services/planning/mpsNettingService');
const {distributeBuffer}=require('../src/prisma/services/planning/ppicPhaseBuffer');
const {buildMpsCalculationBreakdown}=require('../src/prisma/services/planning/mpsCalculationService');
const {expandMpsDetailsByDeliveryPhases}=require('../src/prisma/controllers/planning/MRPController').__test;
const {buildGraph}=require('../src/prisma/services/planning/ppicSandboxService');
test('sandbox displays delivery, buffer and rounding separately without changing stock coverage',()=>{
 const {groups}=buildGraph([{id:'r',partCode:'FG',netRequirement:18000,grossRequirement:18000,bufferQty:7673,notes:'MPS [MPS-ROUNDING:327]',requiredDate:'2026-09-20',treePath:'r',customerPegging:[{qty:10000}]}],[],new Map());
 assert.equal(groups[0].qty,18000);assert.equal(groups[0].roundingQty,327);
 assert.equal(groups[0].customerProductionQty,10000);assert.equal(groups[0].stockCoveredQty,0);
});
test('17673 after buffer becomes 18000 and 327 remains auditable in stock and trace',()=>{
 const n=netMpsBucket({uomCode:'PCS',grossDemandQty:10000,targetEndingStockQty:7673});
 assert.equal(n.plannedProductionQty,18000);assert.equal(n.lotRoundingDeltaQty,327);
 assert.equal(n.projectedEndingStockQty,8000);assert.equal(n.targetEndingStockQty,7673);
 const trace=buildMpsCalculationTrace({netting:n});
 const view=buildMpsCalculationBreakdown({calculationTrace:trace,metrics:n,mpsQty:18000});
 assert.equal(view.rawNetRequirementQty,17673);assert.equal(view.lotRoundingDeltaQty,327);assert.equal(view.finalMpsQty,18000);
 assert.equal(view.baselineMpsQty,18000);
 const child=buildMpsCalculationBreakdown({calculationTrace:trace,metrics:{plannedProductionQty:5000},mpsQty:5000});
 assert.equal(child.rawNetRequirementQty,5000);assert.equal(child.lotRoundingDeltaQty,0);
 const row=distributeBuffer([{qtyPlanned:10000}],7673,'PCS')[0];
 assert.equal(row.qtyPlanned,18000);assert.equal(row._productionRoundingQty,327);assert.equal(row.bufferQty,7673);
});
test('initial monthly quantities round once; zero and continuous UOM remain exact',()=>{
 for(const [qty,unit,expected] of [[117,'PCS',1000],[0,'PCS',0],[18000,'PCS',18000],[17673,'KG',17673]]) {
  const n=netMpsBucket({uomCode:unit,grossDemandQty:qty});assert.equal(n.plannedProductionQty,expected);
 }
 const n=netMpsBucket({uomCode:'PCS',grossDemandQty:10000,targetEndingStockQty:7673,openingAvailableQty:18000});
 assert.equal(n.plannedProductionQty,0);
});
test('MRP phase input for BOM explosion includes rounding but preserves actual customer demand',()=>{
 const d={id:'d',partCode:'FG',part:{baseUomCode:'PCS'},qtyPlanned:17673,forecastQty:10000,effectiveDemandQty:17673,bufferQty:7673,startDate:new Date('2026-09-01'),endDate:new Date('2026-09-30')};
 const phases=[{id:'p',mpsDetailId:'d',phaseNumber:1,plannedDate:new Date('2026-09-20'),qtyPlanned:10000,sourceType:'FORECAST'}];
 const rows=expandMpsDetailsByDeliveryPhases([d],phases,new Map(),{distributeBuffer:true});
 assert.equal(rows[0].qtyPlanned,18000);assert.equal(rows[0].effectiveDemandQty,18000);
 assert.equal(rows[0]._deliveryDemandQty,10000);assert.equal(rows[0]._productionRoundingQty,327);
 const official=expandMpsDetailsByDeliveryPhases([d],phases);
 assert.equal(official.reduce((s,r)=>s+r.qtyPlanned,0),17673);
});
