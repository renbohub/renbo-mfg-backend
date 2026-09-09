const { resolveMbomRevision } = require('../planning/mbomRevisionService');
const { businessNow } = require('../../utils/businessClock');
const fail = message => { throw Object.assign(new Error(message), { statusCode: 400, code: 'BOM_VENDOR_PART_REQUIRED' }); };
function currentVendorPartIds(headers, at = businessNow()) {
  const groups = new Map();
  for (const header of headers || []) {
    if (header.isDeleted || header.part?.isDeleted || (header.part?.status && header.part.status !== 'Active')) continue;
    const key = header.partId || header.revisionOfMbomId || header.noReg;
    const group = groups.get(key) || []; group.push(header); groups.set(key, group);
  }
  const ids = new Set();
  for (const revisions of groups.values()) {
    const current = resolveMbomRevision({ revisions, selectionDate: at }).revision;
    for (const detail of current?.details || []) {
      // Vendor routing on a Purchase/inHouse detail does not change its category.
      if (!detail.isDeleted && detail.category === 'Vendor' && detail.partId) ids.add(detail.partId);
    }
  }
  return [...ids];
}
async function eligibleVendorPartIds(db, at = businessNow()) {
  const headers = await db.mBOMHeader.findMany({ where: { isDeleted: false }, select: { id:true, noReg:true, partId:true, revisionOfMbomId:true, revision:true, effectiveDate:true, expiryDate:true, createdAt:true, isDeleted:true, part:{select:{isDeleted:true,status:true}}, details:{where:{isDeleted:false},select:{partId:true,category:true,isDeleted:true}} } });
  return currentVendorPartIds(headers, at);
}
function assertPriceRelations(data) {
  for (const key of ['part','supplier','vendor','customer','currency']) if (Object.hasOwn(data || {},key)) fail('Gunakan ID master pada harga; perubahan relasi bersarang tidak diizinkan.');
  if (typeof data?.partId !== 'string' || !data.partId.trim()) fail('Part wajib dipilih dari kategori Vendor pada BOM aktif.');
}
async function assertEligiblePricePart(db, data, { purchaseOnly = false, at = businessNow() } = {}) {
  assertPriceRelations(data);
  const part = await db.part.findFirst({ where: { id:data.partId, isDeleted:false }, select:{id:true,itemType:true,rawType:true,status:true} });
  if (!part || (part.status && part.status !== 'Active')) fail('Part tidak ditemukan atau tidak aktif.');
  if (purchaseOnly && (part.itemType !== 'RAW' || part.rawType !== 'PURCHASE_PART')) fail('Part Price List hanya untuk Purchase Part (RAW / PURCHASE_PART).');
  if (!(await eligibleVendorPartIds(db,at)).includes(part.id)) fail('Harga hanya dapat diisi untuk part dengan kategori Vendor pada revisi BOM aktif yang berlaku saat ini.');
  return part;
}
function priceEligibility(part, eligibleIds, purchaseOnly=false) {
  const eligible=Boolean(part&&!part.isDeleted&&(!part.status||part.status==='Active')&&eligibleIds.includes(part.id)&&(!purchaseOnly||(part.itemType==='RAW'&&part.rawType==='PURCHASE_PART')));
  return {eligible,label:eligible?'Bisa diisi':'Histori saja',reason:eligible?'Part berkategori Vendor pada revisi BOM aktif yang berlaku.':'Harga ini dipertahankan sebagai histori. Part belum/tidak lagi berkategori Vendor pada revisi BOM aktif yang berlaku, atau master part tidak aktif. Periksa kategori detail BOM dan masa berlaku revisinya sebelum membuat atau mengubah harga.'};
}
module.exports = { currentVendorPartIds, eligibleVendorPartIds, assertPriceRelations, assertEligiblePricePart, priceEligibility };
