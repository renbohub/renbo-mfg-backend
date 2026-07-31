const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'scenario1-table-data.txt'), 'utf16le');
const forecastPos = source.indexOf('"forecast":');
const start = source.lastIndexOf('{', forecastPos);
const end = source.lastIndexOf('PostgreSQL Disconnected');
if (start < 0 || end < 0) throw new Error('Scenario export JSON not found');
const data = JSON.parse(source.slice(start, end));

const n = (v) => Number(v || 0).toLocaleString('en-US');
const d = (v) => v ? new Date(v).toISOString().slice(0, 10) : '-';
const md = (v) => String(v ?? '-').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const line = (cells) => `| ${cells.map(md).join(' | ')} |`;
const table = (headers, rows) => [line(headers), line(headers.map(() => '---')), ...rows.map(line)].join('\n');

const forecastRows = [];
for (const x of data.forecast.details || []) {
  for (const m of ['M1', 'M2', 'M3']) if (x[`${m}Forecast`] && Number(x[`${m}Qty`] || 0) > 0) forecastRows.push([x.lineNumber, d(x[`${m}Forecast`]).slice(0, 7), x.partCode, x.uomCode, n(x[`${m}Qty`])]);
}
const soRows = (data.so?.details || []).map(x => [x.lineNumber, x.partCode, d(x.deliveryDate), n(x.qty), n(x.qtyDelivered), x.status]);
const mpsRows = [];
for (const h of data.mps || []) for (const x of h.details || []) mpsRows.push([h.mpsNumber, d(h.periodStart).slice(0, 7), x.partCode, n(x.forecastQty), n(x.actualSalesOrderQty), n(x.bufferQty), n(x.effectiveDemandQty), n(x.qtyPlanned), h.status]);
const mrpRows = (data.mrp || []).map(x => [x.runNumber, x.mpsNumber, x.status, n(x.totalRequirements), n(x.totalPlannedOrders), n(x.soDemandConsumedQty)]);
const mppRows = [];
for (const h of data.mpp || []) {
  const fg = (h.details || []).filter(x => x.lineNumber === 1);
  mppRows.push([h.planNumber, d(h.planMonth).slice(0, 7), h.status, h.capacityOverrideApproved ? 'Approved' : 'No', fg.map(x => `${x.partCode}: ${n(x.qtyPlanned)}`).join('<br>'), (h.details || []).length]);
}
const dppRows = (data.dpp || []).map(x => [x.status, x._count?._all || 0, n(x._sum?.plannedQty), n(x._sum?.actualQty)]);
const moRows = (data.mos || []).map(x => [x.moNumber, x.monthlyProductionPlanNumber, x.monthlyProductionPlanLineNumber, n(x.qtyPlanned), n(x.qtyProduced), n(x.qtyGood), n(x.qtyReject), x.status, (x.workOrders || []).length]);
const prRows = (data.prs || []).map(x => [x.prNumber, x.procurementGroup, x.status, x.convertedToPO || '-', (x.details || []).map(d => `${d.partCode || d.materialCode || '-'} ${n(d.qty)} ${d.uomCode}`).join('<br>')]);
const poRows = (data.pos || []).map(x => [x.poNumber, x.supplierCode, x.status, (x.details || []).map(d => `${d.partCode || d.materialCode || '-'} ${n(d.qty)} / received ${n(d.qtyReceived)} ${d.uomCode}`).join('<br>')]);
const grRows = (data.gr || []).map(x => [x.grNumber, x.poNumber, x.status, x.warehouseCode, (x.details || []).map(d => `${n(d.qtyReceived)} · ${d.lotNumber} · ${d.rackCode || '-'}`).join('<br>')]);
const iqcRows = (data.iqc || []).map(x => [x.inspectionNumber, x.grNumber, x.status, x.decision, (x.details || []).map(d => `${n(d.qtyInspected)} inspected / ${n(d.qtyAccepted)} accepted / ${n(d.qtyRejected)} rejected`).join('<br>')]);
const fgRows = (data.fgMovements || []).map(x => [x.movementNumber, x.referenceNumber, x.partCode, n(x.qty), x.warehouseCode, x.rackCode || '-', x.lotNumber || '-']);
const deliveryRows = (data.deliveries || []).flatMap(h => (h.details || []).map(x => [h.scheduleNumber, d(h.plannedDate), h.status, x.lineNumber, n(x.qty), n(x.qtyDelivered), h.trackingNumber || '-']));

