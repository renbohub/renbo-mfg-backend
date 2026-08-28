# Validasi Workflow Forecast sampai Delivery

Tanggal audit: 27 Agustus 2026  
Ruang lingkup: Forecast, Demand Planning/EFD, MPS, MRP, Monthly/Daily Production Plan, Purchasing, Incoming, Inventory, Production, QC, FG Receipt, dan Outgoing.

## Ringkasan

- Seluruh 39 kebutuhan mempunyai jalur proses di aplikasi setelah tiga gap diperbaiki.
- Gap yang ditambahkan: jeda predecessor–successor 120 menit, status Material Issue `Preparing`, dan pilihan GR melalui QC atau langsung ke stok.
- Dua langkah awal perlu diperjelas: nomor 6 bukan Confirm MPS kedua, melainkan generate/review MPS; Accept Late dilakukan pada Demand Planning/MPS dan diwarisi MRP.
- Satu langkah operasional yang belum tertulis adalah `Consume Daily Plan`. Aksi ini membuat Draft Material Issue tampil pada Material Preparation Queue Inventory.

## Validasi 39 langkah awal

| No. | Kebutuhan | Status | Validasi / koreksi |
|---:|---|---|---|
| 1 | Confirm Forecast | Tersedia | Forecast wajib Draft → Submitted → Confirmed melalui approval. |
| 2 | Export Report Matrix FG Forecast | Tersedia | Report Outgoing per client memuat seluruh part `FG` yang mempunyai mBOM aktif, termasuk STANDARD maupun COMP; tersedia history, Last Delivery, dan Next Planned Delivery. |
| 3 | Buka Demand Planning | Tersedia | Demand target, feasibility, keputusan, dan simulasi tersedia. |
| 4 | EFD setting general | Tersedia | Default/general rule EFD tersedia sebagai fallback. |
| 5 | EFD per FG per bulan; sumber Forecast/PO | Tersedia | Override per customer–FG–bulan dan pemilihan sumber Forecast/PO/manual tersedia; baseline dapat dikunci. |
| 6 | Confirm MPS | Perlu koreksi urutan | Pada titik ini lakukan Generate/Calculate dan review MPS + RCCP, belum Confirm. |
| 7 | Accept Late bila terlambat | Tersedia | Accept Late wajib tanggal baru, alasan, dan approval; menjadi official exception. |
| 8 | Report Netting MPS | Tersedia | Netting dan calculation trace tersedia untuk review sebelum approval. |
| 9 | Confirm MPS | Tersedia | Confirm/Approve hanya lolos jika RCCP dan delivery-feasibility gate selesai. |
| 10 | Buka MRP dan Accept Late bila ada | Tersedia dengan koreksi | MRP membaca recovery/Accept Late yang sudah disetujui dari Demand Planning/MPS; keputusan tidak perlu diduplikasi. |
| 11 | Confirm MRP | Tersedia | Istilah sistem adalah Approve MRP; hanya revision Simulated dan source MPS yang terkunci yang dapat menjadi official/current. |
| 12 | Monthly Production Plan, algoritma, gap 2 jam, edit manual | Ditambahkan/tervalidasi | Recommendation, capacity validation, auto-correct, dan Daily Release sekarang memakai gap 120 menit. Edit time/machine/dies/manual allocation tersedia. |
| 13 | Tidak ada blocker | Tersedia | Blocker material, routing, machine, dies, vendor, sequence, quantity, calendar, dan delivery diperiksa. |
| 14 | Release ke Capacity Checked | Tersedia | Confirm/validation menggunakan capacity snapshot dan setting Current Use. |
| 15 | Release ke PPIC Production Plan | Tersedia | MPP Released dikonversi menjadi DPP per operation dengan MO/WO lineage. |
| 16 | Perbaiki waktu produksi | Tersedia | Jam mulai/selesai dan kapasitas machine-day dapat diedit sebelum release/freeze. |
| 17 | Geser ke next day jika tidak cukup | Tersedia | Auto-correct mencari work window berikutnya dan manual drag/move tersedia. |
| 18 | Material Issue tampil di Inventory | Tersedia setelah langkah tambahan | Production harus `Consume Daily Plan`; setelah itu Draft MI muncul di Material Preparation Queue. |
| 19 | Purchasing konfirmasi supplier | Tersedia | Supplier utama, split supplier, split delivery, due date, dan qty dikonfirmasi di Purchase Suggestion. |
| 20 | Tarik next plan yang terkena MOQ | Tersedia | MOQ/order multiple dan alokasi excess ke future demand/buffer tersedia. |
| 21 | Common part reserved per kebutuhan | Tersedia | Reservation dipisahkan per target part/FG; pemakaian bersama tidak dihitung ganda. |
| 22 | Release PR/PO | Tersedia | Suggestion → Draft PR → supplier confirmation/approval → PO checking/approval/send/confirm. |
| 23 | Incoming schedule plan dan actual | Tersedia | Incoming Dashboard membandingkan PO delivery plan, actual GR, overdue, due today, dan allocation. |
| 24 | GR memilih QC atau tidak | Ditambahkan | Pada GR Pending tersedia `Proses dengan QC` atau `Release Tanpa QC`; bypass wajib alasan dan tetap mempunyai audit inspection. |
| 25 | QC jika dipilih | Tersedia | IQC menerima accepted/rejected per baris beserta disposition. |
| 26 | Release stock dari QC atau langsung GR | Ditambahkan/tervalidasi | Kedua jalur memakai posting `QUALITY_RELEASE`, lot, rack, stock balance, dan auto allocation yang sama. |
| 27 | Dashboard material harian yang disiapkan | Tersedia | Material Preparation Queue menampilkan required date, shift, machine, DPP, MO/WO, part, line, dan status. |
| 28 | Sedang disiapkan → selesai; material dari proses sebelumnya; stok terpotong | Ditambahkan/tervalidasi | MI sekarang Draft → Preparing → Issued → Closed. Stock baru berkurang saat `Selesai Persiapan & Issue`; predecessor/WIP tetap menjadi gate. |
| 29 | Produksi hanya setelah Material Issue selesai | Tersedia | Start/Production Log diblokir bila WO belum Material Issued atau MI belum posted. |
| 30 | Production, NG, downtime | Tersedia | Production Entry mencatat good, NG multi-reason, downtime hierarchy, phase/coil, dan actual cycle time. |
| 31 | NG masuk QC untuk rework/limbah | Tersedia | NG disposition wajib membagi seluruh NG menjadi Rework dan final Reject/Scrap. |
| 32 | Rework OK masuk stock | Tersedia | Rework WO dibuat; hasil OK mengikuti QC stock release. |
| 33 | Barang OK masuk warehouse | Tersedia | Good output masuk QC Hold lalu Quality Release; operator self-check dapat release langsung dengan audit. Terminal FG tetap melalui FG Receipt. |
| 34 | Reject diganti agar kebutuhan PO terpenuhi | Tersedia | Production shortfall/reject menjadi carry-over atau overflow DPP berikutnya; customer demand tidak dianggap selesai oleh qty reject. |
| 35 | Cycle/DPP kedua mempunyai PO tambahan | Tersedia | Baseline EFD mendeteksi PO/SO delta positif dan dapat membuat Delta MPS/residual replan. |
| 36 | PO part lain berkurang | Tersedia | Delta negatif ditangani sebagai production cut/replan dengan proteksi execution yang sudah firm. |
| 37 | Handle PO+ | Tersedia | Coverage FG/firm receipt dihitung dulu; sisa tambahan saja yang menjadi Delta MPS/MRP. |
| 38 | Produksi sampai selesai | Tersedia | Completion tetap memeriksa material, predecessor, QC, shortfall, dan FG receipt. |
| 39 | Pengiriman | Tersedia | Delivery Schedule → Pick → Pack → Ship → POD; shipment diblokir sampai FG siap. |

