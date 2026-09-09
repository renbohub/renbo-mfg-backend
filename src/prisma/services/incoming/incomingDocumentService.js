const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fail, validateFile } = require('./partnerPortalDomain');
const STORAGE_ROOT = path.resolve(__dirname, '../../../../private-uploads/incoming');
const publicDocument = doc => ({ id: doc.id, fileName: doc.fileName, fileType: doc.fileType, fileSize: doc.fileSize, createdAt: doc.createdAt });
function documentPath(key, root = STORAGE_ROOT) {
  if (!/^[0-9a-f-]{36}\.bin$/.test(key)) fail('Dokumen tidak tersedia.', 404);
  const resolved = path.resolve(root, key);
  if (path.dirname(resolved) !== path.resolve(root)) fail('Dokumen tidak tersedia.', 404);
  return resolved;
}
async function saveDocument(tx, { file, noticeId, grNumber, actor, root = STORAGE_ROOT }) {
  const metadata = validateFile(file);
  if (Boolean(noticeId) === Boolean(grNumber)) fail('Target dokumen tidak valid.');
  const where = noticeId ? { noticeId } : { grNumber };
  const countWhere = grNumber ? { OR: [{ grNumber }, { notice: { grNumber } }] } : where;
  if (await tx.incomingDocument.count({ where: countWhere }) >= 10) fail('Maksimal 10 dokumen per pengiriman.');
  const storageKey = `${randomUUID()}.bin`;
  await fs.mkdir(root, { recursive: true });
  const location = documentPath(storageKey, root);
  await fs.writeFile(location, file.buffer, { flag: 'wx', mode: 0o600 });
  try {
    const saved = await tx.incomingDocument.create({ data: { ...metadata, ...where, storageKey, uploadedBy: actor } });
    return { saved, cleanup: () => fs.unlink(location).catch(() => {}) };
  } catch (error) { await fs.unlink(location).catch(() => {}); throw error; }
}
function documentOwnership(scope) {
  return { OR: [ { notice: { po: { isDeleted: false, ...scope } } }, { gr: { isDeleted: false, po: { isDeleted: false, ...scope } } } ] };
}
async function downloadDocument(db, req, res, scope) {
  const doc = await db.incomingDocument.findFirst({ where: { id: req.params.documentId, ...(scope ? documentOwnership(scope) : {}) } });
  if (!doc) fail('Dokumen tidak ditemukan.', 404);
  const file = documentPath(doc.storageKey);
  try { await fs.access(file); } catch { fail('File dokumen tidak tersedia.', 404); }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  res.type(doc.fileType);
  return new Promise((resolve, reject) => res.download(file, doc.fileName, error => error ? reject(error) : resolve()));
}
module.exports = { STORAGE_ROOT, publicDocument, documentPath, saveDocument, documentOwnership, downloadDocument };
