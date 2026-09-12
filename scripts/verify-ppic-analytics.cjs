"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const service = require("../src/prisma/services/planning/ppicAnalyticsService");
const superuser = { id: "qa", isSuperAdmin: true };
test("analytics authenticates and requires each source permission", () => {
  assert.throws(() => service.assertAnalyticsAccess(null, { page: "A02" }), { code: "UNAUTHENTICATED" });
  assert.throws(() => service.assertAnalyticsAccess({ id: "qa", permissions: ["mps:read", "mrp:read", "monthlyProductionPlan:read"] }, { page: "A02" }), error => ["WORKSPACE_FORBIDDEN", "ANALYTICS_FORBIDDEN"].includes(error.code));
  assert.equal(service.assertAnalyticsAccess(superuser, { page: "A02" }), "A02");
  assert.throws(() => service.assertAnalyticsAccess(superuser, { page: "A99" }), { code: "INVALID_ANALYTICS_PAGE" });
  assert.throws(() => service.assertAnalyticsAccess(superuser, { page: "A02", plant: "PLANT1" }), { code: "PLANT_SCOPE_UNAVAILABLE" });
});
test("analytics cutoff follows Jakarta business date and stops before unreconciled current day by default", () => {
  const p = service.periodFor({ month: "2026-08" }, new Date("2026-08-19T18:00:00Z"));
  assert.equal(p.cutoff, "2026-08-19"); assert.equal(p.startAt, "2026-07-31T17:00:00.000Z"); assert.equal(p.endAt, "2026-08-19T17:00:00.000Z"); assert.equal(p.completeness, "PROVISIONAL");
  assert.throws(() => service.periodFor({ month: "2026-08", cutoff: "2026-08-31" }, new Date("2026-08-19")), { code: "INVALID_ANALYTICS_CUTOFF" });
});
test("future month has no elapsed eligible period, invalid or unsupported filters rejected", () => {
  assert.equal(service.periodFor({ month: "2026-09" }, new Date("2026-08-31")).noElapsedPeriod, true);
  assert.throws(() => service.periodFor({ month: "2026-02", cutoff: "2026-02-30" }, new Date("2026-08-31")), { code: "INVALID_ANALYTICS_CUTOFF" });
  assert.throws(() => service.unsupportedFilters("A05", { customer: "C003" }), { code: "UNSUPPORTED_ANALYTICS_FILTER" });
});

function roleUser(extra) {
  return { id: 'scoped-reader', roleAssignments: [{ isActive: true, role: { isActive: true, isDeleted: false, permissions: [
    ...['mps', 'mrp', 'monthlyProductionPlan'].map(resourceCode => ({ resourceCode, moduleCode: 'planning-ppic', pageCode: '*', actions: ['read'], dataScope: {} })), ...extra,
  ] } }] };
}
test('explicit page role grants are checked per source and cannot escape data scope', () => {
  const delivery = { resourceCode: '*', moduleCode: 'outgoing', pageCode: 'delivery-schedules', actions: ['read'], dataScope: { type: 'ALL' } };
  assert.equal(service.assertAnalyticsAccess(roleUser([delivery]), {page:'A02'}), 'A02');
  assert.throws(()=>service.assertAnalyticsAccess(roleUser([]), {page:'A02'}), {code:'ANALYTICS_FORBIDDEN'});
  assert.throws(()=>service.assertAnalyticsAccess(roleUser([{...delivery,dataScope:{customerCode:'C1'}}]), {page:'A02'}), {code:'PLANT_SCOPE_UNAVAILABLE'});
  assert.throws(()=>service.assertAnalyticsAccess(roleUser([{...delivery,isActive:false}]), {page:'A02'}), {code:'ANALYTICS_FORBIDDEN'});
  assert.throws(()=>service.assertAnalyticsAccess(roleUser([{...delivery,pageCode:'invoices'}]), {page:'A02'}), {code:'ANALYTICS_FORBIDDEN'});
  assert.throws(()=>service.assertAnalyticsAccess(roleUser([delivery]), {page:'A01'}), {code:'ANALYTICS_FORBIDDEN'});
});
test('page-specific inventory and forecast reads do not require unrelated production grants', () => {
  assert.equal(service.assertAnalyticsAccess(roleUser([{resourceCode:'*',moduleCode:'inventory',pageCode:'stock-balances',actions:['read']}]),{page:'A05'}),'A05');
  assert.equal(service.assertAnalyticsAccess(roleUser([{resourceCode:'*',moduleCode:'sales',pageCode:'forecasts',actions:['read']}]),{page:'A08'}),'A08');
});
test('unsupported shift/date filters and structured query values are not silently ignored', () => {
  for(const query of [{shift:'1'},{date:'2026-08-10'},{customer:['C1','C2']},{q:{contains:'x'}}])assert.throws(()=>service.unsupportedFilters('A03',query),error=>['UNSUPPORTED_ANALYTICS_FILTER','INVALID_ANALYTICS_FILTER'].includes(error.code));
});
test('explicit current-day cutoff ends at business now and excludes unfinished due day from OTS',()=>{
  const p=service.periodFor({month:'2026-08',cutoff:'2026-08-20'},new Date('2026-08-20T01:00:00Z'));
  assert.equal(p.endAt,'2026-08-20T01:00:00.000Z');assert.equal(p.completedCutoff,'2026-08-19');
});