## SOP final yang disarankan

### A. Prasyarat master dan demand

1. Validasi Customer, Part FG, mBOM aktif, routing, process, machine, dies, cycle time, UOM, warehouse/rack, supplier, lead time, MOQ, kalender kerja, dan approval rule.
2. Buat Forecast lalu Submit dan Approve sampai `Confirmed`.
3. Export Report Matrix FG per client untuk snapshot awal stock dan delivery history.
4. Buka Demand Planning dan review seluruh delivery target.
5. Set EFD general.
6. Set override EFD per customer–FG–bulan dan pilih sumber Forecast/PO/manual.
7. Lock baseline EFD agar perubahan PO berikutnya dapat dihitung sebagai delta.

### B. MPS dan MRP

8. Generate/Calculate MPS dari baseline yang sudah dikunci.
9. Review Netting MPS, calculation trace, RCCP, buffer, delivery phase, dan feasibility.
10. Buat serta approve recovery plan/Accept Late bila target tidak feasible.
11. Confirm/Approve MPS satu kali setelah seluruh gate selesai.
12. Run MRP dari planning cycle MPS yang lengkap.
13. Review netting stock, reservation, open PR/PO, WIP, purchase suggestion, planned order, due date, dan exception.
14. Approve MRP Simulated menjadi official/current.

