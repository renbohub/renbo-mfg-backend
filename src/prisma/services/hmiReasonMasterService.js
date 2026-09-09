"use strict";

// Table/column names come exclusively from this allowlist. All request values
// are bind parameters, including labels received through the legacy HMI topic.
const KINDS = Object.freeze({
  areas: { table: "hmi_list_area", id: "area_id", label: "area_name" },
  ng: { table: "hmi_list_rejection", id: "rejection_id", label: "rejection_desc", parent: "area_id", parentKind: "areas" },
  "ng-sub": { table: "hmi_list_rejection_sub", id: "rejection_sub_id", label: "rejection_sub_desc", parent: "rejection_id", parentKind: "ng" },
  downtime: { table: "hmi_list_downtime", id: "downtime_id", label: "downtime_desc", parent: "area_id", parentKind: "areas" },
  "downtime-sub": { table: "hmi_list_downtime_sub", id: "downtime_sub_id", label: "downtime_sub_desc", parent: "downtime_id", parentKind: "downtime" },
});
function fail(message, statusCode = 400, code = "HMI_MASTER_INVALID") { throw Object.assign(new Error(message), { statusCode, code }); }
function kindConfig(kind) { if (!Object.hasOwn(KINDS, kind)) fail("Jenis master tidak ditemukan.", 404); return KINDS[kind]; }
function integer(value, label, min = 1, max = 2147483647) {
  if (typeof value === "boolean" || value == null || String(value).trim() === "" || !/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) fail(`${label} tidak valid.`);
  return Number(value);
}
function bool(value, label) {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  fail(`${label} harus boolean.`);
}
function label(value, name, max = 255) {
  if (typeof value !== "string") fail(`${name} wajib diisi.`);
  const text = value.trim().replace(/\s+/g, " ");
  if (!text || text.length > max || /[\x00-\x1f\x7f]/.test(text)) fail(`${name} wajib diisi, maksimal ${max} karakter.`);
  return text;
}
function select(c, alias = "t") {
  return `${alias}.${c.id} AS id, ${alias}.${c.label} AS description,
    ${c.parent ? `${alias}.${c.parent}` : "NULL::integer"} AS "parentId",
    ${alias}.is_active AS "isActive", ${alias}.is_deleted AS "isDeleted", ${alias}.sort_order AS "sortOrder",
    ${alias}.notes, ${alias}.created_at AS "createdAt", ${alias}.updated_at AS "updatedAt"
    ${c.id === "area_id" ? `, ${alias}.area_code AS "areaCode", ${alias}.area_desc AS "areaDescription"` : ""}
    ${c.id === "downtime_id" ? `, ${alias}.stop_class AS "stopClass", ${alias}.counts_as_loss AS "countsAsLoss"` : ""}`;
}
const query = (db, sql, params = []) => db.$queryRawUnsafe(sql, ...params);
const atomic = (db, fn) => typeof db.$transaction === "function" ? db.$transaction(fn) : fn(db);
async function get(db, kind, id, { lock = false } = {}) {
  const c = kindConfig(kind); const recordId = integer(id, "ID");
  const [row] = await query(db, `SELECT ${select(c)} FROM ${c.table} t WHERE t.${c.id}=$1 ${lock ? "FOR UPDATE" : ""}`, [recordId]);
  if (!row) fail("Data master tidak ditemukan.", 404, "HMI_MASTER_NOT_FOUND");
  return row;
}
async function list(db, kind, options = {}) {
  const c = kindConfig(kind); const params = []; const where = [];
  const bind = v => { params.push(v); return `$${params.length}`; };
  if (options.isDeleted !== "all") where.push(`t.is_deleted=${bind(options.isDeleted === true || options.isDeleted === "true")}`);
  if (options.activeOnly === true || options.activeOnly === "true") where.push("t.is_active=true");
  if (c.parent && options.parentId != null && options.parentId !== "") where.push(`t.${c.parent}=${bind(integer(options.parentId, "Parent"))}`);
  if (options.q) {
    const value = `%${String(options.q).slice(0, 255).replace(/[\\%_]/g, "\\$&")}%`;
    const index = bind(value); where.push(`(t.${c.label} ILIKE ${index}${kind === "areas" ? ` OR t.area_code ILIKE ${index}` : ""})`);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const [{ total }] = await query(db, `SELECT count(*)::int AS total FROM ${c.table} t ${clause}`, params);
  const limit = integer(options.limit ?? 50, "Limit", 1, 500);
  const page = integer(options.page ?? 1, "Page", 1, 1000000);
  const pageParams = [...params, limit, (page - 1) * limit];
  const items = await query(db, `SELECT ${select(c)} FROM ${c.table} t ${clause} ORDER BY t.sort_order,t.${c.id} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, pageParams);
  return { items, total, page, limit };
}
function normalize(kind, body, current) {
  const c = kindConfig(kind); const merged = { ...(current || {}), ...body };
  const data = { [c.label]: label(merged.description, "Nama", kind === "areas" ? 50 : 255),
    is_active: bool(merged.isActive ?? true, "Status aktif"),
    sort_order: integer(merged.sortOrder ?? 0, "Urutan", 0, 999999),
    notes: merged.notes == null || merged.notes === "" ? null : label(merged.notes, "Catatan", 2000) };
  if (kind !== "areas" && data[c.label] === "-") fail("Nama '-' dipakai HMI untuk pilihan kosong. Gunakan nama reason lain.");
  if (c.parent) data[c.parent] = integer(merged.parentId, "Parent");
  if (kind === "areas") {
    const code = label(merged.areaCode, "Kode area", 50).toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9_.-]*$/.test(code)) fail("Kode area hanya boleh berisi huruf, angka, titik, strip, dan underscore.");
    data.area_code = code; data.area_desc = merged.areaDescription ? label(merged.areaDescription, "Deskripsi area", 50) : null;
  }
  if (kind === "downtime") {
    data.stop_class = merged.stopClass ?? "UNPLANNED";
    if (!["PLANNED", "UNPLANNED"].includes(data.stop_class)) fail("Tipe downtime tidak valid.");
    data.counts_as_loss = bool(merged.countsAsLoss ?? true, "Loss OEE");
  }
  return data;
}
async function assertParent(db, kind, data, current) {
  const c = kindConfig(kind); if (!c.parent) return;
  const parent = await get(db, c.parentKind, data[c.parent], { lock: true });
  if (parent.isDeleted || !parent.isActive) fail("Pilih parent yang aktif.", 409, "HMI_PARENT_INACTIVE");
  // Legacy IDs are embedded in logs and devices. Moving a reason between areas,
  // or a subreason between parents, would change their historical meaning.
  if (current && current.parentId !== data[c.parent]) fail("Parent tidak dapat dipindahkan. Nonaktifkan data lama dan buat reason baru.", 409, "HMI_PARENT_IMMUTABLE");
  if (c.parentKind !== "areas") {
    const area = await get(db, "areas", parent.parentId, { lock: true });
    if (area.isDeleted || !area.isActive) fail("Area parent tidak aktif.", 409, "HMI_PARENT_INACTIVE");
  }
}
async function audit(db, kind, id, action, before, after, actorId) {
  await query(db, "INSERT INTO tbl_hmi_reason_audit(entity_kind,record_id,action,actor_id,before_data,after_data) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb) RETURNING id", [kind, id, action, actorId || null, before ? JSON.stringify(before) : null, JSON.stringify(after)]);
}
function duplicate(error) {
  if (error.code === "23505" || error.meta?.code === "23505" || error.meta?.driverAdapterError?.cause?.originalCode === "23505") fail("Nama/kode sudah digunakan pada parent ini, termasuk data nonaktif/arsip. Aktifkan kembali record lama.", 409, "HMI_MASTER_DUPLICATE");
  throw error;
}
async function save(db, kind, id, body, actorId) {
  const c = kindConfig(kind);
  try { return await atomic(db, async tx => {
    const before = id == null ? null : await get(tx, kind, id, { lock: true });
    if (before?.isDeleted) fail("Pulihkan record arsip sebelum mengedit.", 409);
    if (before && body.expectedUpdatedAt && new Date(body.expectedUpdatedAt).getTime() !== new Date(before.updatedAt).getTime()) fail("Data telah berubah. Muat ulang sebelum menyimpan.", 409, "HMI_MASTER_CONFLICT");
    const data = normalize(kind, body, before); await assertParent(tx, kind, data, before);
    if (kind === "areas" && before && data.area_code !== before.areaCode) fail("Kode area tidak dapat diubah karena dipakai perangkat HMI.", 409);
    const keys = Object.keys(data); const values = Object.values(data);
    let recordId;
    if (before) {
      await query(tx, `UPDATE ${c.table} SET ${keys.map((k,i) => `${k}=$${i+1}`).join(",")},updated_at=clock_timestamp() WHERE ${c.id}=$${values.length+1} RETURNING ${c.id}`, [...values, before.id]);
      recordId = before.id;
    } else {
      const [inserted] = await query(tx, `INSERT INTO ${c.table}(${keys.join(",")}) VALUES (${keys.map((_,i)=>`$${i+1}`).join(",")}) RETURNING ${c.id} AS id`, values); recordId = inserted.id;
    }
    const after = await get(tx, kind, recordId); await audit(tx, kind, recordId, before ? "UPDATE" : "CREATE", before, after, actorId); return after;
  }); } catch (error) { return duplicate(error); }
}
async function archive(db, kind, id, restore, actorId) {
  const c = kindConfig(kind);
  return atomic(db, async tx => {
    const before = await get(tx, kind, id, { lock: true });
    if (restore) await assertParent(tx, kind, normalize(kind, before, before), before);
    await query(tx, `UPDATE ${c.table} SET is_deleted=$1,is_active=false,updated_at=clock_timestamp() WHERE ${c.id}=$2 RETURNING ${c.id}`, [!restore, before.id]);
    const after = await get(tx, kind, before.id); await audit(tx, kind, before.id, restore ? "RESTORE" : "ARCHIVE", before, after, actorId); return after;
  });
}
async function catalog(db, { areaId, areaCode } = {}) {
  const params = []; const areaFilter = areaId != null && areaId !== "" ? (params.push(integer(areaId,"Area")), "AND a.area_id=$1")
    : areaCode ? (params.push(label(areaCode,"Kode area",50).toUpperCase()), "AND a.area_code=$1") : "";
  async function tree(kind) {
    const c = KINDS[kind]; const sub = KINDS[kind + "-sub"];
    const parents = await query(db, `SELECT ${select(c)},t.area_id AS "areaId",a.area_code AS "areaCode" FROM ${c.table} t JOIN hmi_list_area a ON a.area_id=t.area_id WHERE t.is_active AND NOT t.is_deleted AND a.is_active AND NOT a.is_deleted ${areaFilter} ORDER BY t.sort_order,t.${c.id}`, params);
    if (!parents.length) return [];
    const children = await query(db, `SELECT ${select(sub)} FROM ${sub.table} t WHERE t.is_active AND NOT t.is_deleted AND t.${sub.parent}=ANY($1::integer[]) ORDER BY t.sort_order,t.${sub.id}`, [parents.map(p=>p.id)]);
    return parents.map(p=>({...p, children: children.filter(child=>child.parentId===p.id)}));
  }
  const [rejections, downtimes] = await Promise.all([tree("ng"),tree("downtime")]);
  return { source: "ERP_DATABASE", rejections, downtimes };
}
module.exports = { KINDS, kindConfig, list, get, save, archive, catalog, integer };
