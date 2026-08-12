"use strict";

const { prisma } = require("../../index");
const { createEffectiveVersion } = require("../../services/pricing/effectivePriceService");
const text = (value) => String(value ?? "").trim() || null;
const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const date = (value) => { const parsed = value ? new Date(value) : null; return parsed && !Number.isNaN(parsed.getTime()) ? parsed : null; };
const data = (body, actor) => ({ customerCode: text(body.customerCode), partId: text(body.partId), currencyCode: text(body.currencyCode) || "IDR", unitPrice: number(body.unitPrice), effectiveFrom: date(body.effectiveFrom), effectiveUntil: date(body.effectiveUntil), isActive: body.isActive !== false && body.isActive !== "false", notes: text(body.notes), ...(actor ? { createdBy: actor } : {}) });

async function decorate(rows) {
  const list = Array.isArray(rows) ? rows : [rows];
  const [parts, customers] = await Promise.all([
    prisma.part.findMany({ where: { id: { in: [...new Set(list.map((row) => row.partId))] } }, select: { id: true, partCode: true, partNumber: true, partName: true } }),
    prisma.customer.findMany({ where: { customerCode: { in: [...new Set(list.map((row) => row.customerCode))] } }, select: { customerCode: true, customerName: true } }),
  ]);
  const partById = new Map(parts.map((row) => [row.id,row])), customerByCode = new Map(customers.map((row) => [row.customerCode,row]));
  const result = list.map((row) => ({ ...row, part: partById.get(row.partId) || null, customer: customerByCode.get(row.customerCode) || null }));
  return Array.isArray(rows) ? result : result[0];
}

exports.list = async (req,res,next) => { try { const q=text(req.query.q),page=Math.max(number(req.query.page)||1,1),limit=Math.min(Math.max(number(req.query.limit)||20,1),500),where={isDeleted:false,...(q?{OR:[{customerCode:{contains:q,mode:"insensitive"}},{currencyCode:{contains:q,mode:"insensitive"}},{notes:{contains:q,mode:"insensitive"}}]}:{})}; const [items,total]=await Promise.all([prisma.customerPartPrice.findMany({where,orderBy:[{effectiveFrom:"desc"},{createdAt:"desc"}],skip:(page-1)*limit,take:limit}),prisma.customerPartPrice.count({where})]);res.json({items:await decorate(items),total,page,limit}) } catch(error){next(error)} };
exports.get = async (req,res,next) => { try { const row=await prisma.customerPartPrice.findFirst({where:{id:req.params.id,isDeleted:false}});if(!row)return res.status(404).json({message:"Master Price Customer tidak ditemukan."});res.json(await decorate(row)) }catch(error){next(error)} };
exports.create = async (req,res,next) => { try { const payload=data(req.body,req.user?.username||req.user?.email||"system");if(!payload.customerCode||!payload.partId||!payload.effectiveFrom||payload.unitPrice<0)return res.status(400).json({message:"Customer, part, effective date, dan unit price wajib valid."});if(payload.effectiveUntil&&payload.effectiveUntil<payload.effectiveFrom)return res.status(400).json({message:"Effective until tidak boleh sebelum effective from."});const saved=await prisma.$transaction((tx)=>createEffectiveVersion(tx,{model:"customerPartPrice",data:{...payload,isDeleted:false},scopeWhere:{customerCode:payload.customerCode,partId:payload.partId,currencyCode:payload.currencyCode}}));res.status(201).json(await decorate(saved)) }catch(error){next(error)} };
exports.update = async (req,res,next) => { try { const payload=data(req.body);delete payload.createdBy;if(!payload.customerCode||!payload.partId||!payload.effectiveFrom||payload.unitPrice<0)return res.status(400).json({message:"Customer, part, effective date, dan unit price wajib valid."});res.json(await decorate(await prisma.customerPartPrice.update({where:{id:req.params.id},data:payload}))) }catch(error){next(error)} };
exports.remove = async (req,res,next) => { try { await prisma.customerPartPrice.update({where:{id:req.params.id},data:{isDeleted:true,isActive:false}});res.json({ok:true}) }catch(error){next(error)} };
