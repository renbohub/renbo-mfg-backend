const { prisma } = require("../../index");
const { buildStockOpnameReport, createStockOpnameWorkbook, createStockOpnamePdf, createStockOpnameLabels, resolveStockOpnameScan } = require("../../services/inventory/stockOpnameDocumentService");

// Read all active lines and rounds from one consistent database snapshot. A
// paginated browser table is never used as the source of the export.
async function loadDocument(stoNo) {
  const item = await prisma.$transaction((tx) => tx.stockOpnameHeader.findFirst({ where: { stoNo, isDeleted: false }, include: {
    details: { where: { isDeleted: false }, orderBy: [{ rackCode: "asc" }, { partCode: "asc" }, { lotNumber: "asc" }, { id: "asc" }] },
    countRounds: { orderBy: { roundNo: "asc" }, include: { attempts: { orderBy: [{ stoDetailId: "asc" }, { sequenceNo: "asc" }] } } },
  } }), { isolationLevel: "RepeatableRead" });
  if (!item) throw Object.assign(new Error("Stock opname tidak ditemukan."), { statusCode: 404 });
  return item;
}
function exportDocument(kind) { return async (req, res, next) => {
  try {
    const item = await loadDocument(req.params.stoNo);
    const buffer = kind === "labels" ? await createStockOpnameLabels(item) : kind === "xlsx" ? createStockOpnameWorkbook(buildStockOpnameReport(item)) : await createStockOpnamePdf(buildStockOpnameReport(item));
    const extension = kind === "xlsx" ? "xlsx" : "pdf";
    res.set({ "Content-Type": kind === "xlsx" ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "application/pdf", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Disposition": `attachment; filename="Stock-Opname-${item.stoNo.replace(/[^A-Za-z0-9_-]/g, "-")}-${kind}.${extension}"` }).send(buffer);
  } catch (error) { if (error.statusCode) return res.status(error.statusCode).json({ message: error.message }); next(error); }
}; }
exports.pdf = exportDocument("pdf");
exports.xlsx = exportDocument("xlsx");
exports.labels = exportDocument("labels");
exports.scan = async (req, res, next) => {
  try { const item = await loadDocument(req.params.stoNo); res.set("Cache-Control", "no-store").json(resolveStockOpnameScan(item, req.query.reference || req.query.code)); }
  catch (error) { if (error.statusCode) return res.status(error.statusCode).json({ message: error.message }); next(error); }
};
