const assert = require('node:assert/strict');
const { findRoundedShiftPlacement } = require('../src/prisma/services/planning/shiftQuantityPolicy');
const { scheduleFitFirstPerRoute } = require('../src/prisma/services/planning/capacityRecommendationService');

function split(total, capacities) {
  const quantities = [];
  for (const capacity of capacities) {
    const result = findRoundedShiftPlacement(total, qty => qty <= capacity ? { capacity } : null);
    if (!result) continue;
    assert(result.qty <= capacity);
    quantities.push(result.qty);
    total -= result.qty;
  }
  assert.equal(total, 0);
  return quantities;
}
assert.deepEqual(split(37350, [15999, 12900, 10900, 500]), [15000, 12000, 10000, 350]);
assert.deepEqual(split(750, [10000]), [750]);
assert.deepEqual(split(1500, [600, 600, 600]), [600, 600, 300]);
assert.equal(findRoundedShiftPlacement(1000, () => null), null);
assert.equal(findRoundedShiftPlacement(0, () => ({})), null);

function schedule(qty, { uomCode = 'PCS', manual = 0, cycleTime = 2, due = 4320, segmented = false, successor = false } = {}) {
  const route = { id:'route', routingMode:'INHOUSE', machineSpecificationCode:'SPEC', cycleTime, process:{processCode:'WELD'} };
  const task = { route, detail: {partCode:'FG', qtyPlanned:qty, uomCode} };
  const next = {route:{...route,id:'next',machineSpecificationCode:'NEXT'},detail:{...task.detail}};
  const job = segmented ? {qty,campaignSegments:[{productionQty:1500,sourceDeliveryTargetId:'customer'},{productionQty:qty-1500,sourceDeliveryTargetId:'buffer'}]} : {qty};
  if (segmented) task.sourceDetails = [
    {qtyPlanned:1500,uomCode,notes:'[MRP-TARGET:customer]'},
    {qtyPlanned:qty-1500,uomCode,notes:'[MRP-TARGET:buffer]'},
  ];
  return scheduleFitFirstPerRoute({
    graph: {ordered:successor?[task,next]:[task], predecessors:new Map([['route',new Set()],['next',new Set(['route'])]])},
    job, batches:segmented?[1500,qty-1500]:[qty / 2, qty / 2], receiptQty:qty, receiptQtyBeforeJob:0, preserveBatchBoundaries:segmented,
    trialUsage:new Map(), trialDiesUsage:new Map(), trialManualByRoute:new Map([['route',manual]]), manualCompletionByRoute:new Map(),
    machineBySpecification:new Map([['SPEC',[{id:'machine',machineCode:'M',shift1Start:'08:00',shift1End:'16:00'}]],['NEXT',[{id:'nextMachine',machineCode:'N',shift1Start:'08:00',shift1End:'16:00'}]]]),
    diesForRoute:()=>[], mode:'NORMAL', due, executionFloor:0,
    periodStart:new Date('2026-09-01T00:00:00Z'),periodEnd:new Date('2026-09-03T00:00:00Z'),
    preset:{shiftCount:1,includeSaturday:true,includeSunday:true,efficiency:100},
  });
}
const result = schedule(25350);
assert.equal(result.failed, undefined, JSON.stringify(result.failed));
assert.deepEqual(result.allocations.map(row=>row.qty), [12000,12000,1000,350]);
assert.equal(result.allocations.reduce((sum,row)=>sum+row.qty,0),25350);
for (const row of result.allocations) {
  assert(row.end <= 4320);
  assert(Math.abs(row.end-row.start-row.qty*0.04)<1e-6);
  assert.equal(row.shift,'1');
}
const covered = schedule(25350,{manual:350});
assert.equal(covered.failed,undefined);
assert.equal(covered.allocations.reduce((sum,row)=>sum+row.qty,0),25000);
assert(covered.allocations.every(row=>row.qty%1000===0));
const small = schedule(97);
assert.equal(small.allocations[0].qty,97);
const tight = schedule(25350,{due:960});
assert.equal(tight.failed.code,'CAPACITY_BEFORE_DUE_UNAVAILABLE');
const continuous = schedule(25.35,{uomCode:'KG'});
assert.equal(continuous.allocations[0].qty,25.35);
const campaign = schedule(3750,{segmented:true});
assert.equal(campaign.failed,undefined);
assert.equal(campaign.allocations.filter(row=>row.receiptQtyBeforeBatch<1500).reduce((sum,row)=>sum+row.qty,0),1500);
assert.equal(campaign.allocations.filter(row=>row.receiptQtyBeforeBatch>=1500).reduce((sum,row)=>sum+row.qty,0),2250);
assert(campaign.allocations.every(row=>row.qty%1000===0||row.qty<1000));
const chain = schedule(1350,{successor:true});
assert.equal(chain.failed,undefined);
const first = chain.allocations.filter(row=>row.task.route.id==='route');
const second = chain.allocations.filter(row=>row.task.route.id==='next');
assert.equal(second.reduce((sum,row)=>sum+row.qty,0),1350);
assert(Math.min(...second.map(row=>row.start))>=Math.max(...first.map(row=>row.end))+120);
assert(second.every(row=>row.predecessorDraftIndexes.length===first.length));
console.log('PASS: rounded shift policy, small/remainder/capacity cases, real route/calendar placement, quantity and runtime conservation, manual coverage, due blocker, continuous UOM');