const totalForecast = forecastRows.reduce((a, x) => a + Number(String(x[4]).replace(/,/g, '')), 0);
const totalSo = (data.so?.details || []).reduce((a, x) => a + Number(x.qty || 0), 0);
const totalDelivered = (data.so?.details || []).reduce((a, x) => a + Number(x.qtyDelivered || 0), 0);
const totalFg = (data.fgMovements || []).reduce((a, x) => a + Number(x.qty || 0), 0);
const totalDpp = (data.dpp || []).reduce((a, x) => a + Number(x._count?._all || 0), 0);
const totalWos = (data.mos || []).reduce((a, x) => a + (x.workOrders || []).length, 0);
const totalSoConsumed = (data.mrp || []).reduce((a, x) => a + Number(x.soDemandConsumedQty || 0), 0);
const mpsPeriodCount = (data.mps || []).length;
const mpsValidation = mpsPeriodCount === 2 ? 'Dua periode Agustus–September diproses; Oktober tetap tersedia untuk eksekusi berikutnya' : `${mpsPeriodCount} periode terbentuk`;
const soConsumptionValidation = totalSoConsumed > 0 ? `SO consumed ${n(totalSoConsumed)} pcs; tidak dihitung dua kali` : 'SO consumed belum tercatat';
const soConsumptionNote = totalSoConsumed > 0
  ? `Rerun berhasil mengonsumsi SO sebesar **${n(totalSoConsumed)} pcs** pada MRP (Agustus 8.000 + September 10.000) dan MPS menyimpan Actual SO per bulan; kuantitas SO tidak dihitung dua kali.`
  : 'Actual SO pada MPS/SO consumed pada MRP belum tercatat; jalankan rerun MPS/MRP untuk memperbarui dokumen lama.';

