const test=require('node:test');const assert=require('node:assert/strict');
const db={};require.cache[require.resolve('../src/prisma/index')]={exports:{prisma:db}};
const controller=require('../src/prisma/controllers/inventory/StockBalanceController');
const {normalizedPolicy,createPolicyController}=require('../src/prisma/services/inventory/stockBalancePolicyService');
function response(){return {code:200,body:null,status(code){this.code=code;return this;},json(body){this.body=body;return this;}};}
test('all direct manual balance create/adjust/delete controller paths reject before any database call',async()=>{
  db.stockBalance=new Proxy({},{get(){throw new Error('must not access database');}});
  for(const name of ['adjust','upsert','remove']){const res=response();await controller[name]({user:{isSuperAdmin:true},params:{id:'B'},body:{qtyOnHand:100,qtyAvailable:100,isDeleted:true,approved:true,approvedBy:'spoof'}},res,e=>{throw e;});assert.equal(res.code,409,name);assert.equal(res.body.code,'STOCK_OPNAME_APPROVAL_REQUIRED');}
});
test('policy rejects mass assignment, quantity changes and invalid merged thresholds',()=>{
  const existing={minStock:10,maxStock:100,reorderPoint:20};
  for(const field of ['qtyOnHand','qtyReserved','qtyQC','qtyAvailable','isDeleted','warehouseCode','reorderState','stockReservations','id'])assert.throws(()=>normalizedPolicy({[field]:0},existing),/Hanya/);
  assert.throws(()=>normalizedPolicy({minStock:30},existing),/reorderPoint/);assert.throws(()=>normalizedPolicy({maxStock:15},existing),/reorderPoint/);
  for(const value of [NaN,Infinity,-1,'20',null])assert.throws(()=>normalizedPolicy({minStock:value},existing),/angka/);
  assert.deepEqual(normalizedPolicy({reorderPoint:null,maxStock:null},existing),{reorderPoint:null,maxStock:null});
});
test('policy transaction locks target and updates only authorized metadata while preserving quantities',async()=>{
  const row={id:'B',minStock:10,maxStock:100,reorderPoint:20,qtyOnHand:67,qtyReserved:7,qtyQC:10,qtyAvailable:50,isDeleted:false};let locked=false;const writes=[];
  const tx={$queryRaw:async()=>{locked=true;return[];},stockBalance:{findFirst:async()=>{assert.ok(locked);return row;},update:async q=>{writes.push(q);return {...row,...q.data};}}};
  const ctrl=createPolicyController({$transaction:fn=>fn(tx)});const res=response();await ctrl({params:{id:'B'},body:{minStock:15,reorderPoint:25}},res,e=>{throw e;});assert.equal(res.code,200);assert.deepEqual(writes[0].data,{minStock:15,reorderPoint:25});for(const field of ['qtyOnHand','qtyReserved','qtyQC','qtyAvailable'])assert.equal(res.body[field],row[field]);
});
test('forged policy qty rejected before transaction; missing balances not recreated',async()=>{
  let transactions=0;const ctrl=createPolicyController({$transaction:async fn=>{transactions++;return fn({$queryRaw:async()=>[],stockBalance:{findFirst:async()=>null}});}});
  let res=response();await ctrl({params:{id:'B'},body:{qtyOnHand:0}},res,e=>{throw e;});assert.equal(res.code,400);assert.equal(transactions,0);
  res=response();await ctrl({params:{id:'B'},body:{minStock:1}},res,e=>{throw e;});assert.equal(res.code,404);assert.equal(transactions,1);
});
