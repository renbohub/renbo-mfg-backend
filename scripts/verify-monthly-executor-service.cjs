'use strict';
process.env.NODE_ENV = 'test';
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const service = require('../src/prisma/services/planning/monthlyExecutorService');
const { withBusinessDate } = require('../src/prisma/utils/businessClock');

function unit() {
  const ctx = { scope: { allocationId: 'a', lineNumber: 1, mbomProcessId: 'r', qty: 1000, uomCode: 'pcs' }, plan: { periodStart: '2026-09-01', periodEnd: '2026-09-30' }, policy: { allowedModes: ['INHOUSE', 'VENDOR'], allowSplit: true, eligibleVendorIds: ['v'], machinePolicy: { mode: 'SINGLE', resources: [{ machineId: 'm' }] } } };
  const proposal = { reason: 'Capacity change', allocations: [{ routingMode: 'INHOUSE', plannedQty: 600, machineId: 'm', scheduleDate: '2026-09-10', shift: '1' }, { routingMode: 'VENDOR', plannedQty: 400, vendorId: 'v', vendorSendDate: '2026-09-10', vendorReturnDate: '2026-09-15' }] };
  assert.equal(service.normalizeProposal(ctx, proposal).allocations.reduce((sum, row) => sum + row.plannedQty, 0), 1000);
  assert.throws(() => service.normalizeProposal(ctx, { ...proposal, allocations: [proposal.allocations[0]] }), /Total pembagian/);
  assert.throws(() => service.normalizeProposal({ ...ctx, policy: { ...ctx.policy, allowSplit: false } }, proposal), /Pembagian/);
  assert.throws(() => service.normalizeProposal(ctx, { ...proposal, allocations: [{ ...proposal.allocations[1], plannedQty: 1000, vendorReturnDate: '2026-09-09' }] }), /ETA kembali/);
  assert.throws(() => service.normalizeProposal(ctx, { ...proposal, allocations: [{ ...proposal.allocations[1], plannedQty: 1000, vendorId: 'unqualified' }] }), /Vendor belum/);
  assert.throws(() => service.normalizeProposal(ctx, { ...proposal, allocations: [{ ...proposal.allocations[0], plannedQty: 1000.1 }] }), /bilangan bulat/);
  const existingVendor = { routingMode: 'VENDOR', vendorId: 'v', scheduleDate: '2026-09-10', vendorReturnDate: '2026-09-15', plannedStartTime: '02:01', plannedEndTime: '02:01', capacityMode: 'EXTRA_SHIFT' };
  const sameVendorProposal = { ...proposal, allocations: [{ ...proposal.allocations[1], plannedQty: 1000 }] };
  const retained = service.normalizeProposal({ ...ctx, source: existingVendor }, sameVendorProposal).allocations[0];
  assert.equal(retained.plannedStartTime, '02:01', 'Unchanged vendor window retains its two-hour predecessor handoff');
  assert.equal(retained.plannedEndTime, '02:01');
  assert.equal(retained.capacityMode, 'EXTRA_SHIFT');
  assert.equal(service.normalizeProposal({ ...ctx, source: existingVendor }, proposal).allocations[0].plannedStartTime, null, 'Changed executor must not inherit unrelated vendor clock');
  const checkedContext = { ...ctx, plan: { ...ctx.plan, id: 'p', status: 'Released', freezeFenceDays: 25 }, policy: { ...ctx.policy, errors: [] }, source: { scheduleDate: '2026-09-10' }, sessions: 0, documents: [], successors: [], relatedPlans: [] };
  withBusinessDate('2026-08-20', () => {
    assert(service.basicBlockers(checkedContext, service.normalizeProposal(ctx, proposal)).some(row => row.code === 'DPP_FREEZE_OVERRIDE_APPROVAL_REQUIRED'));
    const approved = { ...checkedContext, plan: { ...checkedContext.plan, capacityOverrideApproved: true } };
    assert.equal(service.basicBlockers(approved, service.normalizeProposal(ctx, proposal)).length, 0);
    assert(service.basicBlockers(approved, { ...service.normalizeProposal(ctx, proposal), reason: 'x' }).some(row => row.code === 'CAPACITY_FREEZE_FENCE'));
    assert(service.basicBlockers({ ...approved, successors: [{ scheduleDate: '2026-09-11' }] }, service.normalizeProposal(ctx, proposal)).some(row => row.code === 'EXECUTOR_SUCCESSOR_EARLY'));
    assert(service.basicBlockers({ ...approved, documents: [{ executed: true }] }, service.normalizeProposal(ctx, proposal)).some(row => row.code === 'EXECUTOR_ALREADY_EXECUTED'));
  });
  console.log('PASS executor quantity conservation, qualification, split permission and dates');
}

