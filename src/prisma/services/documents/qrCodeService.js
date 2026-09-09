const QRCode = require("qrcode");

// Encodes the actual reference using a maintained QR implementation. References
// never include access tokens; the lookup endpoint still requires ERP login.
async function createQrPng(reference) {
  if (typeof reference !== "string" || !reference.trim() || reference.length > 2048) {
    throw Object.assign(new Error("Referensi QR tidak valid."), { statusCode: 400 });
  }
  return QRCode.toBuffer(reference, { type: "png", errorCorrectionLevel: "M", margin: 4, scale: 6 });
}

module.exports = { createQrPng };
