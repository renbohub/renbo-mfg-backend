const { prisma } = require("../../index");

const total = (rows, field) => rows.reduce((sum, row) => sum + Number(row[field] || 0), 0);

exports.list = async (req, res, next) => {
  try {
    const rows = await prisma.salesOrderHeader.findMany({
      where: { isDeleted: false, status: { notIn: ["Cancelled", "Completed"] } },
      include: {
        customer: { select: { customerCode: true, customerName: true } },
        details: { where: { isDeleted: false }, select: { partCode: true, qty: true, qtyDelivered: true } },
        deliverySchedules: { where: { isDeleted: false }, select: { scheduleNumber: true, status: true, plannedDate: true, actualDate: true } },
      },
      orderBy: { deliveryDate: "asc" }, take: Math.min(Number(req.query.limit || 100), 500),
    });
    const now = new Date();
    const items = rows.map((so) => {
      const orderedQty = total(so.details, "qty");
      const deliveredQty = total(so.details, "qtyDelivered");
      const outstandingQty = Math.max(orderedQty - deliveredQty, 0);
      const overdue = so.deliveryDate && new Date(so.deliveryDate) < now && outstandingQty > 0;
      const scheduleRisk = so.deliverySchedules.some((item) => ["Cancelled", "Failed"].includes(item.status));
      const risk = overdue ? "CRITICAL" : scheduleRisk ? "RISK" : outstandingQty > 0 ? "WARNING" : "HEALTHY";
      return { soNumber: so.soNumber, customer: so.customer, deliveryDate: so.deliveryDate, status: so.status, orderedQty, deliveredQty, outstandingQty, parts: [...new Set(so.details.map((detail) => detail.partCode).filter(Boolean))], deliverySchedules: so.deliverySchedules, demandStatus: "CONFIRMED", deliveryStatus: outstandingQty === 0 ? "COMPLETED" : "OPEN", risk };
    });
    res.json({ items, summary: { total: items.length, critical: items.filter((item) => item.risk === "CRITICAL").length, risk: items.filter((item) => item.risk === "RISK").length, warning: items.filter((item) => item.risk === "WARNING").length } });
  } catch (error) { next(error); }
};
