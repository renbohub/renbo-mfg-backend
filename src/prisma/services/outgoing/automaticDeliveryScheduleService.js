"use strict";

const crypto = require("crypto");

const AUTOMATIC_NOTES = "Dibuat otomatis dari Sales Order";

function buildScheduleNumber(now = new Date(), uuid = crypto.randomUUID()) {
  const date = now.toISOString().slice(0, 10).replace(/-/g, "");
  return `DS-${date}-${uuid.slice(0, 8).toUpperCase()}`;
}

function scheduleDetails(details = []) {
  return details.map((row, index) => ({
    soDetailId: row.id,
    lineNumber: row.lineNumber || index + 1,
    qty: Number(row.qty),
    notes: row.notes || null,
  }));
}

async function syncAutomaticDeliverySchedule(tx, so, options = {}) {
  const existing = await tx.deliverySchedule.findFirst({
    where: {
      soNumber: so.soNumber,
      status: "Scheduled",
      isDeleted: false,
      notes: AUTOMATIC_NOTES,
    },
  });
  const details = scheduleDetails(so.details);
  const sharedData = {
    plannedDate: so.deliveryDate || so.soDate || options.now || new Date(),
    deliveryAddress: so.shippingAddress || null,
    notes: AUTOMATIC_NOTES,
  };

  if (existing) {
    return tx.deliverySchedule.update({
      where: { id: existing.id },
      data: {
        ...sharedData,
        details: { deleteMany: {}, create: details },
      },
      include: { details: true },
    });
  }

  return tx.deliverySchedule.create({
    data: {
      scheduleNumber: buildScheduleNumber(options.now, options.uuid),
      soNumber: so.soNumber,
      ...sharedData,
      details: { create: details },
    },
    include: { details: true },
  });
}

module.exports = { AUTOMATIC_NOTES, buildScheduleNumber, syncAutomaticDeliverySchedule };
