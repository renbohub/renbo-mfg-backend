const { userHasPermission } = require('./ai/permissionEvaluator');
const DASHBOARD_RESOURCES = {
  sales: ['salesOrder'], outgoing: ['salesOrder'],
  purchasing: ['purchaseOrder'], incoming: ['purchaseOrder'],
  inventory: ['stockBalances'], production: ['dailyProductionSchedules', 'productionLogs'],
  'planning-ppic': ['monthlyProductionPlan', 'productionLogs'], 'manufacturing-bom': ['mbom'],
  system: ['salesOrder', 'dailyProductionSchedules', 'productionLogs', 'purchaseOrder', 'stockBalances'],
};
function canReadDashboard(user, module) {
  const resources = DASHBOARD_RESOURCES[module];
  const sourceModule = { salesOrder: 'sales', purchaseOrder: 'purchasing', stockBalances: 'inventory', dailyProductionSchedules: 'production', productionLogs: 'production', monthlyProductionPlan: 'planning-ppic', mbom: 'manufacturing-bom' };
  return !!resources && resources.every(resourceCode => userHasPermission(user, { resourceCode, action: 'read' }, { moduleCode: sourceModule[resourceCode], pageCode: 'dashboard' }));
}
function dashboardAccess(req, res, next) {
  const module = String(req.params.module || '').toLowerCase();
  if (!DASHBOARD_RESOURCES[module]) return res.status(404).json({ message: 'Dashboard tidak ditemukan.' });
  if (!canReadDashboard(req.user, module)) return res.status(403).json({ message: 'Role Anda tidak memiliki akses ke data dashboard ini.' });
  next();
}
module.exports = { DASHBOARD_RESOURCES, canReadDashboard, dashboardAccess };