// All real DB writes, numbering, PR synchronization and audit fixtures roll back.
// Nested app transactions use savepoints so preview rollback cannot leak into apply.
async function integration() {
  const { prisma: db } = require('../src/prisma');
  const stop = new Error('EXECUTOR_TEST_ROLLBACK');
  const tag = `QA-EXEC-${randomUUID()}`;
  try {
    await db.$transaction(async tx => {
      let savepoint = 0;
      const client = new Proxy(tx, { get(target, key) {
        if (key !== '$transaction') return target[key];
        return async callback => {
          const name = `executor_test_${++savepoint}`;
          await tx.$executeRawUnsafe(`SAVEPOINT ${name}`);
          try { const result = await callback(client); await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${name}`); return result; }
          catch (error) { await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${name}`); await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${name}`); throw error; }
        };
      } });
      const ref = await tx.mBOMProcess.findFirst({ where: { routingMode: 'VENDOR', vendorId: { not: null }, isDeleted: false }, include: { mbomDetail: true, process: true } });
      assert(ref, 'Existing qualified vendor routing required for fixture');
      const machine = await tx.machine.create({ data: { machineCode: tag, machineName: 'Fixture machine', machineSpecificationCode: tag, status: 'Active', cycleTime: 1, costingRate: 1 } });
      const header = await tx.mBOMHeader.create({ data: { noReg: tag, partId: ref.mbomDetail.partId, uomCode: 'pcs', revision: 999, effectiveDate: new Date('2026-09-01') } });
      const detail = await tx.mBOMDetail.create({ data: { noReg: tag, partId: ref.mbomDetail.partId, uomCode: 'pcs', qty: 1, category: 'inHouse' } });
      const route = await tx.mBOMProcess.create({ data: { noReg: tag, mbomDetailId: detail.id, processId: ref.processId, sequence: 10, cycleTime: 1, machineId: machine.id, machineSpecificationCode: tag, machinePlanningPolicy: { primaryMachineId: machine.id, mode: 'SINGLE', resources: [{ machineId: machine.id, cycleTimeSeconds: 1 }], execution: { allowedModes: ['INHOUSE', 'VENDOR'], allowSplit: true, vendorIds: [ref.vendorId] } } } });
      const plan = await tx.monthlyProductionPlan.create({ data: { planNumber: tag, planMonth: new Date('2026-09-01'), periodStart: new Date('2026-09-01'), periodEnd: new Date('2026-09-30'), status: 'Draft', sourceType: 'TEST', details: { create: { lineNumber: 1, partId: ref.mbomDetail.partId, partCode: 'QA', qtyPlanned: 1000, uomCode: 'pcs' } } } });
      const source = await tx.productionPlanAllocation.create({ data: { planId: plan.id, lineNumber: 1, mbomProcessId: route.id, machineId: machine.id, routingMode: 'INHOUSE', plannedQty: 1000, scheduleDate: new Date('2026-09-10'), shift: '1', uomCode: 'pcs' } });
      const dependencies = { capacityBuilder: async () => ({ summary: {}, readiness: { ok: true, issues: [] }, deliveryCoverage: [] }), materialBuilder: async () => ({ ready: true, items: [], issues: [] }) };
      const proposal = { allocationId: source.id, lineNumber: 1, mbomProcessId: route.id, reason: '600 internal / 400 vendor', allocations: [{ routingMode: 'INHOUSE', plannedQty: 600, machineId: machine.id, scheduleDate: '2026-09-10', shift: '1' }, { routingMode: 'VENDOR', plannedQty: 400, vendorId: ref.vendorId, vendorSendDate: '2026-09-10', vendorReturnDate: '2026-09-15' }] };
      const context = await service.options(client, tag, { allocationId: source.id });
      assert.deepEqual(context.policy.errors, []);
      const preview = await service.preview(client, tag, proposal, 'test', dependencies);
      assert.equal(preview.canApply, true, JSON.stringify(preview.blockers));
      let capacityCalls = 0;
      const overload = { ...dependencies, capacityBuilder: async () => ({ readiness: { issues: ++capacityCalls % 2 ? [] : [{ code: 'MACHINE_OVERLOAD', severity: 'blocking', message: 'Fixture machine overload' }] } }) };
      const blocked = await service.preview(client, tag, proposal, 'test', overload);
      assert.equal(blocked.canApply, false, 'New capacity overload must block the proposal');
      await assert.rejects(() => service.apply(client, tag, { ...proposal, previewToken: preview.previewToken }, 'test', overload), /Fixture machine overload/);
      assert.equal((await tx.productionPlanAllocation.findUnique({ where: { id: source.id } })).status, 'Draft');
      assert.equal(await tx.productionPlanAllocation.count({ where: { planId: plan.id } }), 1, 'Preview must roll back proposal allocations');
      const applied = await service.apply(client, tag, { ...proposal, previewToken: preview.previewToken }, 'test', dependencies);
      assert.equal(applied.status, 'APPLIED');
      assert.equal(applied.allocations.reduce((sum, row) => sum + row.plannedQty, 0), 1000);
      const vendor = applied.allocations.find(row => row.routingMode === 'VENDOR');
      const inside = applied.allocations.find(row => row.routingMode === 'INHOUSE');
      const prs = await tx.purchaseRequisitionDetail.findMany({ where: { isDeleted: false, sources: { some: { sourceType: 'CAPACITY_ALLOCATION', sourceNumber: vendor.id } } } });
      assert.equal(prs.length, 1);
      assert.equal(prs[0].qty, 400, 'Vendor PR must contain only external quantity');
      assert.equal((await service.apply(client, tag, { ...proposal, previewToken: preview.previewToken }, 'test', dependencies)).changeId, applied.changeId, 'Retry must not duplicate allocations');

      const dps = await tx.dailyProductionSchedule.create({ data: { scheduleNumber: tag, scheduleDate: new Date('2026-09-10'), shift: '1A', productionPlanId: plan.id, productionPlanAllocationId: inside.id, mbomProcessId: route.id, plannedQty: 600, status: 'Released' } });
      const change = { allocationId: inside.id, lineNumber: 1, mbomProcessId: route.id, reason: 'Route remaining batch to vendor', allocations: [{ routingMode: 'VENDOR', plannedQty: 600, vendorId: ref.vendorId, vendorSendDate: '2026-09-10', vendorReturnDate: '2026-09-16' }] };
      const releasedPreview = await service.preview(client, tag, change, 'test', dependencies);
      assert.equal(releasedPreview.requiresReplan, true);
      assert.equal(releasedPreview.canApply, true);
      await assert.rejects(() => service.apply(client, tag, { ...change, previewToken: releasedPreview.previewToken }, 'test', dependencies), /wajib melalui Replan/);
      const pending = await service.apply(client, tag, { ...change, previewToken: releasedPreview.previewToken, replan: true }, 'test', dependencies);
      assert.equal(pending.status, 'PENDING_REPLAN');
      assert.equal((await tx.productionPlanAllocation.findUnique({ where: { id: inside.id } })).status, 'Draft');
      assert.equal((await tx.dailyProductionSchedule.findUnique({ where: { id: dps.id } })).status, 'Released');
      assert.equal((await tx.monthlyProductionPlan.findUnique({ where: { id: plan.id } })).replanRequired, true);

      await service.cancel(client, tag, pending.changeId, 'test');
      assert.equal((await tx.monthlyProductionPlan.findUnique({ where: { id: plan.id } })).replanRequired, false);
      assert.equal((await tx.dailyProductionSchedule.findUnique({ where: { id: dps.id } })).status, 'Released', 'Cancelling a proposal must leave the released document intact');
      const renewedPreview = await service.preview(client, tag, change, 'test', dependencies);
      const renewed = await service.apply(client, tag, { ...change, previewToken: renewedPreview.previewToken, replan: true }, 'test', dependencies);
      assert.equal(renewed.status, 'PENDING_REPLAN');

      const otherScope = { allocationId: vendor.id, lineNumber: 1, mbomProcessId: route.id, reason: 'Incorrect Replan scope', allocations: [{ routingMode: 'VENDOR', plannedQty: 400, vendorId: ref.vendorId, vendorSendDate: '2026-09-11', vendorReturnDate: '2026-09-16' }] };
      const scopePreview = await service.preview(client, tag, otherScope, 'test', dependencies);
      await assert.rejects(() => service.apply(client, tag, { ...otherScope, previewToken: scopePreview.previewToken, replan: true, changeId: renewed.changeId }, 'test', dependencies), /terikat pada batch/);

      await tx.dailyProductionSchedule.update({ where: { id: dps.id }, data: { status: 'Cancelled' } });
      const resumePreview = await service.preview(client, tag, change, 'test', dependencies);
      const resumed = await service.apply(client, tag, { ...change, previewToken: resumePreview.previewToken, replan: true, changeId: renewed.changeId }, 'test', dependencies);
      assert.equal(resumed.status, 'APPLIED');
      assert.equal(resumed.changeId, renewed.changeId);
      assert.equal((await tx.monthlyProductionPlan.findUnique({ where: { id: plan.id } })).replanRequired, false);
      assert.equal((await tx.dailyProductionSchedule.findUnique({ where: { id: dps.id } })).status, 'Cancelled');

      const back = { allocationId: vendor.id, lineNumber: 1, mbomProcessId: route.id, reason: 'Vendor to in-house', allocations: [{ routingMode: 'INHOUSE', plannedQty: 400, machineId: machine.id, scheduleDate: '2026-09-12', shift: '2' }] };
      const p = await service.preview(client, tag, back, 'test', dependencies);
      await tx.monthlyProductionPlan.update({ where: { id: plan.id }, data: { notes: 'Concurrent edit' } });
      await assert.rejects(() => service.apply(client, tag, { ...back, previewToken: p.previewToken }, 'test', dependencies), /berubah/);
      const fresh = await service.preview(client, tag, back, 'test', dependencies);
      assert.equal(fresh.requiresReplan, true, 'Even an uncommitted draft vendor PR must use the Replan action');
      assert.equal(fresh.affectedDocuments.find(row => row.type === 'PR Vendor').blocking, false, 'System PPIC sourcing may refresh until Purchasing commits it');
      assert.equal((await service.apply(client, tag, { ...back, previewToken: fresh.previewToken, replan: true }, 'test', dependencies)).status, 'APPLIED');
      assert.equal(await tx.purchaseRequisitionDetail.count({ where: { isDeleted: false, sources: { some: { isDeleted: false, sourceNumber: vendor.id } } } }), 0, 'Old vendor PR source must disappear when switched internally');
      console.log('PASS real DB/savepoint integration: preview rollback, split 600/400, PR400, idempotence, released DPS protected, pending/resume Replan, optimistic conflict, vendor→inhouse PR synchronization');
      throw stop;
    }, { timeout: 60000 });
  } catch (error) { if (error !== stop) throw error; }
  finally { assert.equal(await db.monthlyProductionPlan.count({ where: { planNumber: tag } }), 0); await db.$disconnect(); }
  console.log('PASS rollback: no fixture BOM/plan/allocation/PR/numbering/audit changes committed');
}
unit();
if (process.argv.includes('--integration')) withBusinessDate('2026-08-20', integration).then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
