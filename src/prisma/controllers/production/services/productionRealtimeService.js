const emitManufacturingOrderUpdate = (mo, action = "sync", actionBy = "system") => {
  try {
    const io = global.io;
    if (!io || !mo?.moNumber) return;

    io.emit("production:manufacturing-order", {
      moNumber: mo.moNumber,
      status: mo.status,
      action,
      actionBy,
      updatedAt: mo.updatedAt,
      isDeleted: mo.isDeleted,
      qtyProduced: mo.qtyProduced,
      qtyGood: mo.qtyGood,
      qtyReject: mo.qtyReject,
      actualStartDate: mo.actualStartDate,
      actualEndDate: mo.actualEndDate,
      item: mo,
    });
  } catch (err) {
    console.error("Failed to emit Manufacturing Order update:", err);
  }
};

const emitWorkOrderUpdate = (wo, action = "sync", actionBy = "system") => {
  try {
    const io = global.io;
    if (!io || !wo?.woNumber) return;

    io.emit("production:work-order", {
      woNumber: wo.woNumber,
      moId: wo.moId,
      status: wo.status,
      action,
      actionBy,
      updatedAt: wo.updatedAt,
      isDeleted: wo.isDeleted,
      startTime: wo.startTime,
      endTime: wo.endTime,
      qtyProduced: wo.qtyProduced,
      qtyGood: wo.qtyGood,
      qtyReject: wo.qtyReject,
      item: wo,
    });
  } catch (err) {
    console.error("Failed to emit Work Order update:", err);
  }
};

const emitManufacturingOrderBulkUpdate = (items = [], action = "sync", actionBy = "system") => {
  for (const item of items) {
    emitManufacturingOrderUpdate(item, action, actionBy);
  }
};

const emitWorkOrderBulkUpdate = (items = [], action = "sync", actionBy = "system") => {
  for (const item of items) {
    emitWorkOrderUpdate(item, action, actionBy);
  }
};

module.exports = {
  emitManufacturingOrderUpdate,
  emitManufacturingOrderBulkUpdate,
  emitWorkOrderUpdate,
  emitWorkOrderBulkUpdate,
};
