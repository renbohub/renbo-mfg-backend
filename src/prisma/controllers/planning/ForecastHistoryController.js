const XLSX = require('xlsx');
const { prisma } = require('../../index');

const HEADERS = ['Customer Code', 'Part Code', 'Part Number', 'UOM', 'Forecast Month', 'Forecast Qty', 'Unit Price', 'Notes'];
function buildTemplate() {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([HEADERS]);
  sheet['!cols'] = [20,20,24,12,22,18,18,48].map(wch => ({ wch }));
  sheet.A1.c = [{ a: 'ERP', t: 'Isi kode Customer aktif dari master data. Satu baris untuk satu customer, part FG, dan bulan.' }];
  sheet.B1.c = [{ a: 'ERP', t: 'Isi Part Code FG aktif atau Part Number pada kolom C.' }];
  sheet.E1.c = [{ a: 'ERP', t: 'Format YYYY-MM-01, contoh 2026-09-01. Jangan gunakan nomor seri tanggal Excel.' }];
  sheet.F1.c = [{ a: 'ERP', t: 'Qty harus lebih dari 0. Baris customer-part-bulan yang sama akan dijumlahkan oleh importer.' }];
  sheet['!autofilter'] = { ref: 'A1:H1' };
  XLSX.utils.book_append_sheet(workbook, sheet, 'Forecast');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}
exports.template = (_req, res) => {
  res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': 'attachment; filename="Template-Forecast-ERP.xlsx"', 'Cache-Control': 'private, no-store' });
  res.send(buildTemplate());
};
function summarizeDetails(details) {
  const map = new Map();
  for (const detail of details || []) {
    // Historical targets retain original dates even after a version is superseded.
    const targets = detail.deliveryTargets?.length ? detail.deliveryTargets : [1,2,3].filter(i => detail[`M${i}Forecast`]).map(i => ({ targetDate: detail[`M${i}Forecast`], qty: detail[`M${i}Qty`] }));
    for (const target of targets) {
      const month = new Date(target.targetDate).toISOString().slice(0,7), key = `${detail.partCode}|${detail.uomCode || ''}|${month}`;
      const row = map.get(key) || { key, partCode: detail.partCode, uomCode: detail.uomCode, month, qty: 0, value: 0 };
      row.qty += Number(target.qty || 0); row.value += Number(target.qty || 0) * Number(detail.unitPrice || 0); map.set(key,row);
    }
  }
  return map;
}
function compareVersions(versions) {
  let previous = new Map();
  return versions.map(version => {
    const current = summarizeDetails(version.details);
    const rows = [...new Set([...previous.keys(),...current.keys()])].map(key => {
      const before = previous.get(key), after = current.get(key);
      return { ...(after || before), qty: after?.qty || 0, value: after?.value || 0, previousQty: before?.qty || 0, deltaQty: (after?.qty || 0) - (before?.qty || 0) };
    }).sort((a,b) => a.month.localeCompare(b.month) || a.partCode.localeCompare(b.partCode));
    previous = current;
    const { details: _details, ...header } = version;
    return { ...header, rows };
  });
}
exports.history = async (req,res,next) => {
  try {
    const doc = await prisma.forecast.findFirst({ where: { forecastNumber: req.params.forecastNumber, isDeleted: false } });
    if (!doc) return res.status(404).json({ message: 'Forecast tidak ditemukan.' });
    const group = doc.versionGroup || doc.revisionOfForecastNumber || doc.forecastNumber;
    const versions = await prisma.forecast.findMany({ where: { isDeleted: false, OR: [{ versionGroup: group }, { forecastNumber: group }, { forecastNumber: doc.forecastNumber }] }, include: { details: { where: { isDeleted: false }, orderBy: { lineNumber: 'asc' }, include: { deliveryTargets: { where: { isDeleted: false }, orderBy: { phaseNumber: 'asc' } } } } }, orderBy: [{ version: 'asc' }, { createdAt: 'asc' }] });
    res.json({ versionGroup: group, items: compareVersions(versions), comparison: 'Selisih terhadap revisi sebelumnya; satuan mengikuti UOM tiap part.' });
  } catch(error) { next(error); }
};
exports.buildTemplate = buildTemplate;
exports.compareVersions = compareVersions;
