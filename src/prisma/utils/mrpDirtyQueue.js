async function queueDirtyItem(tx, data) {
  const itemId = data?.itemId || null;
  const rawReason = String(data?.reason || "").trim().toLowerCase();
  const reason = {
    so: "sales-order-demand",
    forecast: "forecast-demand",
    bom: "bom-change",
    stock: "stock-change",
    po: "purchase-order-supply",
  }[rawReason] || rawReason;
  const sourceNumber = data?.sourceNumber || null;
  if (!itemId || !reason) return null;

  const existing = await tx.mRPDirtyItem.findFirst({
    where: {
      itemId,
      reason,
      sourceNumber,
      status: { in: ["Pending", "Processing"] },
    },
    orderBy: { createdAt: "desc" },
  });
  if (existing) {
    return tx.mRPDirtyItem.update({
      where: { id: existing.id },
      data: {
        status: "Pending",
        processedAt: null,
        notes: data.notes || null,
      },
    });
  }
  return tx.mRPDirtyItem.create({
    data: {
      itemId,
      reason,
      sourceNumber,
      notes: data.notes || null,
      status: "Pending",
    },
  });
}

async function queueDirtyPartCodes(tx, partCodes, data = {}) {
  const codes = [...new Set((partCodes || []).filter(Boolean).map(String))];
  if (!codes.length) return [];
  const parts = await tx.part.findMany({
    where: { partCode: { in: codes }, isDeleted: false },
    select: { id: true, partCode: true },
  });
  const queued = [];
  for (const part of parts) {
    queued.push(await queueDirtyItem(tx, {
      ...data,
      itemId: part.id,
      notes: data.notes || `${data.reason || "CHANGE"} pada ${part.partCode}`,
    }));
  }
  return queued.filter(Boolean);
}

module.exports = { queueDirtyItem, queueDirtyPartCodes };
