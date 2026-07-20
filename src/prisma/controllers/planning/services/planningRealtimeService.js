const emitPlanningMrpRunUpdate = (run, action = "sync", actionBy = "system") => {
  try {
    const io = global.io;
    if (!io || !run?.runNumber) return;

    io.emit("planning:mrp-run", {
      runNumber: run.runNumber,
      planNumber: run.planNumber,
      planRevision: run.planRevision,
      planScope: run.planScope,
      isCurrentPlan: run.isCurrentPlan,
      status: run.status,
      action,
      actionBy,
      updatedAt: run.updatedAt,
      totalRequirements: run.totalRequirements,
      totalPlannedOrders: run.totalPlannedOrders,
      executionTime: run.executionTime,
      errorMessage: run.errorMessage,
      item: run,
    });
  } catch (err) {
    console.error("Failed to emit MRP run update:", err);
  }
};

const emitPlanningPlannedOrderUpdate = (order, action = "sync", actionBy = "system") => {
  try {
    const io = global.io;
    if (!io || !order?.orderNumber) return;

    io.emit("planning:planned-order", {
      orderNumber: order.orderNumber,
      runNumber: order.runNumber,
      status: order.status,
      isDeleted: order.isDeleted,
      action,
      actionBy,
      updatedAt: order.updatedAt,
      item: order,
    });
  } catch (err) {
    console.error("Failed to emit Planned Order update:", err);
  }
};

const emitPlanningPlannedOrderBulkUpdate = (orders = [], action = "sync", actionBy = "system") => {
  for (const order of orders) {
    emitPlanningPlannedOrderUpdate(order, action, actionBy);
  }
};

module.exports = {
  emitPlanningMrpRunUpdate,
  emitPlanningPlannedOrderUpdate,
  emitPlanningPlannedOrderBulkUpdate,
};