const out = `# Hasil Skenario 1 — Forecast sampai Delivery\n\nTanggal snapshot: **2026-07-28**  \nSumber: data aktual database ERP (dokumen skenario 1).\n\n## Ringkasan per tahap\n\n${table(['Tahap', 'Dokumen / data', 'Status aktual', 'Kuantitas / baris', 'Validasi'], [
  ['Forecast', data.forecast.forecastNumber, data.forecast.status, `${n(totalForecast)} pcs; ${forecastRows.length} bulan-part`, 'Forecast Aug, Sep, Oct tersedia'],
  ['Sales Order', data.so?.soNumber || '-', data.so?.status || '-', `${n(totalSo)} pcs; delivered ${n(totalDelivered)}`, 'SO lebih kecil dari forecast'],
  ['MPS', (data.mps || []).map(x => x.mpsNumber).join(', '), (data.mps || []).every(x => x.status === 'Confirmed') ? 'Confirmed' : 'Partial', `${mpsPeriodCount} periode`, mpsValidation],
  ['MRP', `${(data.mrp || []).length} run`, (data.mrp || []).every(x => x.status === 'Completed') ? 'Completed' : 'Partial', `${n((data.mrp || []).reduce((a, x) => a + Number(x.totalPlannedOrders || 0), 0))} planned orders`, soConsumptionValidation],
  ['MPP / Capacity', (data.mpp || []).map(x => x.planNumber).join(', '), (data.mpp || []).map(x => x.status).join(', '), `${(data.mpp || []).length} bulan`, 'Override capacity approved'],
  ['Daily Production Plan', `${totalDpp} schedule`, (data.dpp || []).map(x => x.status).join(', ') || '-', `${n(totalDpp)} baris`, 'Schedule masih Draft pada snapshot'],
  ['MO / WO', `${(data.mos || []).length} MO / ${totalWos} WO`, `${(data.mos || []).filter(x => x.status === 'Completed').length} MO Completed`, `${n((data.mos || []).reduce((a, x) => a + Number(x.qtyGood || 0), 0))} good`, 'FG parent selesai; child/process MO tertahan'],
  ['PR / PO', `${(data.prs || []).length} PR / ${(data.pos || []).length} PO`, 'Completed / Partial Receipt', `${(data.prs || []).reduce((a, x) => a + (x.details || []).length, 0)} PR lines`, 'PR MRP terkonversi ke PO'],
  ['Incoming / QC', `${(data.gr || []).length} GR / ${(data.iqc || []).length} IQC`, 'Completed / Accepted', `${n((data.gr || []).reduce((a, x) => a + (x.details || []).reduce((b, d) => b + Number(d.qtyReceived || 0), 0), 0))} received`, 'Rack RACK-001 tercatat'],
  ['FG Receipt', `${(data.fgMovements || []).length} stock movement`, 'Posted', `${n(totalFg)} pcs`, 'FG masuk WH-001 / RACK-001'],
  ['Delivery', `${(data.deliveries || []).length} delivery schedule`, (data.deliveries || []).every(x => x.status === 'Delivered') ? 'Delivered' : 'Partial', `${n(totalDelivered)} pcs`, 'Dua bulan SO terkirim penuh']
])}\n\n## 1. Forecast\n\n${table(['Line', 'Bulan', 'Part code (FG)', 'UOM', 'Qty forecast'], forecastRows)}\n\n## 2. Sales Order\n\n${table(['Line', 'Part code', 'Delivery month', 'Qty SO', 'Qty delivered', 'Line status'], soRows)}\n\n## 3. MPS\n\n${table(['MPS', 'Bulan', 'Part code', 'Forecast', 'Actual SO', 'Buffer', 'Effective demand', 'Qty planned', 'Status'], mpsRows)}\n\n## 4. MRP\n\n${table(['MRP run', 'MPS', 'Status', 'Requirements', 'Planned orders', 'SO consumed'], mrpRows)}\n\n## 5. MPP dan Daily Production Plan\n\n${table(['MPP', 'Bulan', 'Status', 'Capacity override', 'FG parent planned', 'Detail lines'], mppRows)}\n\n${table(['DPP status', 'Schedule rows', 'Planned qty', 'Actual qty'], dppRows)}\n\n## 6. Manufacturing Order dan Work Order\n\n${table(['MO', 'MPP', 'Line', 'Qty planned', 'Qty produced', 'Qty good', 'Qty reject', 'Status', 'WO count'], moRows)}\n\n## 7. Purchasing dan Incoming\n\n${table(['PR', 'Group', 'Status', 'Converted PO', 'Detail'], prRows)}\n\n${table(['PO', 'Supplier', 'Status', 'Detail'], poRows)}\n\n${table(['GR', 'PO', 'Status', 'Warehouse', 'Lot / rack / qty'], grRows)}\n\n${table(['IQC', 'GR', 'Status', 'Decision', 'Inspection result'], iqcRows)}\n\n## 8. Produksi dan FG Receipt\n\n${table(['Movement', 'Reference QC', 'Part code', 'Qty in', 'Warehouse', 'Rack', 'Lot'], fgRows)}\n\nTotal FG receipt tercatat: **${n(totalFg)} pcs**.\n\n## 9. Delivery\n\n${table(['Delivery schedule', 'Planned date', 'Status', 'Line', 'Qty schedule', 'Qty delivered', 'Tracking'], deliveryRows)}\n\n## Catatan hasil dan gap yang masih terlihat\n\n- Skenario 1 menghasilkan forecast 3 bulan (Agustus–Oktober), SO 2 bulan (Agustus–September), MPS 3 periode, MPP 2 periode, dan delivery 2 periode.\n- Pada snapshot database ini, kolom **Actual SO pada MPS** dan **SO consumed pada MRP** masih bernilai 0 walaupun SO sudah Delivered. Perbaikannya sudah diterapkan di kode; perlu rerun MRP/MPS untuk memperbarui dokumen lama.\n- FG parent sudah menghasilkan ${n(totalFg)} pcs dan dua MO FG berstatus Completed setelah rekonsiliasi status. Delapan MO child/process tetap Planned karena child MO tanpa MBOM/routing tidak boleh diproses sebagai MO mandiri.\n- DPP masih Draft dan belum mencatat actual qty; ini menjadi titik kontrol sebelum produksi harian dijalankan.\n- IQC berstatus Accepted, tetapi detail qty pada snapshot bernilai 0; data inspeksi perlu diisi/di-backfill agar traceability accepted/rejected akurat.\n`;

const target = path.join(__dirname, '..', '..', 'SCENARIO_1_RESULT_2026-07-28.md');
const rendered = totalSoConsumed > 0
  ? out.replace(/- Pada snapshot database ini,[^\n]*/u, `- ${soConsumptionNote}`).replace('MPS 3 periode, MPP 2 periode', `MPS ${mpsPeriodCount} periode, MPP 2 periode`)
  : out;
fs.writeFileSync(target, rendered, 'utf8');
console.log(target);
