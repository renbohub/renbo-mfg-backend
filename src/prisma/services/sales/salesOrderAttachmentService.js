const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { lockSalesOrder } = require('./salesOrderWorkflowService');
const ROOT = path.resolve(__dirname, '../../../../storage/sales-order-attachments');
const MAX_BYTES = 10 * 1024 * 1024;
const MIME = { '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
function zipEntries(buffer) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw fail('Dokumen Office tidak valid.');
  const count = buffer.readUInt16LE(eocd + 10); let offset = buffer.readUInt32LE(eocd + 16); let total = 0; const names = [];
  if (!count || count > 2000) throw fail('Isi dokumen Office melebihi batas.');
  for (let i = 0; i < count; i++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) throw fail('Struktur Office tidak valid.');
    const flags = buffer.readUInt16LE(offset + 8), length = buffer.readUInt16LE(offset + 28), size = buffer.readUInt32LE(offset + 24);
    total += size;
    if ((flags & 1) || total > 50 * 1024 * 1024 || offset + 46 + length > buffer.length) throw fail('Dokumen terenkripsi atau terlalu besar tidak didukung.');
    const name = buffer.toString('utf8', offset + 46, offset + 46 + length);
    if (name.includes('..') || /vbaProject|\.exe$|\.js$/i.test(name)) throw fail('Konten aktif tidak didukung.');
    names.push(name);
    offset += 46 + length + buffer.readUInt16LE(offset + 30) + buffer.readUInt16LE(offset + 32);
  }
  return names;
}
function validateFile(file) {
  if (!file?.buffer?.length || file.buffer.length > MAX_BYTES) throw fail('File wajib diisi, maksimal 10 MB.');
  const fileName = path.basename(String(file.originalname || '').replace(/\\/g, '/')).replace(/[\u0000-\u001f<>:"|?*]/g, '_').slice(0, 180);
  const ext = path.extname(fileName).toLowerCase();
  if (!MIME[ext]) throw fail('Lampiran hanya mendukung PDF, DOCX, dan XLSX.');
  if (ext === '.pdf') {
    if (file.buffer.subarray(0, 5).toString() !== '%PDF-') throw fail('Isi file tidak sesuai PDF.');
  } else {
    const names = zipEntries(file.buffer);
    if (!names.includes('[Content_Types].xml') || !names.includes(ext === '.docx' ? 'word/document.xml' : 'xl/workbook.xml')) throw fail('Isi file tidak sesuai ekstensi Office.');
  }
  return { fileName, fileType: MIME[ext], fileSize: file.buffer.length, storageKey: `${crypto.randomUUID()}${ext}` };
}
function storedPath(storageKey) {
  if (!/^[0-9a-f-]{36}\.(pdf|docx|xlsx)$/.test(storageKey || '')) throw fail('Referensi file tidak valid.', 404);
  const absolute = path.resolve(ROOT, storageKey);
  if (path.dirname(absolute) !== ROOT) throw fail('Referensi file tidak valid.', 404);
  return absolute;
}
function publicAttachment(row) {
  return { id: row.id, title: row.title, description: row.description, uploadedBy: row.uploadedBy, createdAt: row.createdAt, files: (Array.isArray(row.files) ? row.files : []).map((f, i) => ({ fileName: f.fileName, fileType: f.fileType, fileSize: f.fileSize, downloadUrl: `/modules/api/sales/sales-orders/${encodeURIComponent(row.soNumber)}/attachments/${encodeURIComponent(row.id)}/files/${i}` })) };
}
async function add(prisma, soNumber, file, user, body = {}) {
  const metadata = validateFile(file);
  await fs.mkdir(ROOT, { recursive: true });
  const filename = storedPath(metadata.storageKey);
  await fs.writeFile(filename, file.buffer, { flag: 'wx', mode: 0o600 });
  try {
    return await prisma.$transaction(async tx => {
      await lockSalesOrder(tx, soNumber);
      const doc = await tx.salesOrderHeader.findFirst({ where: { soNumber, isDeleted: false } });
      if (!doc) throw fail('Sales Order tidak ditemukan.', 404);
      if (doc.status !== 'Draft') throw fail('Lampiran hanya dapat diubah pada SO Draft.', 409);
      if (await tx.salesOrderAttachment.count({ where: { soNumber, isDeleted: false } }) >= 20) throw fail('Maksimal 20 lampiran per SO.', 409);
      return publicAttachment(await tx.salesOrderAttachment.create({ data: { soNumber, title: String(body.title || metadata.fileName).slice(0, 180), description: String(body.description || '').slice(0, 1000) || null, files: [metadata], uploadedBy: user?.username || user?.email } }));
    });
  } catch (error) { await fs.unlink(filename).catch(() => {}); throw error; }
}
async function remove(prisma, soNumber, id) {
  return prisma.$transaction(async tx => {
    await lockSalesOrder(tx, soNumber);
    const doc = await tx.salesOrderHeader.findFirst({ where: { soNumber, isDeleted: false } });
    if (!doc) throw fail('Sales Order tidak ditemukan.', 404);
    if (doc.status !== 'Draft') throw fail('Lampiran hanya dapat dihapus pada SO Draft.', 409);
    const result = await tx.salesOrderAttachment.updateMany({ where: { id, soNumber, isDeleted: false }, data: { isDeleted: true } });
    if (!result.count) throw fail('Lampiran tidak ditemukan.', 404);
    // Retain private bytes as audit evidence; deleted rows can no longer download.
    return { ok: true };
  });
}
async function download(prisma, req, res) {
  const attachment = await prisma.salesOrderAttachment.findFirst({ where: { id: req.params.attachmentId, soNumber: req.params.soNumber, isDeleted: false, soHeader: { isDeleted: false } } });
  const index = Number(req.params.fileIndex);
  const file = attachment && Number.isInteger(index) && index >= 0 && Array.isArray(attachment.files) ? attachment.files[index] : null;
  if (!file) throw fail('Lampiran tidak ditemukan.', 404);
  const filename = storedPath(file.storageKey);
  const stat = await fs.lstat(filename).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink()) throw fail('File tidak tersedia.', 404);
  res.set({ 'Content-Type': file.fileType, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}` });
  return res.sendFile(filename);
}
const uploadOne = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 1, fields: 2, fieldSize: 2000 } }).single('file');
function upload(req, res, next) { uploadOne(req, res, error => error ? res.status(400).json({ message: error.code === 'LIMIT_FILE_SIZE' ? 'Maksimal ukuran file 10 MB.' : 'Upload lampiran tidak valid.' }) : next()); }
module.exports = { MAX_BYTES, ROOT, validateFile, zipEntries, storedPath, publicAttachment, add, remove, download, upload };
