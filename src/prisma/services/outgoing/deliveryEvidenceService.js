const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const { PNG } = require("pngjs");

const PRIVATE_ROOT = path.resolve(__dirname, "../../../../storage/private/delivery-pod");
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_SIGNATURE_BYTES = 256 * 1024;
const invalid = (message) => Object.assign(new Error(message), { statusCode: 400 });

function text(value, label, maxLength = 200, required = false) {
  if (value != null && typeof value !== "string") throw invalid(`${label} harus berupa teks.`);
  const result = String(value || "").trim();
  if ((required && !result) || result.length > maxLength || /[\x00-\x1f]/.test(result)) throw invalid(`${label} tidak valid (maks. ${maxLength} karakter).`);
  return result || null;
}

function validateShipment(body = {}) {
  if (body.confirmed !== true) throw invalid("Konfirmasi data pengiriman terlebih dahulu.");
  const result = {
    driver: text(body.driver, "Pengemudi"), carrier: text(body.carrier, "Kurir / ekspedisi"),
    vehicle: text(body.vehicle, "Kendaraan", 100), trackingNumber: text(body.trackingNumber, "Nomor resi", 100),
    shippingMethod: text(body.shippingMethod, "Metode pengiriman", 100),
  };
  if (!result.driver && !result.carrier) throw invalid("Isi pengemudi atau kurir / ekspedisi.");
  return result;
}

function decodeEvidence(dataUrl, { signature = false } = {}) {
  const max = signature ? MAX_SIGNATURE_BYTES : MAX_FILE_BYTES;
  if (typeof dataUrl !== "string" || dataUrl.length > Math.ceil(max * 4 / 3) + 100) throw invalid("Ukuran bukti melebihi batas.");
  const match = /^data:(image\/png|image\/jpeg|application\/pdf);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match) throw invalid("Bukti harus berupa PNG, JPG, atau PDF dalam format valid.");
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length || buffer.length > max || buffer.toString("base64") !== match[2]) throw invalid("Isi bukti tidak valid atau melebihi batas.");
  const mime = match[1];
  if (signature && mime !== "image/png") throw invalid("Tanda tangan harus berupa PNG.");
  if (mime === "image/png") {
    if (buffer.length < 24 || !buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw invalid("File PNG tidak valid.");
    const width = buffer.readUInt32BE(16); const height = buffer.readUInt32BE(20);
    if (!width || !height || width * height > 16000000 || (signature && (width > 2000 || height > 1000))) throw invalid("Dimensi gambar terlalu besar.");
    if (signature) {
      let png;
      try { png = PNG.sync.read(buffer); } catch { throw invalid("Tanda tangan PNG rusak."); }
      let ink = 0;
      for (let index = 0; index < png.data.length; index += 4) {
        if (png.data[index + 3] > 40 && Math.min(png.data[index], png.data[index + 1], png.data[index + 2]) < 200) ink += 1;
      }
      if (ink < 20) throw invalid("Tanda tangan masih kosong.");
    }
  } else if (mime === "image/jpeg" && (buffer[0] !== 255 || buffer[1] !== 216 || buffer[2] !== 255)) {
    throw invalid("File JPEG tidak valid.");
  } else if (mime === "application/pdf" && buffer.subarray(0, 5).toString() !== "%PDF-") {
    throw invalid("File PDF tidak valid.");
  }
  return { buffer, mime, extension: ({ "image/png": "png", "image/jpeg": "jpg", "application/pdf": "pdf" })[mime] };
}

function validatePod(body = {}) {
  if (body.confirmed !== true) throw invalid("Konfirmasi penerimaan barang terlebih dahulu.");
  if (body.podUrl) throw invalid("Gunakan unggah bukti POD; tautan eksternal tidak diterima.");
  const receivedBy = text(body.receivedBy, "Nama penerima", 200, true);
  const signature = body.receivedSignature ? decodeEvidence(body.receivedSignature, { signature: true }) : null;
  let pod = null;
  if (body.podFile != null) {
    if (!body.podFile || typeof body.podFile !== "object" || Array.isArray(body.podFile)) throw invalid("Bukti POD tidak valid.");
    text(body.podFile.name, "Nama file", 250, true);
    pod = decodeEvidence(body.podFile.dataUrl);
  }
  // Signature / OTP was optional in the accepted STEP 1 offer.
  return { receivedBy, signature, pod };
}

async function saveEvidence(evidence, root = PRIVATE_ROOT) {
  if (!evidence) return null;
  await fs.mkdir(root, { recursive: true });
  const key = `${crypto.randomUUID()}.${evidence.extension}`;
  await fs.writeFile(path.join(root, key), evidence.buffer, { flag: "wx", mode: 0o600 });
  return `private-delivery:${key}`;
}

function resolveEvidence(reference, root = PRIVATE_ROOT) {
  const match = /^private-delivery:([a-f0-9-]{36}\.(png|jpg|pdf))$/.exec(String(reference || ""));
  if (!match) throw Object.assign(new Error("Bukti tersimpan tidak tersedia."), { statusCode: 404 });
  return { path: path.join(root, match[1]), filename: match[1], mime: ({ png: "image/png", jpg: "image/jpeg", pdf: "application/pdf" })[match[2]] };
}

async function removeEvidence(reference, root = PRIVATE_ROOT) {
  if (reference) await fs.unlink(resolveEvidence(reference, root).path).catch((error) => { if (error.code !== "ENOENT") throw error; });
}

module.exports = { validateShipment, validatePod, decodeEvidence, saveEvidence, resolveEvidence, removeEvidence, MAX_FILE_BYTES };
