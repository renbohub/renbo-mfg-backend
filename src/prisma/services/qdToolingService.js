"use strict";
const { buildSort } = require('../utils/buildSort');
const { assertReference } = require('../utils/referenceValidation');
const classes = ['SMALL', 'MEDIUM', 'LARGE'];
const statuses = ['Active', 'Maintenance', 'Retired', 'Scrapped', 'Reserved'];
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode, status: statusCode });
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const config = kind => {
  if (kind === 'types') return { model: 'qdType', code: 'typeCode', fields: ['typeCode','typeName','dimensionA','dimensionB','dimensionUnit','preferredClass','notes','isActive','isDeleted'], search: ['typeCode','typeName'] };
  if (kind === 'units') return { model: 'qdUnit', code: 'qdCode', fields: ['qdCode','qdName','qdNumber','qdTypeId','status','location','notes','isDeleted'], search: ['qdCode','qdName','qdNumber'] };
  throw fail('Master QD tidak ditemukan.', 404);
};
const include = kind => kind === 'types'
  ? { _count: { select: { units: { where: { isDeleted: false } } } } }
  : { qdType: true, dies: { where: { isActive: true }, orderBy: { dies: { diesCode: 'asc' } }, include: {
    dies: { include: { diesParts: { where: { isActive: true }, include: { part: { select: { partCode: true, partName: true } } } } } },
  } } };
