"use strict";
function assertManualMovementAllowed(input) {
  if (String(input?.movementType || "").trim().toUpperCase() === "ADJUSTMENT") {
    throw Object.assign(new Error("Koreksi stok wajib melalui Stock Opname yang telah disetujui. Buat dokumen Stock Opname, lakukan pemeriksaan dan approval, lalu Posting Adjustment."), { statusCode: 409 });
  }
}
module.exports = { assertManualMovementAllowed };
