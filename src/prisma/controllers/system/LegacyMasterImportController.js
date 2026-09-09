const XLSX=require('xlsx');
const {prisma}=require('../../index');
const service=require('../../services/system/legacyMasterImportService');
const handler=fn=>async(req,res,next)=>{try{res.json(await fn(req));}catch(error){next(error);}};
exports.preview=handler(req=>service.preview(prisma,req.body.importType,req.body.rows,req.user));
exports.stage=handler(req=>service.stage(prisma,req.body,req.user));
exports.apply=handler(req=>service.apply(prisma,req.params.key,req.user));
exports.report=handler(async req=>{
  const batch=await prisma.excelImportBatch.findFirst({where:{OR:[{id:req.params.key},{batchNumber:req.params.key}]},include:{rows:{orderBy:[{sheetName:'asc'},{rowNumber:'asc'}]}}});
  if(!batch?.metadata?.legacyMaster)throw Object.assign(new Error('Batch master tidak ditemukan.'),{statusCode:404});
  service.permission(req.user,batch.importType,'read');
  return{batchNumber:batch.batchNumber,fileName:batch.fileName,sourceChecksum:batch.sourceChecksum,status:batch.status,createdBy:batch.createdBy,approvedBy:batch.approvedBy,approvedAt:batch.approvedAt,reconciliation:batch.reconciliation,rows:batch.rows.map(row=>({sheetName:row.sheetName,rowNumber:row.rowNumber,source:row.sourceJson,mapping:row.mappedJson,status:row.status,error:row.errorMessage}))};
});
exports.template=(req,res,next)=>{
  try{
    const type=req.params.kind==='customer'?'CUSTOMER_MASTER':req.params.kind==='product'?'PRODUCT_MASTER':null;
    const c=service.config(type);service.permission(req.user,type,'read');
    const wb=XLSX.utils.book_new(),sheet=XLSX.utils.aoa_to_sheet([['Operation',...c.fields]]);
    sheet['!cols']=[{wch:16},...c.fields.map(()=>({wch:24}))];
    sheet.A1.c=[{a:'ERP',t:'CREATE untuk kode baru; UPDATE untuk kode yang sudah ada. Kolom kosong tidak menghapus nilai lama. Produk khusus FG. Jangan ubah kode stabil; isi kode UOM/Customer yang sudah ada.'}];
    XLSX.utils.book_append_sheet(wb,sheet,req.params.kind==='customer'?'Customers':'Products');
    res.set({'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','Content-Disposition':`attachment; filename="Template-Master-${req.params.kind}.xlsx"`,'Cache-Control':'private, no-store'});
    res.send(XLSX.write(wb,{type:'buffer',bookType:'xlsx'}));
  }catch(error){next(error);}
};