const dimension = row => `${row.dimensionA} × ${row.dimensionB} ${row.dimensionUnit}`;
function present(kind, row) {
  if (kind === 'types') return { ...row, dimensions: dimension(row), displayName: `${row.typeName} · ${dimension(row)}`, unitCount: row._count?.units || 0 };
  const members = (row.dies || []).map(m => m.dies);
  return { ...row, usageMode: 'Bergantian — satu dies per waktu',
    qdTypeLabel: row.qdType ? `${row.qdType.typeName} · ${dimension(row.qdType)}` : '',
    diesIds: members.map(d => d.id), diesCount: members.length,
    diesSummary: members.map(d => `${d.diesCode} · ${d.diesName || ''}${d.isDeleted || d.status !== 'Active' ? ' (tidak aktif)' : ''}`).join('; '),
    partSummary: [...new Set(members.flatMap(d => (d.diesParts || []).map(dp => `${dp.part.partCode} · ${dp.part.partName}`)))].join('; '),
    sizeReview: members.filter(d => row.qdType?.preferredClass && d.sizeClass && d.sizeClass !== row.qdType.preferredClass)
      .map(d => `${d.diesCode}: ${d.sizeClass}, periksa kecocokan fisik`).join('; ') || 'Kecocokan fisik ditentukan pengguna',
  };
}
function normalize(kind, input, current = {}) {
  const cfg = config(kind), data = {};
  for (const key of cfg.fields) {
    if (!own(input, key)) continue;
    const value = input[key];
    if (['isActive', 'isDeleted'].includes(key)) {
      if (![true,false,'true','false'].includes(value)) throw fail(`${key} tidak valid.`);
      data[key] = value === true || value === 'true';
    } else if (['dimensionA','dimensionB'].includes(key)) {
      if (value === null || value === '' || !['string','number'].includes(typeof value) || !Number.isFinite(Number(value)) || Number(value) <= 0) throw fail('Dimensi QD harus lebih dari 0.');
      data[key] = Number(value);
    } else {
      if (value != null && typeof value !== 'string') throw fail(`${key} harus berupa teks.`);
      data[key] = value == null || value.trim() === '' ? null : value.trim();
    }
  }
  if (data[cfg.code]) data[cfg.code] = data[cfg.code].toUpperCase();
  const merged = { ...current, ...data };
  const required = kind === 'types' ? ['typeCode','typeName','dimensionA','dimensionB','dimensionUnit'] : ['qdCode','qdName','qdTypeId'];
  if (required.some(key => merged[key] == null || merged[key] === '')) throw fail('Kode, nama, dan spesifikasi QD wajib diisi.');
  if (!/^[A-Z0-9][A-Z0-9_-]{0,79}$/.test(merged[cfg.code])) throw fail('Kode QD hanya boleh berisi huruf, angka, tanda - atau _.');
  if (kind === 'types' && !['mm','cm','m'].includes(merged.dimensionUnit)) throw fail('Satuan dimensi harus mm, cm, atau m.');
  if (kind === 'types' && merged.preferredClass && !classes.includes(merged.preferredClass)) throw fail('Kelompok ukuran tidak valid.');
  if (kind === 'units' && merged.status && !statuses.includes(merged.status)) throw fail('Status QD tidak valid.');
  return data;
}
function createService(db) {
  const transaction = fn => db.$transaction ? db.$transaction(fn) : fn(db);
  async function list(kind, query = {}) {
    const cfg = config(kind);
    const page = Math.max(1, Math.trunc(Number(query.page) || 1)), limit = Math.min(500, Math.max(1, Math.trunc(Number(query.limit) || 20)));
    const where = { isDeleted: query.isDeleted === 'true' };
    if (query.q) where.OR = cfg.search.map(field => ({ [field]: { contains: String(query.q), mode: 'insensitive' } }));
    if (kind === 'units' && query.qdTypeId) where.qdTypeId = query.qdTypeId;
    if (kind === 'types' && query.isActive !== undefined) where.isActive = query.isActive === 'true';
    const orderBy = buildSort(query, { allowed: cfg.fields, default: kind === 'types' ? [{ dimensionA: 'asc' }, { dimensionB: 'asc' }] : { qdCode: 'asc' } });
    const [items, total] = await Promise.all([db[cfg.model].findMany({ where, include: include(kind), orderBy, skip: (page - 1) * limit, take: limit }), db[cfg.model].count({ where })]);
    return { items: items.map(row => present(kind, row)), total, page, limit };
  }
  async function get(kind, key) {
    const cfg = config(kind);
    const row = await db[cfg.model].findFirst({ where: { OR: [{ id: key }, { [cfg.code]: key }] }, include: include(kind) });
    if (!row) throw fail('QD tidak ditemukan.', 404);
    return present(kind, row);
  }
  async function save(kind, id, input) {
    const cfg = config(kind);
    return transaction(async tx => {
      const current = id ? await tx[cfg.model].findUnique({ where: { id } }) : null;
      if (id && !current) throw fail('QD tidak ditemukan.', 404);
      const data = normalize(kind, input, current || {});
      if (data.isDeleted === true) throw fail('Gunakan aksi nonaktifkan untuk mengarsipkan QD.');
      if (kind === 'types' && current && (data.isDeleted === true || data.isActive === false) && await tx.qdUnit.count({ where: { qdTypeId: id, isDeleted: false } })) throw fail('Tipe QD masih digunakan oleh unit QD.', 409);
      let diesIds;
      if (kind === 'units') {
        await assertReference({ delegate: tx.qdType, field: 'qdTypeId', value: data.qdTypeId ?? current?.qdTypeId, currentValue: current?.qdTypeId, activeWhere: { isActive: true }, label: 'Tipe QD' });
        if (own(input, 'diesIds')) {
          if (!Array.isArray(input.diesIds) || input.diesIds.some(x => typeof x !== 'string' || !x.trim())) throw fail('Daftar dies harus berupa pilihan dies yang valid.');
          diesIds = [...new Set(input.diesIds)];
          if (diesIds.length > 200) throw fail('Maksimum 200 dies per unit QD.');
          const valid = await tx.dies.count({ where: { id: { in: diesIds }, isDeleted: false, status: 'Active' } });
          if (valid !== diesIds.length) throw fail('Ada dies yang tidak ditemukan atau tidak aktif.');
        }
      }
      const row = id ? await tx[cfg.model].update({ where: { id }, data }) : await tx[cfg.model].create({ data });
      if (diesIds !== undefined) {
        await tx.qdUnitDies.updateMany({ where: { qdUnitId: row.id, isActive: true, diesId: { notIn: diesIds } }, data: { isActive: false } });
        for (const diesId of diesIds) await tx.qdUnitDies.upsert({ where: { qdUnitId_diesId: { qdUnitId: row.id, diesId } }, create: { qdUnitId: row.id, diesId }, update: { isActive: true } });
      }
      return present(kind, await tx[cfg.model].findUnique({ where: { id: row.id }, include: include(kind) }));
    });
  }
  async function remove(kind, ids) {
    const cfg = config(kind);
    if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string')) throw fail('Pilih data QD yang akan dinonaktifkan.');
    return transaction(async tx => {
      if (kind === 'types' && await tx.qdUnit.count({ where: { qdTypeId: { in: ids }, isDeleted: false } })) throw fail('Tipe QD masih digunakan oleh unit QD.', 409);
      const result = await tx[cfg.model].updateMany({ where: { id: { in: ids } }, data: { isDeleted: true } });
      return { ok: true, count: result.count };
    });
  }
  return { list, get, save, remove };
}
module.exports = { createService, normalize, present };
