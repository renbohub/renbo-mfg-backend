const {test}=require('node:test'),assert=require('node:assert/strict');
const {capture,physicalStock}=require('../src/prisma/services/planning/ppicSandboxMaterialPools');
test('physical availability excludes reserved, QC and embedded WIP stock',()=>{
  const p=physicalStock([{supplyClass:'WAREHOUSE_MATERIAL',qtyOnHand:100,qtyAvailable:90,qtyReserved:20,qtyQC:10},{supplyClass:'WIP_EQUIVALENT',qtyOnHand:50,qtyAvailable:50}],'KG');
  assert.equal(p.openingQty,70);assert.equal(p.excludedWipQty,50);assert.equal(p.uom,'kg');
});
test('capture shares company material across BOM occurrences but isolates customer ownership',()=>{
  const requirements=[{id:'a',partCode:'RAW1',_planningStockKey:'MATERIAL:M',_physicalStockKey:'MATERIAL:M'},{id:'b',partCode:'RAW2',_planningStockKey:'MATERIAL:M',_physicalStockKey:'MATERIAL:M'},
    {id:'c',partCode:'RAW1',materialSupplyType:'CUSTOMER_SUPPLIED',supplyCustomerCode:'C003',_planningStockKey:'CUSTOMER:C003|M|kg',_physicalStockKey:'MATERIAL:M'}];
  const p=capture(requirements,[],{'MATERIAL:M':{uom:'kg',openingQty:100,excludedWipQty:0}},{RAW1:'kg',RAW2:'kg'});
  assert.equal(p.pools.length,2);assert.equal(p.requirementPools.a,p.requirementPools.b);assert.equal(p.pools[0].openingQty,100);assert.equal(p.pools[1].openingQty,0);assert.equal(p.pools[1].excludedGeneralStockQty,100);
});
test('full future supply is retained once per document line, with plant-time QC release',()=>{
  const rows=[{id:'a',partCode:'RAW',_planningStockKey:'M'}];const events=[{id:'line1',supplyKey:'M',sourceType:'PO',sourceNumber:'PO1',qty:5,availableDate:'2026-11-10'},{id:'line2',supplyKey:'M',sourceType:'PO',sourceNumber:'PO1',qty:6,availableDate:'2026-11-10'},
    {id:'qc',supplyKey:'M',sourceType:'CUSTOMER_STOCK',qty:2,availableDate:'2026-09-10T12:00:00Z'}];
  const p=capture(rows,[...events,events[0]],{M:{uom:'kg',openingQty:0}},{RAW:'kg'}).pools[0];
  assert.equal(p.supplies.length,3);assert.equal(p.supplies[0].availableAt,'2026-11-10T08:00');assert.equal(p.supplies[2].availableAt,'2026-09-10T19:00');
});
