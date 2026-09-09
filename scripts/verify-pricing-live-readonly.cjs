// Read-only HTTP integration checks against the local ERP; no prices or routing records are written.
process.env.NODE_ENV = 'test';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { prisma } = require('../src/prisma');
const jwt = require('jsonwebtoken');
const { eligibleVendorPartIds } = require('../src/prisma/services/pricing/bomVendorPartEligibility');
const { MONTH_FIELDS } = require('../src/prisma/services/pricing/effectivePriceService');
const checks = [];
const pass = (name, detail = {}) => { checks.push({ name, ...detail }); console.log(`PASS ${name}`); };
async function main() {
  const user = await prisma.user.findFirst({ where: { isDeleted: false, isSuperAdmin: true, partnerAccess: null }, select: { id: true } });
  assert(user, 'An existing internal administrator is required for these read-only checks.');
  // Short-lived token stays in this process; never emitted or stored in the report.
  const headers = { Authorization: `Bearer ${jwt.sign({ id: user.id }, process.env.JWT_SECRET || 'secret-key', { expiresIn: '60s' })}` };
  async function get(url, json = true) {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
    assert.equal(response.status, 200, `GET ${url}: ${response.status}`);
    return json ? response.json() : response.text();
  }
  const current = await get('http://localhost:5017/api/system/current-date');
  const at = current.demoDate ? new Date(`${current.demoDate}T00:00:00.000Z`) : new Date();
  const eligible = new Set(await eligibleVendorPartIds(prisma, at));
  for (const scope of ['BOM_VENDOR', 'BOM_VENDOR_PART']) {
    const payload = await get(`http://localhost:5017/api/master-data/parts?pricingScope=${scope}&limit=500`);
    const parts = payload.items || payload.data;
    assert(Array.isArray(parts));
    for (const row of parts) {
      assert(eligible.has(row.id), 'Unqualified part leaked through pricing lookup');
      if (scope === 'BOM_VENDOR_PART') assert(row.itemType === 'RAW' && row.rawType === 'PURCHASE_PART');
    }
    pass(`Backend part lookup ${scope}`, { count: parts.length });
    const lookup = await get(`http://localhost:3100/lookups/api/parts?pricingScope=${scope}&pageSize=100`);
    for (const row of lookup.results) assert(eligible.has(row.id));
    pass(`Frontend part lookup ${scope}`, { count: lookup.results.length });
  }
  for (const [slug, model] of [['part-price-lists','partPriceList'], ['material-price-lists','materialPriceList'], ['vendor-price-lists','vendorPriceList']]) {
    const html = await get(`http://localhost:3100/master-data/${slug}/new`, false);
    assert(html.includes('monthly-pricing-page'));
    assert(!html.includes('id="field-unitPrice"'));
    if (slug !== 'vendor-price-lists') for (const month of MONTH_FIELDS) assert(html.includes(`id="field-${month}"`));
    if (slug === 'material-price-lists') assert(!html.includes('id="field-materialId"'));
    pass(`New ${slug}: monthly form`);
    const row = await prisma[model].findFirst({ where: { isDeleted: false }, orderBy: { updatedAt: 'desc' }, select: { id: true } });
    if (!row) continue;
    const view = await get(`http://localhost:3100/master-data/api/${slug}/${row.id}?monthlyForm=true`);
    assert(view.monthlyPlan);
    const rows = slug === 'vendor-price-lists' ? view.monthlyPlan.details : [view.monthlyPlan];
    for (const detail of rows) {
      assert(detail.monthlyOverrides && detail.monthlyResolved);
      for (const month of MONTH_FIELDS) {
        assert.equal(typeof detail.monthlyOverrides[month], 'boolean');
        assert(Object.hasOwn(detail.monthlyResolved, month));
      }
    }
    pass(`Edit ${slug}: sparse monthly projection`, { itemCount: rows.length });
  }
  const html = await get('http://localhost:3100/master-data/parts/new', false);
  for (const category of ['PD', 'WD', 'MD']) assert(html.includes(`value="${category}"`));
  pass('Purchase part category PD/WD/MD rendered');
  const purchasePart = await prisma.part.findFirst({ where: { isDeleted: false, itemType: 'RAW', rawType: 'PURCHASE_PART', OR: [{ status: 'Active' }, { status: null }] }, select: { id: true } });
  if (purchasePart) {
    const routePage = await get(`http://localhost:3100/master-data/parts/${purchasePart.id}/routing`, false);
    assert(routePage.includes('id="routing-form"'));
    const routes = await get(`http://localhost:3100/routing-tools/api/parts/${purchasePart.id}/routings`);
    assert.equal(routes.part.id, purchasePart.id);
    assert(Array.isArray(routes.items));
    const options = await get(`http://localhost:3100/routing-tools/api/parts/${purchasePart.id}/routing-options`);
    assert(Array.isArray(options.processes) && options.processes.length > 0);
    pass('Purchase part routing page, API and process master options', { existingRoutings: routes.items.length, processOptions: options.processes.length });
  }
  const routingPage = await get('http://localhost:3100/modules/engineering/routings/new', false);
  assert(routingPage.includes('id="routing-form"'));
  const routingOptions = await get('http://localhost:3100/routing-tools/api/routing-options');
  assert(Array.isArray(routingOptions.parts));
  pass('Engineering new routing page and options');
  const report = path.resolve(__dirname, '../../output/pricing-update/live-readonly.json');
  fs.mkdirSync(path.dirname(report), { recursive: true });
  fs.writeFileSync(report, JSON.stringify({ checkedAt: new Date().toISOString(), businessDate: current.demoDate || null, writes: 0, checks }, null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
