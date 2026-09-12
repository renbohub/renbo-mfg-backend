"use strict";
const { isDiscreteUom } = require("../../utils/uomQuantity");
function roundProductionAfterBuffer(value, uomCode) {
  const qty = Math.max(Number(value) || 0, 0);
  const discrete = isDiscreteUom(uomCode) || /^(EA|UNIT|SET)$/i.test(String(uomCode || ""));
  const roundedQty = discrete && qty > 0 ? Math.max(1000, Math.ceil((qty - 1e-6) / 1000) * 1000) : qty;
  return { rawQty: qty, roundedQty, roundingQty: Math.round((roundedQty - qty) * 1e6) / 1e6, multiple: discrete ? 1000 : null };
}
module.exports = { roundProductionAfterBuffer };