### C. Production planning dan capacity

15. Buat Monthly Production Plan dari MRP official.
16. Jalankan auto recommendation; semua successor harus mulai minimal 120 menit setelah predecessor selesai.
17. Review material, routing, machine, dies, vendor, calendar, delivery, dan quantity blockers.
18. Koreksi manual jam, mesin, dies, qty, atau tanggal; geser ke hari kerja berikutnya bila slot tidak cukup.
19. Confirm MPP dan pastikan blocker count nol atau exception resmi telah disetujui.
20. Release MPP ke Capacity Current Use.
21. Convert/Release menjadi Daily Production Plan PPIC.
22. Production melakukan `Consume Daily Plan` untuk membuat Draft Material Issue di Inventory.

### D. Purchasing dan incoming

23. Konfirmasi supplier, delivery split, bentuk material, MOQ, order multiple, dan alokasi future demand di Purchase Suggestion.
24. Convert suggestion menjadi PR per kategori × supplier.
25. Submit/Approve PR lalu buat PO.
26. Jalankan checking, approval, send, dan supplier confirmation PO.
27. Monitor plan vs actual pada Incoming Dashboard.
28. Buat GR per lot/rack dan rekonsiliasi shortage/over receipt.
29. Pilih IQC atau Release Tanpa QC dengan alasan audit.
30. Jika IQC: input accepted/rejected dan disposition; putaway accepted, return/scrap rejected.
31. Pastikan stock Available, lot, rack, reservation, dan actual incoming sudah ter-update.

### E. Material preparation dan production

32. Inventory membuka Material Preparation Queue per hari/shift/machine.
33. Simpan alokasi rack/lot/qty lalu klik `Mulai Persiapan`.
34. Tunggu WIP/material predecessor bila belum tersedia; jangan bypass gate.
35. Setelah fisik siap, klik `Selesai Persiapan & Issue`; verifikasi stock movement OUT dan WO `Material Issued`.
36. Start Daily Plan/WO dan buat Production Entry.
37. Catat good output, NG reason, coil/phase, operator, waktu proses, dan downtime.
38. Approve good output; lakukan QC judgment untuk seluruh NG.
39. Buat Rework WO untuk rework dan disposition final untuk reject/scrap.
40. Release hasil OK ke WIP/stock; untuk terminal FG lakukan FG Receipt ke warehouse FG.
41. Jika qty good kurang dari kebutuhan, verifikasi carry-over/overflow DPP sampai shortage tertutup.

### F. Perubahan demand dan delivery

42. Jalankan Demand Planning cycle/revision berikutnya dan bandingkan PO/SO aktual dengan baseline EFD.
43. PO+ diproses melalui stock/firm-receipt coverage lalu Delta MPS dan residual MRP; PO- diproses melalui production cut tanpa mengubah execution firm.
44. Ulangi planning–purchasing–production sampai FG memenuhi delivery requirement.
45. Buat Delivery Schedule, lakukan Pick, Pack, Ship, dan konfirmasi POD; rekonsiliasi Last Delivery dan Next Planned Delivery pada report matrix.

## Bukti tes

- `test:forecast-to-delivery`: 17/17 kontrak.
- `test:daily-plan-revision`: lulus, termasuk gap 120 menit dan next-day placement.
- `test:capacity-predecessor-coverage`: 39/39.
- `test:mpp-recommendation`: lulus.
- `test:production-plan-execution`: lulus seluruh kontrak execution, purchasing, QC, material issue, shortfall, FG receipt, dan shipment gate.
- `test:mrp-planning-cycle`: 48/48.
- MPS delivery feasibility gate/review, MRP residual replan, supplier split, PO MOQ, DPP part reservation, NG output, NG disposition UI, production shortfall, dan approval recovery: lulus.

Catatan: validasi ini mencakup source contract dan test suite dengan koneksi database yang tersedia. UAT transaksi penuh tetap harus memakai satu dataset nyata yang mempunyai Forecast, mBOM/routing, stock, supplier, PO, mesin, dan delivery target yang lengkap.
