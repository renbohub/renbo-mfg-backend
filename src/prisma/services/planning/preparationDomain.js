"use strict";
const { randomUUID } = require('node:crypto');
const fail = message => { throw Object.assign(new Error(message), { statusCode: 400 }); };
function monthKey(value) { if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(value || '')) fail('Periode harus YYYY-MM (2000–2099).'); return value; }
function daysInMonth(month) { monthKey(month); return new Date(Date.UTC(+month.slice(0,4), +month.slice(5), 0)).getUTCDate(); }
const text = (value, max=180) => String(value ?? '').trim().slice(0,max);
function number(value, label) { if (value === '' || value == null) return 0; if (!['number','string'].includes(typeof value) || !Number.isFinite(Number(value)) || Number(value)<0 || Number(value)>1e12) fail(`${label}: masukkan angka 0 sampai 1 triliun.`); return Number(value); }
const key = (code, unit, owner='') => JSON.stringify([text(code), text(unit).toUpperCase(), text(owner)]);
function normalize(input) {
  const month=monthKey(input?.month), count=daysInMonth(month), name=text(input.name,100);
  if (!name) fail('Nama skenario wajib diisi.');
  const result={month,name,delivery:[],production:[],material:[],sourceAt:text(input.sourceAt),sourceNotes:Array.isArray(input.sourceNotes)?input.sourceNotes.map(x=>text(x,300)).slice(0,100):[]};
  for (const sheet of ['delivery','production','material']) {
    if (!Array.isArray(input[sheet]) || input[sheet].length>2000) fail(`${sheet}: maksimal 2.000 baris.`);
    const ids=new Set(), materials=new Set();
    result[sheet]=input[sheet].map((raw,index)=>{
      if (!raw || typeof raw !== 'object') fail(`${sheet} baris ${index+1} tidak valid.`);
      const row={id:text(raw.id,100)||randomUUID(),partCode:text(raw.partCode),partName:text(raw.partName),uomCode:text(raw.uomCode,20).toUpperCase(),days:{}};
      if (!row.partCode || !row.uomCode) fail(`${sheet} baris ${index+1}: kode part/material dan satuan wajib diisi.`);
      if(ids.has(row.id)) fail(`${sheet}: identitas baris duplikat.`);ids.add(row.id);
      for(const [date,value] of Object.entries(raw.days||{})) {
        if(!new RegExp('^'+month+'-\\d{2}$').test(date) || +date.slice(-2)<1 || +date.slice(-2)>count) fail(`${sheet}: tanggal ${date} di luar periode.`);
        const qty=number(value,`${sheet} ${row.partCode} ${date}`);if(qty)row.days[date]=qty;
      }
      if(sheet==='delivery')row.customerCode=text(raw.customerCode);
      if(sheet==='production'){row.resource=text(raw.resource);row.shift=text(raw.shift,30);row.materialOffsetDays=number(raw.materialOffsetDays,'Offset material');if(!Number.isInteger(row.materialOffsetDays)||row.materialOffsetDays>90)fail('Offset material harus 0–90 hari bulat.');}
      if(sheet==='material'){
        if(raw.supplyType&&!['CUSTOMER_SUPPLIED','SUPPLIER_PURCHASE'].includes(raw.supplyType))fail('Jenis pasokan material tidak valid.');
        if(raw.supplyType!=='CUSTOMER_SUPPLIED'&&text(raw.customerCode))fail('Pilih jenis pasokan Milik customer jika pemilik customer diisi.');
        row.supplyType=raw.supplyType==='CUSTOMER_SUPPLIED'?'CUSTOMER_SUPPLIED':'SUPPLIER_PURCHASE';row.customerCode=row.supplyType==='CUSTOMER_SUPPLIED'?text(raw.customerCode):'';
        if(row.supplyType==='CUSTOMER_SUPPLIED'&&!row.customerCode)fail('Material customer wajib memiliki kode pemilik.');
        row.openingStock=number(raw.openingStock,'Stok awal material');
        const identity=key(row.partCode,row.uomCode,row.customerCode);if(materials.has(identity))fail('Material, satuan, dan pemilik yang sama harus digabung menjadi satu baris.');materials.add(identity);
      }
      return row;
    });
  }
  return result;
}
function ledger(month, opening, receipts, requirements) {
  let balance=opening, maxShortage=0, firstShortageDate=null;
  const daily=[];
  for(let d=1;d<=daysInMonth(month);d++){
    const date=month+'-'+String(d).padStart(2,'0'),received=receipts[date]||0,required=requirements[date]||0;
    balance+=received-required;
    if(balance < -1e-8){maxShortage=Math.max(maxShortage,-balance);firstShortageDate ||= date;}
    if(received||required)daily.push({date,received,required,balance});
  }
  return {openingStock:opening,closingBalance:balance,maxShortage,firstShortageDate,daily};
}
function deliveryBalance(workbook) {
  const groups=new Map();
  for(const [sheet,field] of [['delivery','requirements'],['production','receipts']])for(const row of workbook[sheet]){
    const id=key(row.partCode,row.uomCode);if(!groups.has(id))groups.set(id,{partCode:row.partCode,uomCode:row.uomCode,receipts:{},requirements:{}});
    const group=groups.get(id);for(const [date,qty]of Object.entries(row.days))group[field][date]=(group[field][date]||0)+qty;
  }
  return [...groups.values()].map(row=>({partCode:row.partCode,uomCode:row.uomCode,...ledger(workbook.month,0,row.receipts,row.requirements)}));
}
module.exports={monthKey,daysInMonth,normalize,key,ledger,deliveryBalance};
