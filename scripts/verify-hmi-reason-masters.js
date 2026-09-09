"use strict";
require("dotenv").config({ quiet: true });
const assert = require("node:assert/strict");
const { prisma } = require("../src/prisma");
const service = require("../src/prisma/services/hmiReasonMasterService");
const rollback = new Error("ROLLBACK_VERIFICATION_DATA");
(async () => {
  let checks = 0;
  try {
    await prisma.$transaction(async tx => {
      let serial = 0;
      const db = { $queryRawUnsafe: (...args) => tx.$queryRawUnsafe(...args),
        $transaction: async fn => {
          const name = `hmi_verify_${++serial}`;
          await tx.$executeRawUnsafe(`SAVEPOINT ${name}`);
          try { const result = await fn(db); await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${name}`); return result; }
          catch (e) { await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${name}`); throw e; }
        } };
      const suffix = Date.now().toString(36).toUpperCase();
      const create = (kind, body) => service.save(db, kind, null, body, "verification-rollback");
      const rejects = async (fn, code) => { await assert.rejects(fn, e => e.code === code); checks++; };
      const a = await create("areas", { areaCode: `TEST-${suffix}`, description: "Test area" });
      const b = await create("areas", { areaCode: `TEST2-${suffix}`, description: "Other area" });
      const ng = await create("ng", { parentId: a.id, description: "Scratch", sortOrder: 2 });
      const child = await create("ng-sub", { parentId: ng.id, description: "Surface" });
      await create("ng", { parentId: b.id, description: "Scratch" });
      const first = await create("ng", { parentId: a.id, description: "Dent", sortOrder: 1 });
      const dt = await create("downtime", { parentId: a.id, description: "Break", stopClass: "PLANNED", countsAsLoss: false });
      await create("downtime-sub", { parentId: dt.id, description: "Lunch" });
      const catalog = await service.catalog(db, { areaCode: a.areaCode });
      assert.deepEqual(catalog.rejections.map(r => r.id), [first.id, ng.id]); checks++;
      assert.equal(catalog.rejections[1].children[0].id, child.id); checks++;
      assert.equal(catalog.downtimes[0].countsAsLoss, false); checks++;
      assert.equal(catalog.source, "ERP_DATABASE"); checks++;
      await rejects(() => create("ng", { parentId: a.id, description: " scratch " }), "HMI_MASTER_DUPLICATE");
      await rejects(() => create("ng", { parentId: a.id, description: "-" }), "HMI_MASTER_INVALID");
      await rejects(() => service.save(db, "ng", ng.id, { parentId: b.id }, "test"), "HMI_PARENT_IMMUTABLE");
      await rejects(() => service.save(db, "ng", ng.id, { expectedUpdatedAt: "2000-01-01" }, "test"), "HMI_MASTER_CONFLICT");
      const paged = await service.list(db, "ng", { parentId: a.id, limit: 1, page: 2 });
      assert.equal(paged.items[0].id, ng.id); assert.equal(paged.total, 2); checks++;
      const malicious = "x'); DROP TABLE hmi_list_area; --";
      await create("ng", { parentId: b.id, description: malicious });
      assert.equal((await service.list(db, "ng", { parentId: b.id, q: malicious })).total, 1); checks++;
      await service.archive(db, "ng", ng.id, false, "test");
      assert.equal((await service.catalog(db, { areaId: a.id })).rejections.some(r => r.id === ng.id), false); checks++;
      await service.archive(db, "ng", ng.id, true, "test");
      assert.equal((await service.get(db, "ng", ng.id)).isActive, false); checks++;
      await service.save(db, "ng", ng.id, { isActive: true }, "test");
      await service.save(db, "areas", a.id, { isActive: false }, "test");
      assert.equal((await service.catalog(db, { areaId: a.id })).rejections.length, 0); checks++;
      await rejects(() => create("ng-sub", { parentId: ng.id, description: "Blocked" }), "HMI_PARENT_INACTIVE");
      await rejects(() => service.list(db, "ng; DROP TABLE x", {}), "HMI_MASTER_INVALID");
      await rejects(() => service.list(db, "ng", { page: "1 OR 1=1" }), "HMI_MASTER_INVALID");
      const [audit] = await tx.$queryRawUnsafe("SELECT count(*)::int AS count FROM tbl_hmi_reason_audit WHERE actor_id=$1", "verification-rollback");
      assert.ok(audit.count >= 9); checks++;
      throw rollback;
    }, { timeout: 30000 });
  } catch (e) { if (e !== rollback) throw e; }
  const [remaining] = await prisma.$queryRawUnsafe("SELECT count(*)::int AS count FROM tbl_hmi_reason_audit WHERE actor_id=$1", "verification-rollback");
  assert.equal(remaining.count, 0);
  console.log(`PASS: ${checks} HMI master checks through Prisma/PostgreSQL; all test records rolled back.`);
})().catch(e => { console.error(e.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
