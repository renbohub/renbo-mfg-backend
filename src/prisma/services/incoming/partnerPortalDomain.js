const path = require('node:path');
const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };
const text = (value, max = 500) => String(value ?? '').trim().slice(0, max);
function partyScope(access) {
  if (!access || !access.isActive || Boolean(access.supplierCode) === Boolean(access.vendorCode)) fail('Akses partner tidak aktif atau belum dikonfigurasi.', 403);
  return access.supplierCode ? { supplierCode: access.supplierCode } : { vendorCode: access.vendorCode };
}
function dateRange(query = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const from = text(query.from || `${today.slice(0, 7)}-01`, 10);
  const to = text(query.to || today, 10);
  for (const value of [from, to]) if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) fail('Tanggal periode tidak valid.');
  const gte = new Date(`${from}T00:00:00+07:00`), end = new Date(`${to}T00:00:00+07:00`);
  if (end < gte || end - gte > 366 * 86400000) fail('Periode harus berurutan dan maksimal 366 hari.');
  return { from, to, where: { gte, lt: new Date(end.getTime() + 86400000) } };
}
function validateNotice(body, po, reserved = new Map()) {
  if (!['Sent', 'Confirmed', 'Partial Receipt'].includes(po?.status)) fail('PO tidak tersedia untuk pendaftaran pengiriman.', 409);
  const deliveryNoteNumber = text(body.deliveryNoteNumber, 100);
  if (!deliveryNoteNumber) fail('Nomor surat jalan wajib diisi.');
  const expected = String(body.expectedDate || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expected) || !Number.isFinite(Date.parse(expected)) || new Date(expected).toISOString().slice(0, 10) !== expected) fail('Tanggal kedatangan tidak valid.');
  if (!Array.isArray(body.details) || !body.details.length || body.details.length > 200) fail('Isi 1–200 baris barang.');
  const totals = new Map();
  const details = body.details.map(input => {
    const line = po.details.find(row => row.id === input.poDetailId && !row.isDeleted);
    const qty = Number(input.qty);
    if (!line || !Number.isFinite(qty) || qty <= 0) fail('Item PO atau jumlah tidak valid.');
    const { assertQuantity } = require('../../utils/uomQuantity');
    assertQuantity(qty, line.uomCode, 'Jumlah pengiriman');
    totals.set(line.id, (totals.get(line.id) || 0) + qty);
    if (totals.get(line.id) + (reserved.get(line.id) || 0) > Number(line.qty) - Number(line.qtyReceived || 0) + 0.000001) fail('Jumlah pengiriman melebihi sisa PO setelah notifikasi yang belum diterima.', 409);
    const supplierLotNumber = text(input.supplierLotNumber, 100);
    if (!supplierLotNumber) fail('Lot/batch supplier wajib diisi.');
    return { poDetailId: line.id, qty, supplierLotNumber, uomCode: line.uomCode, itemCode: line.materialCode || line.partCode || '', itemName: line.materialName || line.partName || line.description || '' };
  });
  return { deliveryNoteNumber, expectedDate: new Date(`${expected}T00:00:00+07:00`), details, notes: text(body.notes, 2000) || null };
}
const CHECKLIST = [
  { code: 'IDENTITY', label: 'Kode barang, PO dan lot sesuai' },
  { code: 'QUANTITY', label: 'Jumlah fisik telah dihitung dan sesuai hasil inspeksi' },
  { code: 'DOCUMENT', label: 'Surat jalan / dokumen pendukung sesuai' },
  { code: 'PACKAGING', label: 'Kemasan dan kondisi fisik diperiksa' },
  { code: 'QUALITY', label: 'Dimensi / spesifikasi / visual sesuai persyaratan barang' },
];
function normalizeChecklist(input, { final = false, actor = '', now = new Date() } = {}) {
  if (!Array.isArray(input) || input.length > 50) fail('Checklist inspeksi wajib diisi.');
  const seen = new Set();
  const rows = input.map(row => {
    const code = text(row.code, 50);
    const standard = CHECKLIST.find(item => item.code === code);
    if (!/^[A-Z][A-Z0-9_]{0,49}$/.test(code) || seen.has(code)) fail('Kode checklist tidak valid atau duplikat.');
    seen.add(code);
    const label = standard?.label || text(row.label, 200);
    const result = text(row.result, 10).toUpperCase();
    const notes = text(row.notes, 1000);
    if (!label || !['PENDING', 'PASS', 'FAIL', 'NA'].includes(result)) fail('Kriteria atau hasil checklist tidak valid.');
    if (final && result === 'PENDING') fail('Lengkapi semua hasil checklist sebelum menyelesaikan inspeksi.');
    if (['FAIL', 'NA'].includes(result) && !notes) fail('Temuan gagal atau tidak berlaku memerlukan alasan.');
    return { code, label, result, notes, expected: text(row.expected, 200), actual: text(row.actual, 200) };
  });
  if (CHECKLIST.some(row => !seen.has(row.code))) fail('Seluruh kriteria checklist standar wajib tersedia.');
  return { version: 1, rows, checkedBy: actor, checkedAt: now.toISOString() };
}
function validateFile(file) {
  if (!file?.buffer?.length || file.size > 10 * 1024 * 1024) fail('File wajib diisi, maksimal 10 MB.');
  const ext = path.extname(file.originalname || '').toLowerCase();
  const mime = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }[ext];
  const b = file.buffer;
  const magic = ext === '.pdf' ? b.subarray(0, 5).toString() === '%PDF-' : ext === '.png' ? b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : ['.jpg','.jpeg'].includes(ext) ? b[0] === 255 && b[1] === 216 && b[2] === 255 : ['.docx','.xlsx'].includes(ext) ? b[0] === 80 && b[1] === 75 && b[2] === 3 && b[3] === 4 && b.includes(Buffer.from('[Content_Types].xml')) && b.includes(Buffer.from(ext === '.docx' ? 'word/' : 'xl/')) : false;
  if (!mime || !magic || file.mimetype !== mime) fail('Format file tidak cocok. Gunakan PDF, DOCX, XLSX, PNG atau JPG asli.');
  return { fileName: path.basename(file.originalname.replace(/\\/g, '/')).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 180) || `dokumen${ext}`, fileType: mime, fileSize: b.length };
}
function summarizeUnits(receipts = [], vendorOrders = []) {
  const grouped = new Map();
  const add = (uom, received, accepted, rejected) => { const key = uom || '(tanpa UOM)'; const row = grouped.get(key) || { uomCode: key, received: 0, accepted: 0, rejected: 0 }; row.received += Number(received || 0); row.accepted += Number(accepted || 0); row.rejected += Number(rejected || 0); grouped.set(key, row); };
  for (const receipt of receipts) for (const line of receipt.details || []) {
    const inspections = (line.incomingInspectionDetails || []).filter(item => item.inspection?.status === 'Completed');
    add(line.uomCode, line.qtyReceived, inspections.reduce((sum, item) => sum + Number(item.qtyAccepted || 0), 0), inspections.reduce((sum, item) => sum + Number(item.qtyRejected || 0), 0));
  }
  for (const order of vendorOrders) add(order.uomCode, order.qtyReceived, order.qtyAccepted, order.qtyReject);
  return [...grouped.values()];
}
module.exports = { fail, text, partyScope, dateRange, validateNotice, CHECKLIST, normalizeChecklist, validateFile, summarizeUnits };
