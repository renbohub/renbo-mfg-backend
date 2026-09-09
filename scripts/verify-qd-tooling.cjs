const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');
const { PrismaClient } = require('@prisma/client');
const { createService, normalize } = require('../src/prisma/services/qdToolingService');
const env = require('dotenv').parse(fs.readFileSync(path.join(__dirname, '../.env')));
const pool = new Pool({ connectionString: env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
const rollback = new Error('ROLLBACK_QD_VERIFICATION');
async function main() {
  const before = { types: await prisma.qdType.count(), units: await prisma.qdUnit.count(), links: await prisma.qdUnitDies.count(), dies: await prisma.dies.count() };
  const types = await createService(prisma).list('types');
  assert.deepEqual(types.items.filter(t => ['QD_SMALL','QD_MEDIUM','QD_LARGE'].includes(t.typeCode)).map(t => [t.typeCode,t.dimensionA,t.dimensionB]), [
    ['QD_SMALL',210,210],['QD_MEDIUM',300,400],['QD_LARGE',300,600],
  ]);
  assert.throws(() => normalize('types', { typeCode:'X',typeName:'X',dimensionA:0,dimensionB:2,dimensionUnit:'mm' }), /Dimensi/);
  assert.throws(() => normalize('types', { typeCode:'X',typeName:'X',dimensionA:1,dimensionB:2,dimensionUnit:'mm',preferredClass:'BAD' }), /Kelompok/);
  const dies = await prisma.dies.findMany({ where: { isDeleted:false,status:'Active',diesCode:{in:['001','002']} }, orderBy: { diesCode:'asc' }, include:{diesParts:true} });
  assert.equal(dies.length,2);
  try {
    await prisma.$transaction(async tx => {
      const svc = createService(tx);
      const type = await svc.save('types',null,{typeCode:'VERIFY_QD_TEMP',typeName:'Temporary transaction test',dimensionA:210,dimensionB:210,dimensionUnit:'mm',preferredClass:'SMALL'});
      const unit = await svc.save('units',null,{qdCode:'VERIFY_QD_TEMP',qdName:'Temporary transaction test',qdTypeId:type.id,status:'Active',diesIds:[dies[0].id,dies[1].id,dies[0].id]});
      assert.equal(unit.diesCount,2, 'Duplicate selected IDs must not multiply tooling');
      assert.equal(unit.usageMode,'Bergantian — satu dies per waktu');
      assert.match(unit.partSummary,/C001-0002-010/);
      assert.match(unit.partSummary,/C002-0006-010/);
      assert(!Object.hasOwn(unit,'cycleTime') && !Object.hasOwn(unit,'cavity'), 'QD must not aggregate dies production metrics');
      await assert.rejects(()=>svc.save('units',unit.id,{diesIds:['not-a-die']}), /tidak ditemukan/);
      assert.equal((await svc.get('units',unit.id)).diesCount,2,'Failed validation must retain composition');
      await assert.rejects(()=>svc.remove('types',[type.id]), /masih digunakan/);
      await assert.rejects(()=>svc.save('types',type.id,{isActive:false}), /masih digunakan/);
      const previousLink=await tx.qdUnitDies.findUnique({where:{qdUnitId_diesId:{qdUnitId:unit.id,diesId:dies[0].id}}});
      const swapped=await svc.save('units',unit.id,{diesIds:[dies[1].id]});
      assert.deepEqual(swapped.diesIds,[dies[1].id]);
      assert.equal((await tx.qdUnitDies.findUnique({where:{id:previousLink.id}})).isActive,false);
      assert.equal((await svc.save('units',unit.id,{diesIds:[]})).diesCount,0);
      await svc.save('units',unit.id,{diesIds:[dies[0].id]});
      assert.equal((await tx.qdUnitDies.findUnique({where:{qdUnitId_diesId:{qdUnitId:unit.id,diesId:dies[0].id}}})).id,previousLink.id,'Restoring membership must reuse record');
      await svc.remove('units',[unit.id]);
      assert.equal((await svc.list('units',{q:'VERIFY_QD_TEMP'})).total,0);
      assert.equal((await svc.list('units',{q:'VERIFY_QD_TEMP',isDeleted:'true'})).total,1);
      await svc.save('units',unit.id,{isDeleted:false});
      assert.equal((await svc.get('units',unit.qdCode)).isDeleted,false);
      assert.equal((await svc.get('types',type.id)).unitCount,1);
      throw rollback;
    },{timeout:20000});
  } catch(error) { if(error!==rollback) throw error; }
  const after={types:await prisma.qdType.count(),units:await prisma.qdUnit.count(),links:await prisma.qdUnitDies.count(),dies:await prisma.dies.count()};
  assert.deepEqual(after,before,'All temporary records must be rolled back');
  const diesAfter=await prisma.dies.findMany({where:{id:{in:dies.map(d=>d.id)}},orderBy:{diesCode:'asc'},include:{diesParts:true}});
  assert.deepEqual(diesAfter,dies,'Existing dies and part links must remain unchanged');
  console.log(JSON.stringify({ok:true,checks:'3 seeded sizes; multiple dies; part mapping; invalid reference; archive protection; membership swap/clear/restore; no CT/cavity aggregation; rollback; existing dies preserved',counts:after},null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{await prisma.$disconnect();await pool.end()});
