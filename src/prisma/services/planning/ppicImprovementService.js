"use strict";
const { randomUUID } = require("node:crypto"), { Prisma } = require("@prisma/client");
const d = require("./ppicWorkspaceDomain"), { businessNow } = require("../../utils/businessClock");
const STATES = ["OPEN", "IN_PROGRESS", "PENDING_VERIFICATION", "VERIFIED", "CLOSED"];
const stamp = Prisma.sql`to_char(a.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at_utc,to_char(a.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at_utc`;
const actor = user => ({ id: user.id, name: user.username || user.email || user.id });
const businessDate = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(businessNow());
const idValue = value => { if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(String(value || ""))) throw d.fail("Identitas tindakan tidak valid."); return value; };
const requiredText = (value, label, limit = 1000) => { const result = d.text(value); if (!result || result.length > limit) throw d.fail(`${label} wajib diisi, maksimal ${limit} karakter.`); return result; };
function date(value) { if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || d.iso(value)?.slice(0, 10) !== value || value < "1900-01-01" || value > "2199-12-31") throw d.fail("Tanggal pengukuran / tenggat harus YYYY-MM-DD yang valid."); return value; }
function measurement(value, optional = false) {
  if (optional && value == null) return null;
  if (!d.plain(value) || typeof value.value !== "number" || !Number.isFinite(value.value) || Math.abs(value.value) > 1e15 || !Number.isInteger(value.sampleSize) || value.sampleSize < 1 || value.sampleSize > 1e9) throw d.fail("Pengukuran memerlukan nilai numerik dan jumlah sampel positif.", "MEASUREMENT_REQUIRED");
  const windowStart = date(value.windowStart), windowEnd = date(value.windowEnd);
  if (windowStart > windowEnd) throw d.fail("Awal periode pengukuran harus sebelum atau sama dengan akhir periode.");
  if (!Array.isArray(value.evidence) || !value.evidence.length || value.evidence.length > 20) throw d.fail("Bukti pengukuran wajib diisi, maksimal 20 referensi.", "MEASUREMENT_EVIDENCE_REQUIRED");
  // References are stored for human review, never fetched or executed by the server.
  if (value.evidence.some(item => typeof item !== "string")) throw d.fail("Referensi bukti harus berupa teks sumber.", "MEASUREMENT_EVIDENCE_REQUIRED");
  const evidence = [...new Set(value.evidence.map(item => requiredText(item, "Referensi bukti", 1000)))];
  return { value: value.value, sampleSize: value.sampleSize, windowStart, windowEnd, evidence, provenance: "USER_RECORDED" };
}
function normalize(input) {
  if (!d.plain(input) || !d.plain(input.metric)) throw d.fail("Isi tindakan dan definisi metric wajib tersedia.");
  const metric = { name: requiredText(input.metric.name, "Metric", 160), unit: requiredText(input.metric.unit, "Satuan metric", 40), direction: input.metric.direction, target: input.metric.target, aggregation: input.metric.aggregation };
  if (!["LOWER", "HIGHER"].includes(metric.direction) || !["MEAN", "MEDIAN", "RATE", "SUM", "COUNT"].includes(metric.aggregation) || typeof metric.target !== "number" || !Number.isFinite(metric.target) || Math.abs(metric.target) > 1e15) throw d.fail("Arah, agregasi dan target metric tidak valid.");
  const baseline = measurement(input.baseline), observation = measurement(input.observation, true);
  const dueDate = date(input.dueDate);
  return { version: 1, title: requiredText(input.title, "Judul", 180), issue: requiredText(input.issue, "Issue", 2000), cause: requiredText(input.cause, "Penyebab / hipotesis", 2000), proposedAction: requiredText(input.proposedAction, "Usulan tindakan", 3000), ownerId: requiredText(input.ownerId, "Pemilik", 100), dueDate, metric, baseline, observation, provenance: "USER_RECORDED" };
}
function comparable(payload, cutoff = businessDate()) {
  const { metric, baseline, observation } = payload;
  if (!observation) throw d.fail("Isi hasil observasi sebelum mengajukan verifikasi.", "OBSERVATION_REQUIRED", 409);
  if (baseline.windowEnd >= observation.windowStart) throw d.fail("Periode baseline dan observasi harus berurutan dan tidak tumpang tindih.", "MEASUREMENT_WINDOW_OVERLAP", 409);
  if (baseline.windowEnd >= cutoff || observation.windowEnd >= cutoff) throw d.fail("Periode before/after harus selesai sebelum tanggal bisnis aktif.", "MEASUREMENT_WINDOW_INCOMPLETE", 409);
  if (["SUM", "COUNT"].includes(metric.aggregation) && new Date(baseline.windowEnd) - new Date(baseline.windowStart) !== new Date(observation.windowEnd) - new Date(observation.windowStart)) throw d.fail("Metric SUM/COUNT memerlukan durasi periode before/after yang sama.", "MEASUREMENT_NOT_COMPARABLE", 409);
  if (["%", "PERCENT", "PERCENTAGE"].includes(metric.unit.toUpperCase()) && [metric.target, baseline.value, observation.value].some(value => value < 0 || value > 100)) throw d.fail("Metric persen harus bernilai 0 sampai 100.", "MEASUREMENT_NOT_COMPARABLE", 409);
  return true;
}
function outcome(payload) {
  if (!payload.observation) return null;
  const { baseline, observation, metric } = payload, delta = observation.value - baseline.value, beneficialDelta = metric.direction === "LOWER" ? -delta : delta;
  return { before: baseline.value, after: observation.value, delta, unit: metric.unit, aggregation: metric.aggregation, improvementPercent: baseline.value === 0 ? null : beneficialDelta / Math.abs(baseline.value) * 100, targetMet: metric.direction === "LOWER" ? observation.value <= metric.target : observation.value >= metric.target, measuredDirectionImproved: beneficialDelta > 0, provenance: "USER_RECORDED", causalAttribution: "REQUIRES_REVIEWER_QUALIFICATION" };
}
function capabilities(user) { return { read: true, create: d.scopedPermission(user, "monthlyProductionPlan", "create"), update: d.scopedPermission(user, "monthlyProductionPlan", "update"), verify: d.scopedPermission(user, "monthlyProductionPlan", "approve") }; }
function access(user, query, action) { d.assertAccess(user, query); if (action && !d.scopedPermission(user, "monthlyProductionPlan", action)) throw d.fail(`Hak ${action} rencana bulanan diperlukan untuk tindakan perbaikan.`, "IMPROVEMENT_FORBIDDEN", 403); }
function requestMeta(input) { const operationId = requiredText(input.operationId, "Identitas operasi", 100); if (!/^[a-zA-Z0-9_-]{16,100}$/.test(operationId)) throw d.fail("Identitas operasi tidak valid.", "OPERATION_ID_REQUIRED"); return { operationId, note: d.text(input.note).slice(0, 3000) }; }
function revision(input) { if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) throw d.fail("Revisi tindakan wajib diisi.", "REVISION_REQUIRED"); return input.expectedRevision; }
const canonical = value => Array.isArray(value) ? value.map(canonical) : d.plain(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const contractHash = payload => d.hash(canonical({ metric: payload.metric, baseline: payload.baseline }));
function nextTransition(row, action, user, note, cutoff = businessDate()) {
  const allowed = { START: ["OPEN"], SUBMIT: ["OPEN", "IN_PROGRESS"], RETURN: ["PENDING_VERIFICATION"], VERIFY: ["PENDING_VERIFICATION"], CLOSE: ["VERIFIED"] };
  if (!(allowed[action] || []).includes(row.status)) throw d.fail("Tindakan tidak berlaku pada status / revisi ini.", "IMPROVEMENT_STATE_CONFLICT", 409);
  if (["SUBMIT", "VERIFY", "CLOSE"].includes(action)) comparable(row.payload, cutoff);
  if (["RETURN", "VERIFY"].includes(action) && !d.text(note)) throw d.fail("Catatan reviewer wajib menjelaskan hasil review.", "REVIEW_NOTE_REQUIRED");
  if (action === "VERIFY" && [row.owner_id, row.submitted_actor_id, row.created_actor_id, row.payload.measurementActorId].includes(user.id)) throw d.fail("Pemilik, pembuat, pencatat pengukuran atau pengaju tidak dapat memverifikasi hasil tindakannya sendiri.", "INDEPENDENT_REVIEW_REQUIRED", 403);
  if (action === "CLOSE" && (!row.verified_actor_id || !row.verification_note)) throw d.fail("Verifikasi reviewer belum lengkap.", "INDEPENDENT_REVIEW_REQUIRED", 409);
  if (["VERIFY", "CLOSE"].includes(action) && row.measurement_contract_hash !== contractHash(row.payload)) throw d.fail("Baseline atau definisi metric berubah setelah pengajuan.", "MEASUREMENT_CONTRACT_CHANGED", 409);
  return ({ START: "IN_PROGRESS", SUBMIT: "PENDING_VERIFICATION", RETURN: "IN_PROGRESS", VERIFY: "VERIFIED", CLOSE: "CLOSED" })[action];
}
function publicRow(row) { const result = { id: row.id, title: row.title, month: row.month, ownerId: row.owner_id, ownerName: row.owner_name || row.owner_id, dueDate: row.due_date, revision: row.revision, status: row.status, payload: row.payload, createdBy: row.created_by, updatedBy: row.updated_by, submittedActorId: row.submitted_actor_id, verifiedActorId: row.verified_actor_id, verifiedBy: row.verified_by, verificationNote: row.verification_note, baselineLocked: Boolean(row.measurement_contract_hash), createdAt: d.iso(row.created_at_utc), updatedAt: d.iso(row.updated_at_utc), outcome: outcome(row.payload) }; result.overdue = row.status !== "CLOSED" && row.due_date < businessDate(); return result; }
async function list(prisma, query, user) {
  access(user, query); const month = d.monthKey(query.month), owner = d.text(query.owner), status = d.text(query.status), q = d.text(query.q).toLowerCase();
  if (status && status !== "ALL" && !STATES.includes(status)) throw d.fail("Status tindakan tidak valid.");
  if ([owner, q].some(value => value.length > 120)) throw d.fail("Filter tindakan terlalu panjang.");
  const [rows, owners] = await Promise.all([prisma.$queryRaw`SELECT a.*,COALESCE(u.full_name,u.username,a.owner_id) AS owner_name,${stamp} FROM tbl_ppic_improvement_action a LEFT JOIN tbl_users u ON u.id=a.owner_id WHERE a.month=${month} ORDER BY a.due_date,a.id`, prisma.user.findMany({ where: { isDeleted: false }, select: { id: true, username: true, fullName: true }, orderBy: { username: "asc" } })]);
  const items = rows.map(publicRow).filter(row => (!owner || owner === "ALL" || row.ownerId === owner) && (!status || status === "ALL" || row.status === status) && (!q || [row.title, row.ownerName, row.payload.issue, row.payload.cause].join(" ").toLowerCase().includes(q)));
  return { schemaVersion: 1, month, generatedAt: new Date().toISOString(), timezone: "Asia/Jakarta", businessDate: businessDate(), items, owners: owners.map(row => ({ value: row.id, label: row.fullName || row.username })), capabilities: capabilities(user), summary: { total: items.length, open: items.filter(row => ["OPEN", "IN_PROGRESS"].includes(row.status)).length, overdue: items.filter(row => row.overdue).length, pendingVerification: items.filter(row => row.status === "PENDING_VERIFICATION").length, verified: items.filter(row => ["VERIFIED", "CLOSED"].includes(row.status)).length, reviewedMeasuredImprovement: items.filter(row => ["VERIFIED", "CLOSED"].includes(row.status) && row.outcome?.measuredDirectionImproved).length }, basis: "Pengukuran before/after dicatat pengguna (USER_RECORDED), ditautkan ke referensi bukti dan dinilai reviewer; selisih angka tidak membuktikan hubungan sebab-akibat." };
}
async function get(prisma, id, query, user) {
  access(user, query); idValue(id);
  const rows = await prisma.$queryRaw`SELECT a.*,COALESCE(u.full_name,u.username,a.owner_id) AS owner_name,${stamp} FROM tbl_ppic_improvement_action a LEFT JOIN tbl_users u ON u.id=a.owner_id WHERE a.id=${id}`;
  if (!rows[0]) throw d.fail("Tindakan tidak ditemukan.", "IMPROVEMENT_NOT_FOUND", 404);
  const history = await prisma.$queryRaw`SELECT revision,action,actor,note,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at_utc FROM tbl_ppic_improvement_operation WHERE action_id=${id} ORDER BY revision DESC`;
  return { ...publicRow(rows[0]), history: history.map(row => ({ revision: row.revision, action: row.action, actor: row.actor, note: row.note, createdAt: row.created_at_utc })), capabilities: capabilities(user) };
}
async function replay(tx, operationId, requestHash) { const rows = await tx.$queryRaw`SELECT request_hash,result FROM tbl_ppic_improvement_operation WHERE operation_id=${operationId}`; if (!rows[0]) return null; if (rows[0].request_hash !== requestHash) throw d.fail("Identitas operasi telah dipakai untuk permintaan berbeda.", "OPERATION_ID_CONFLICT", 409); return { ...rows[0].result, replayed: true }; }
async function mutation(prisma, input, user, id, mode) {
  const permission = mode === "CREATE" ? "create" : ["VERIFY", "RETURN"].includes(mode) ? "approve" : "update";
  access(user, input, permission); if (id) idValue(id);
  const meta = requestMeta(input), person = actor(user), expectedRevision = mode !== "CREATE" ? revision(input) : null;
  const payload = ["CREATE", "UPDATE"].includes(mode) ? normalize(input) : null;
  const requestHash = d.hash({ actorId: person.id, id, mode, expectedRevision, payload, ...meta });
  const previous = await replay(prisma, meta.operationId, requestHash); if (previous) return previous;
  try { return await prisma.$transaction(async tx => {
    const prior = await replay(tx, meta.operationId, requestHash); if (prior) return prior;
    const rows = id ? await tx.$queryRaw`SELECT * FROM tbl_ppic_improvement_action WHERE id=${id} FOR UPDATE` : [];
    const row = rows[0];
    if (id && !row) throw d.fail("Tindakan tidak ditemukan.", "IMPROVEMENT_NOT_FOUND", 404);
    if (id && row.revision !== expectedRevision) throw d.fail("Tindakan telah berubah di sesi lain. Muat ulang sebelum menyimpan.", "IMPROVEMENT_REVISION_CONFLICT", 409);
    if (payload) {
      const owner = await tx.user.findFirst({ where: { id: payload.ownerId, isDeleted: false }, select: { id: true } });
      if (!owner) throw d.fail("Pemilik aktif tidak ditemukan.", "INVALID_ACTION_OWNER");
      if (row && !["OPEN", "IN_PROGRESS"].includes(row.status)) throw d.fail("Kembalikan ke proses review sebelum mengubah tindakan yang diajukan.", "IMPROVEMENT_STATE_CONFLICT", 409);
      if (row?.measurement_contract_hash && row.measurement_contract_hash !== contractHash(payload)) throw d.fail("Baseline dan definisi metric awal dikunci setelah pengajuan; hasil observasi dapat diperbarui setelah tindakan dikembalikan.", "MEASUREMENT_CONTRACT_CHANGED", 409);
      const measurementHash = value => d.hash(canonical({ metric: value.metric, baseline: value.baseline, observation: value.observation }));
      payload.measurementActorId = row && measurementHash(row.payload) === measurementHash(payload) ? row.payload.measurementActorId || row.created_actor_id : person.id;
    }
    let saved;
    if (mode === "CREATE") { const newId = randomUUID(), json = JSON.stringify(payload); saved = await tx.$queryRaw`INSERT INTO tbl_ppic_improvement_action AS a(id,title,month,owner_id,due_date,payload,created_actor_id,created_by,updated_by) VALUES(${newId},${payload.title},${payload.dueDate.slice(0, 7)},${payload.ownerId},${payload.dueDate},${json}::jsonb,${person.id},${person.name},${person.name}) RETURNING a.*,${stamp}`; }
    else if (mode === "UPDATE") { const json = JSON.stringify(payload); saved = await tx.$queryRaw`UPDATE tbl_ppic_improvement_action AS a SET title=${payload.title},month=${payload.dueDate.slice(0, 7)},owner_id=${payload.ownerId},due_date=${payload.dueDate},payload=${json}::jsonb,revision=revision+1,updated_by=${person.name},updated_at=CURRENT_TIMESTAMP WHERE id=${id} RETURNING a.*,${stamp}`; }
    else {
      const status = nextTransition(row, mode, user, meta.note), contract = mode === "SUBMIT" ? contractHash(row.payload) : row.measurement_contract_hash;
      saved = await tx.$queryRaw`UPDATE tbl_ppic_improvement_action AS a SET status=${status},revision=revision+1,measurement_contract_hash=${contract},submitted_actor_id=CASE WHEN ${mode}='SUBMIT' THEN ${person.id} ELSE submitted_actor_id END,verified_actor_id=CASE WHEN ${mode}='VERIFY' THEN ${person.id} WHEN ${mode}='RETURN' THEN NULL ELSE verified_actor_id END,verified_by=CASE WHEN ${mode}='VERIFY' THEN ${person.name} WHEN ${mode}='RETURN' THEN NULL ELSE verified_by END,verification_note=CASE WHEN ${mode}='VERIFY' THEN ${meta.note} WHEN ${mode}='RETURN' THEN NULL ELSE verification_note END,updated_by=${person.name},updated_at=CURRENT_TIMESTAMP WHERE id=${id} RETURNING a.*,${stamp}`;
    }
    const result = { ...publicRow(saved[0]), replayed: false }, json = JSON.stringify(result);
    await tx.$executeRaw`INSERT INTO tbl_ppic_improvement_operation(operation_id,action_id,revision,request_hash,action,actor_id,actor,note,result) VALUES(${meta.operationId},${result.id},${result.revision},${requestHash},${mode},${person.id},${person.name},${meta.note},${json}::jsonb)`;
    return result;
  }, { isolationLevel: "Serializable", timeout: 45000 }); } catch (error) {
    if (["P2034", "40001", "P2002"].includes(error.code) || ["40001", "23505"].includes(error.meta?.code)) { const prior = await replay(prisma, meta.operationId, requestHash); if (prior) return prior; throw d.fail("Data berubah saat disimpan. Muat ulang tindakan.", "IMPROVEMENT_REVISION_CONFLICT", 409); }
    throw error;
  }
}
const save = (prisma, input, user, id = null) => mutation(prisma, input, user, id, id ? "UPDATE" : "CREATE");
const transition = (prisma, id, input, user) => { if (!["START", "SUBMIT", "RETURN", "VERIFY", "CLOSE"].includes(input.action)) throw d.fail("Aksi review tidak valid."); return mutation(prisma, input, user, id, input.action); };
module.exports = { list, get, save, transition, normalize, comparable, outcome, nextTransition, contractHash, publicRow, STATES };
