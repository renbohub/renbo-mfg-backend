const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { prisma } = require('../../index');
const service = require('../../services/pricing/vendorBomPriceService');
const { userHasPermission } = require('../../services/ai/permissionEvaluator');
const { resolvePageContext } = require('../../utils/pageContext');
const { quotationUploadConfig } = require('../../middleware/uploads');
const run = fn => (req,res,next)=>Promise.resolve(fn(req,res)).catch(next);
exports.fgs=run(async(req,res)=>res.json(await service.fgList(prisma,req.query)));
exports.fg=run(async(req,res)=>res.json(await service.fgList(prisma,{key:req.params.key})));
exports.context=run(async(req,res)=>res.json(await service.context(prisma,req.params.id)));
exports.preview=run(async(req,res)=>{const {_groups,...view}=await service.preview(prisma,req.body);res.json(view);});
exports.save=run(async(req,res)=>{
  const files=req.files?.quotationFiles||[], createdPaths=[];
  const uploadDir=path.resolve(quotationUploadConfig.uploadDir);
  const permittedPath=p=>path.dirname(path.resolve(p))===uploadDir;
  try {
    for(const f of files) {if(!permittedPath(f.path)) throw new Error('Lokasi file quotation tidak valid.');createdPaths.push(f.path);}
    const input=typeof req.body.payload==='string'?JSON.parse(req.body.payload):req.body;
    const has=action=>userHasPermission(req.user,{resourceCode:'vendorPriceLists',action},resolvePageContext(req));
    const result=await service.save(prisma,input,{canCreate:has('create'),canUpdate:has('update'),actor:req.user.username||req.user.email||req.user.id,
      filesForGroup:async index=>{
        const records=[];
        for(const f of files) {
          let filename=f.filename;
          if(index>0) {
            filename=`BOM-${randomUUID()}${path.extname(f.filename)}`;
            const target=path.join(uploadDir,filename); if(!permittedPath(target)) throw new Error('Lokasi salinan quotation tidak valid.');
            await fs.copyFile(f.path,target);createdPaths.push(target);
          }
          records.push({fileName:f.originalname,fileUrl:`/uploads/quotations/${filename}`,fileType:f.mimetype,fileSize:f.size});
        }
        return records;
      },
    });
    res.json(result);
  } catch(error) {
    await Promise.all(createdPaths.filter(permittedPath).map(p=>fs.unlink(p).catch(()=>{})));
    if(error instanceof SyntaxError) {error.statusCode=400;error.message='Data form harga BOM tidak valid.';}
    throw error;
  }
});
