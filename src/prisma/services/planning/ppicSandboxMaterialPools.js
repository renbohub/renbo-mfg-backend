"use strict";

// All quantities here have already been converted to the requirement's UOM.
// WIP/FG coverage belongs to the BOM explosion, never to a second raw pool.
function physicalStock(rows, uom) {
  const warehouse = rows.filter(row => row.supplyClass === "WAREHOUSE_MATERIAL");
  return { uom: String(uom || "").toLowerCase(),
    openingQty: warehouse.reduce((sum, row) => sum + Math.max(0, Math.min(Number(row.qtyAvailable || 0), Number(row.qtyOnHand || 0) - Number(row.qtyReserved || 0) - Number(row.qtyQC || 0))), 0),
    excludedWipQty: rows.filter(row => row.supplyClass === "WIP_EQUIVALENT").reduce((sum, row) => sum + Math.max(0, Number(row.qtyOnHand || 0)), 0),
  };
}

function capture(requirements, events, physicalByKey, uomByPart) {
  const pools = new Map(), requirementPools = {};
  for (const row of requirements) {
    const uom = String(row.uomCode || uomByPart[row.partCode] || "").toLowerCase();
    const supplyKey = row._planningStockKey || row.partCode;
    const id = `${supplyKey}|UOM:${uom}`;
    requirementPools[row.id] = id;
    if (pools.has(id)) continue;
    const customer = row.materialSupplyType === "CUSTOMER_SUPPLIED";
    const physical = physicalByKey[row._physicalStockKey || supplyKey];
    const compatible = physical?.uom === uom;
    const selected = events.filter(event => event.supplyKey === supplyKey);
    const seen = new Set();
    pools.set(id, { id, uom, ownership: customer ? "CUSTOMER_SUPPLIED" : "COMPANY",
      owner: customer ? row.supplyCustomerCode || row.customerCode || "UNASSIGNED" : "COMPANY",
      openingQty: !customer && compatible ? physical.openingQty : 0,
      excludedGeneralStockQty: customer && compatible ? physical.openingQty : 0,
      excludedWipQty: compatible ? physical.excludedWipQty : 0,
      issues: !customer && !compatible ? ["Stok awal material belum tersedia dalam satuan kebutuhan; periksa konversi stok."] : [],
      supplies: selected.flatMap((event, index) => {
        const eventId = event.id || `${event.sourceType}:${event.sourceNumber}:${index}`;
        if (seen.has(eventId)) return [];
        seen.add(eventId);
        const availableDate = new Date(event.availableDate).toISOString().slice(0, 10);
        return [{ ...event, id: eventId, qty: Number(event.qty), availableDate,
          // Customer QC release is a timestamp; planned arrival dates use 08:00 plant time.
          availableAt: event.sourceType === "CUSTOMER_STOCK"
            ? new Date(new Date(event.availableDate).getTime() + 420 * 60000).toISOString().slice(0, 16)
            : `${availableDate}T08:00`,
        }];
      }),
    });
  }
  return { version: 1, pools: [...pools.values()], requirementPools };
}
module.exports = { capture, physicalStock };
