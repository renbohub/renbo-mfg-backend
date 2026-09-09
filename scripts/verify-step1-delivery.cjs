"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");
const path = require("path");
const fs = require("fs/promises");
const { PNG } = require("pngjs");
const jsQR = require("jsqr");
const evidence = require("../src/prisma/services/outgoing/deliveryEvidenceService");
const documents = require("../src/prisma/services/outgoing/deliveryNotePdfService");
const { createQrPng } = require("../src/prisma/services/documents/qrCodeService");

test("ship requires confirmation and a real driver or courier", () => {
  assert.throws(() => evidence.validateShipment({}), /Konfirmasi/);
  assert.throws(() => evidence.validateShipment({ confirmed: true, driver: " " }), /pengemudi/);
  assert.throws(() => evidence.validateShipment({ confirmed: true, driver: {} }), /teks/);
  assert.equal(evidence.validateShipment({ confirmed: true, carrier: " Kurir Mandiri ", trackingNumber: "R-120" }).carrier, "Kurir Mandiri");
});
test("POD requires a named recipient; optional signature remains optional", () => {
  assert.throws(() => evidence.validatePod({ confirmed: true, receivedBy: " " }), /penerima/);
  assert.throws(() => evidence.validatePod({ confirmed: true, receivedBy: "Ani", podUrl: "https://external/file.pdf" }), /eksternal/);
  assert.deepEqual(evidence.validatePod({ confirmed: true, receivedBy: " Ani " }), { receivedBy: "Ani", signature: null, pod: null });
});
test("evidence rejects spoofed types, oversized content, blank signatures and traversal", () => {
  assert.throws(() => evidence.decodeEvidence("data:application/pdf;base64,SGVsbG8="), /PDF/);
  assert.throws(() => evidence.decodeEvidence("data:image/svg+xml;base64,PHN2Zz4="), /PNG/);
  assert.throws(() => evidence.decodeEvidence(`data:application/pdf;base64,${"A".repeat(8 * 1024 * 1024)}`), /batas/);
  assert.throws(() => evidence.resolveEvidence("private-delivery:../../secret.pdf"), /tersimpan/);
  const png = new PNG({ width: 100, height: 30 });
  const blank = `data:image/png;base64,${PNG.sync.write(png).toString("base64")}`;
  assert.throws(() => evidence.decodeEvidence(blank, { signature: true }), /kosong/);
  for (let index = 400; index < 1000; index += 4) png.data[index + 3] = 255;
  const signed = `data:image/png;base64,${PNG.sync.write(png).toString("base64")}`;
  assert.equal(evidence.decodeEvidence(signed, { signature: true }).mime, "image/png");
});
test("private evidence storage round trip and cleanup stay inside storage", async () => {
  const root = await fs.mkdtemp(path.resolve(__dirname, "../../tmp/delivery-evidence-test-"));
  const file = evidence.decodeEvidence(`data:application/pdf;base64,${Buffer.from("%PDF-1.4\n%%EOF").toString("base64")}`);
  const reference = await evidence.saveEvidence(file, root);
  const stored = evidence.resolveEvidence(reference, root);
  assert.equal(path.dirname(stored.path), root);
  assert.deepEqual(await fs.readFile(stored.path), file.buffer);
  await evidence.removeEvidence(reference, root);
  await assert.rejects(fs.stat(stored.path), { code: "ENOENT" });
  await fs.rmdir(root);
});
test("QR decodes to the exact authenticated delivery lookup reference", async () => {
  const reference = documents.deliveryReference("DS-20260908-TEST0001");
  const png = PNG.sync.read(await createQrPng(reference));
  assert.equal(jsQR(new Uint8ClampedArray(png.data), png.width, png.height).data, reference);
  assert.equal(documents.parseDeliveryReference(reference), "DS-20260908-TEST0001");
  assert.throws(() => documents.parseDeliveryReference("https://evil.example/token"), /valid/);
  assert.throws(() => documents.parseDeliveryReference("../../other"), /valid/);
});

function fixture() {
  return {
    schedule: { id: "ds1", scheduleNumber: "DS-TEST-001", soNumber: "SO-TEST-1", status: "In Transit", isDeleted: false,
      details: [{ id: "detail1", soDetailId: "so-line1", qty: 10, qtyDelivered: 0, isDeleted: false, soDetail: { id: "so-line1", lineNumber: 1, qty: 20, qtyDelivered: 0, uomCode: "PCS" } }] },
    balance: { id: "stock1", partCode: "FG-1", qtyOnHand: 10, qtyReserved: 10, qtyAvailable: 0, qtyQC: 0, warehouseCode: "FG", stockType: "Finished Goods", isDeleted: false },
    reservations: [{ id: "r1", stockBalanceId: "stock1", qtyReserved: 4, qtyReleased: 0 }, { id: "r2", stockBalanceId: "stock1", qtyReserved: 6, qtyReleased: 0 }],
    movements: [], syncCalls: 0,
  };
}
function loadController(initial, options = {}) {
  let state = structuredClone(initial); let queue = Promise.resolve();
  const tx = {
    deliverySchedule: {
      findFirst: async ({ where }) => state.schedule && (!where.status || where.status === state.schedule.status) ? structuredClone(state.schedule) : null,
      updateMany: async ({ where, data }) => { assert.equal(where.isDeleted, false); if (options.lostClaim || where.status !== state.schedule.status) return { count: 0 }; Object.assign(state.schedule, data); return { count: 1 }; },
      findUnique: async () => structuredClone(state.schedule),
    },
    stockBalance: {
      findUnique: async () => structuredClone(state.balance),
      updateMany: async ({ where, data }) => { if (state.balance.qtyOnHand !== where.qtyOnHand || state.balance.qtyReserved !== where.qtyReserved) return { count: 0 }; Object.assign(state.balance, data); return { count: 1 }; },
    },
    stockReservation: {
      findMany: async () => state.reservations.map((r) => ({ ...r, stockBalance: structuredClone(state.balance) })),
      update: async ({ where, data }) => Object.assign(state.reservations.find((r) => r.id === where.id), data),
    },
    stockMovement: { create: async ({ data }) => state.movements.push(data) },
    deliveryScheduleDetail: { update: async ({ data }) => Object.assign(state.schedule.details[0], data) },
    salesOrderDetail: { update: async ({ data }) => { state.schedule.details[0].soDetail.qtyDelivered += data.qtyDelivered.increment; } },
  };
  const prisma = { ...tx, $transaction: (callback, config) => {
    assert.equal(config.isolationLevel, "Serializable");
    const result = queue.then(async () => { const before = structuredClone(state); try { return await callback(tx); } catch (error) { state = before; throw error; } });
    queue = result.catch(() => {}); return result;
  } };
  const original = Module._load;
  Module._load = function (request, parent, ...rest) {
    if (parent?.filename.endsWith("OutgoingTransactionController.js")) {
      if (request === "../../index") return { prisma };
      if (request.includes("soReservationService")) return { buildSoLineReferenceNumber: (so, line) => `${so}:${line}` };
      if (request.includes("soStatusService")) return { syncOperationalSalesOrderStatus: async () => { state.syncCalls += 1; } };
      if (request.includes("deliveryReadinessService")) return { resolveDeliveryReadiness: async () => ({ fgReady: !options.shortage, fgReadinessMessage: "FG shortage" }) };
      if (request.includes("stockOpnameFreezeGuard")) return { assertStockBalanceNotFrozen: async () => { if (options.frozen) throw Object.assign(new Error("Stock opname frozen"), { statusCode: 409 }); } };
    }
    return original.call(this, request, parent, ...rest);
  };
  const filename = require.resolve("../src/prisma/controllers/outgoing/OutgoingTransactionController"); delete require.cache[filename];
  let controller; try { controller = require(filename); } finally { Module._load = original; }
  return { controller, state: () => state };
}
async function invoke(controller, action, body = { receivedBy: "Ani", confirmed: true }) {
  const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
  await controller[action]({ params: { scheduleNumber: "DS-TEST-001" }, body, user: { username: "warehouse-1" } }, response, (error) => { throw error; });
  return response;
}
test("POD uses each shared balance once, updates SO and rejects repeated or concurrent confirmation", async () => {
  const { controller, state } = loadController(fixture());
  const results = await Promise.all([invoke(controller, "confirmPod"), invoke(controller, "confirmPod")]);
  assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409]);
  assert.equal(state().balance.qtyOnHand, 0);
  assert.deepEqual(state().movements.map((m) => m.qtyAfter), [6, 0]);
  assert.ok(state().movements.every((m) => m.referenceNumber === "DS-TEST-001"));
  assert.equal(state().schedule.details[0].soDetail.qtyDelivered, 10);
  assert.equal(state().syncCalls, 1);
  assert.equal((await invoke(controller, "confirmPod")).statusCode, 409);
});
test("POD lost status claim does not write stock or SO", async () => {
  const { controller, state } = loadController(fixture(), { lostClaim: true });
  assert.equal((await invoke(controller, "confirmPod")).statusCode, 409);
  assert.equal(state().movements.length, 0); assert.equal(state().balance.qtyOnHand, 10);
});
test("POD frozen stock or insufficient reservation rolls back Delivered status and every stock write", async () => {
  for (const mode of ["frozen", "shortage"]) {
    const data = fixture(); if (mode === "shortage") data.schedule.details[0].qty = 12;
    const { controller, state } = loadController(data, { frozen: mode === "frozen" });
    assert.equal((await invoke(controller, "confirmPod")).statusCode, 409);
    assert.equal(state().schedule.status, "In Transit"); assert.equal(state().movements.length, 0); assert.equal(state().balance.qtyOnHand, 10);
  }
});
test("shipment readiness failure rolls back transition; valid carrier persists without stock posting", async () => {
  for (const shortage of [false, true]) {
    const data = fixture(); data.schedule.status = "On Process";
    const { controller, state } = loadController(data, { shortage });
    const response = await invoke(controller, "markShipment", { confirmed: true, carrier: "Kurir Mandiri", vehicle: "B 1234 AA", trackingNumber: "RESI-001" });
    assert.equal(response.statusCode, shortage ? 409 : 200);
    assert.equal(state().schedule.status, shortage ? "On Process" : "In Transit");
    assert.equal(state().movements.length, 0);
    if (!shortage) { assert.equal(state().schedule.carrier, "Kurir Mandiri"); assert.equal((await invoke(controller, "markShipment", { confirmed: true, driver: "Budi" })).statusCode, 409); }
  }
});
test("dedicated delivery PDF supports multiple pages without dropping lines", async () => {
  const data = { scheduleNumber: "DS-20260908-TEST0001", soNumber: "SO-TEST-001", plannedDate: "2026-09-08", shippedAt: "2026-09-08", status: "In Transit", driver: "Budi Santoso", carrier: "Ekspedisi Mandiri", vehicle: "B 1234 AA", trackingNumber: "TRK-001", deliveryAddress: "Jl. Industri No. 10, Kawasan Industri, Cikarang, Jawa Barat", soHeader: { customerCode: "CUST-001", customerName: "Customer Uji Surat Jalan" }, details: Array.from({ length: 48 }, (_, index) => ({ qty: index + 1, soDetail: { partCode: `FG-${String(index + 1).padStart(3, "0")}`, partNumber: `PN-ABC-${index + 1}`, partName: `Bracket penguat struktur bagian ${index + 1}`, uomCode: "PCS" } })) };
  const buffer = await documents.createDeliveryNotePdf(data);
  assert.equal(buffer.subarray(0, 4).toString(), "%PDF");
  const pageCount = (buffer.toString("latin1").match(/\/Type \/Page\b/g) || []).length;
  assert.ok(pageCount >= 3 && pageCount <= 5);
  if (process.env.DELIVERY_PDF_PREVIEW) await fs.writeFile(process.env.DELIVERY_PDF_PREVIEW, buffer);
});
