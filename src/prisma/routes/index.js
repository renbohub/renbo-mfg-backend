const express = require("express");
const { auth } = require("../middleware/auth");
const { licenseGuard } = require("../middleware/license");
const { getLicenseStatus, refreshLicense } = require("../services/licenseService");
const { strictIdentifierMiddleware } = require("../utils/strictIdentifiers");

// Import routes
const authRouter = require("./auth");
const userRouter = require("./user");
const logsRouter = require("./logs");
const pageContextRouter = require("./pageContext");
const customersRouter = require("./master-data/customers");
const suppliersRouter = require("./master-data/suppliers");
const vendorsRouter = require("./master-data/vendors");
const mainBusinessesRouter = require("./master-data/main-businesses");
const vendorProcessesRouter = require("./master-data/vendor-processes");
const vendorPriceListsRouter = require("./master-data/vendor-price-lists");
const uomRouter = require("./master-data/uom");
const currenciesRouter = require("./master-data/currencies");
const partsRouter = require("./master-data/parts");
const partPriceListsRouter = require("./master-data/part-price-lists");
const partAttachmentsRouter = require("./master-data/partAttachments");
const materialsRouter = require("./master-data/materials");
const materialPriceListsRouter = require("./master-data/material-price-lists");
const materialSubstancesRouter = require("./master-data/material-substances");
const materialDensitiesRouter = require("./master-data/material-densities");
const materialGradesRouter = require("./master-data/material-grades");
const materialFormsRouter = require("./master-data/material-forms");
const processesRouter = require("./master-data/processes");
const paymentTermsRouter = require("./master-data/payment-terms");
const priceListRouter = require("./master-data/price-list");
const customerPartPricesRouter = require("./master-data/customer-part-prices");
const diesRouter = require("./master-data/dies");
const diesPartsRouter = require("./master-data/dies-parts");
const diesMaintenanceRouter = require("./master-data/dies-maintenance");
const diesUsageRouter = require("./master-data/dies-usage");
const machinesRouter = require("./master-data/machines");
const machineCostRatesRouter = require("./master-data/machine-cost-rates");
const subProcessesRouter = require("./master-data/sub-processes");
const departmentsRouter = require("./master-data/departments");
const divisionsRouter = require("./master-data/divisions");
const employeesRouter = require("./master-data/employees");
const productsRouter = require("./master-data/products");
const productPriceListsRouter = require("./master-data/product-price-lists");
const numberingRulesRouter = require("./master-data/numbering-rules");
const foundationRouter = require("./master-data/foundation");
const routingRouter = require("./engineering/routing");
const controlTowerRouter = require("./dashboard/control-tower");
const executiveDashboardRouter = require("./dashboard/executive");
const incomingTransactionRouter = require("./incoming/transactions");
const outgoingTransactionRouter = require("./outgoing/transactions");


const mbomRouter = require("./mbom/bom");


const warehousesRouter = require("./inventory/warehouses");
const racksRouter = require("./inventory/racks");
const lotsRouter = require("./inventory/lots");
const stockBalancesRouter = require("./inventory/stock-balances");
const stockReservationsRouter = require("./inventory/stock-reservations");
const stockMovementsRouter = require("./inventory/stock-movements");
const stockOpnameRouter = require("./inventory/stock-opname");


const purchaseOrderRouter = require("./purchasing/purchase-orders");
const purchaseRequisitionsRouter = require("./purchasing/purchase-requisitions");
const purchaseSuggestionsRouter = require("./purchasing/purchase-suggestions");
const purchaseInvoicesRouter = require("./purchasing/purchase-invoices");
const {
  goodsReceiptsRouter,
  incomingInspectionsRouter,
  supplierDeliveriesRouter,
  putawayRouter,
  deliveryOrdersRouter,
  deliverySchedulesRouter,
  pickingPackingRouter,
  shipmentsRouter,
} = require("./supply-chain-read");
const quotationsRouter = require("./sales/quotations");
const salesOrdersRouter = require("./sales/sales-orders");
const forecastsRouter = require("./planning/forecasts");
const mpsRouter = require("./planning/mps");
const mrpRouter = require("./planning/mrp");
const monthlyProductionPlansRouter = require("./planning/monthly-production-plans");
const reportingRouter = require("./reporting");
const capacityPlanningRouter = require("./planning/capacity-planning");
const demandPlanningRouter = require("./planning/demand-planning");
const planningExecutionCockpitRouter = require("./planning/execution-cockpit");

const manufacturingOrdersRouter = require("./production/manufacturing-orders");
const workOrdersRouter = require("./production/work-orders");
const productionLogsRouter = require("./production/production-logs");
const downtimeLogsRouter = require("./production/downtime-logs");
const qualityInspectionsRouter = require("./production/quality-inspections");
const ngDispositionsRouter = require("./production/ng-dispositions");
const materialIssuesRouter = require("./production/material-issues");
const productionReportsRouter = require("./production/production-reports");
const wipRouter = require("./production/wip");
const dailyProductionSchedulesRouter = require("./production/daily-production-schedules");
const vendorProcessOrdersRouter = require("./production/vendor-process-orders");

const notificationsRouter = require("./notifications");
const exportRouter = require("./export");
const systemSettingsRouter = require("./system-settings");
const rolesRouter = require("./system/roles");
const approvalRulesRouter = require("./system/approval-rules");
const masterFormulasRouter = require("./system/master-formulas");
const excelImportsRouter = require("./system/excel-imports");
const approvalsRouter = require("./system/approvals");
const maintenanceRouter = require("./system/maintenance");
const tableDocumentsRouter = require("./system/table-documents");

const BASE_PATH = "/api";

function registerRoutes(app) {
  const api = express.Router();

  api.use(strictIdentifierMiddleware);

  // Health check (no auth)
  api.get("/health", (_req, res) => {
    res.json({ ok: true, ts: new Date().toISOString() });
  });

  api.get("/license/status", (_req, res) => {
    res.json({ ok: true, license: getLicenseStatus() });
  });

  api.post("/license/refresh", async (_req, res, next) => {
    try {
      const license = await refreshLicense({ force: true });
      res.json({ ok: license.valid, license: getLicenseStatus() });
    } catch (err) {
      next(err);
    }
  });

  api.use(licenseGuard());

  // Auth routes (no auth required)
  api.use("/auth", authRouter);

  // Protected routes (require auth)
  api.use("/users", auth, userRouter);
  api.use("/logs", auth, logsRouter);
  api.use("/page-context", auth, pageContextRouter);
  api.use("/system/roles", auth, rolesRouter);
  api.use("/system/approval-rules", auth, approvalRulesRouter);
  api.use("/system/master-formulas", auth, masterFormulasRouter);
  api.use("/system/excel-imports", auth, excelImportsRouter);
  api.use("/approvals", auth, approvalsRouter);
  api.use("/maintenance", auth, maintenanceRouter);
  api.use("/system/table-documents", auth, tableDocumentsRouter);

  // Master Data routes
  api.use("/master-data/customers", auth, customersRouter);
  api.use("/master-data/suppliers", auth, suppliersRouter);
  api.use("/master-data/vendors", auth, vendorsRouter);
  api.use("/master-data/main-businesses", auth, mainBusinessesRouter);
  api.use("/master-data/vendor-processes", auth, vendorProcessesRouter);
  api.use("/master-data/vendor-price-lists", auth, vendorPriceListsRouter);
  api.use("/master-data/uom", auth, uomRouter);
  api.use("/master-data/currencies", auth, currenciesRouter);
  api.use("/master-data/parts", auth, partsRouter);
  api.use("/master-data/part-price-lists", auth, partPriceListsRouter);
  api.use("/master-data/part-attachments", auth, partAttachmentsRouter);
  api.use("/master-data/materials", auth, materialsRouter);
  api.use("/master-data/material-price-lists", auth, materialPriceListsRouter);
  api.use("/master-data/material-substances", auth, materialSubstancesRouter);
  api.use("/master-data/material-densities", auth, materialDensitiesRouter);
  api.use("/master-data/material-grades", auth, materialGradesRouter);
  api.use("/master-data/material-forms", auth, materialFormsRouter);
  api.use("/master-data/processes", auth, processesRouter);
  api.use("/master-data/payment-terms", auth, paymentTermsRouter);
  api.use("/master-data/price-list", auth, priceListRouter);
  api.use("/master-data/customer-part-prices", auth, customerPartPricesRouter);
  api.use("/master-data/dies", auth, diesRouter);
  api.use("/master-data/dies-part", auth, diesPartsRouter);
  api.use("/master-data/dies-maintenance", auth, diesMaintenanceRouter);
  api.use("/master-data/dies-usage", auth, diesUsageRouter);
  api.use("/master-data/machines", auth, machinesRouter);
  api.use("/master-data/machine-cost-rates", auth, machineCostRatesRouter);
  api.use("/master-data/sub-processes", auth, subProcessesRouter);
  api.use("/master-data/departments", auth, departmentsRouter);
  api.use("/master-data/divisions", auth, divisionsRouter);
  api.use("/master-data/employees", auth, employeesRouter);
  api.use("/master-data/products", auth, productsRouter);
  api.use("/master-data/product-price-lists", auth, productPriceListsRouter);
  api.use("/master-data/numbering-rules", auth, numberingRulesRouter);
  api.use("/master-data/foundation", auth, foundationRouter);
  api.use("/engineering", auth, routingRouter);
  api.use("/dashboard/control-tower", auth, controlTowerRouter);
  api.use("/dashboard/executive", auth, executiveDashboardRouter);
  api.use("/incoming", auth, incomingTransactionRouter);
  api.use("/outgoing", auth, outgoingTransactionRouter);

  // Engineering (EBOM) routes

  // Manufacturing (MBOM) routes
  api.use("/mbom/mbom", auth, mbomRouter);

  // Sales routes
  api.use("/sales/quotations", auth, quotationsRouter);
  api.use("/sales/sales-orders", auth, salesOrdersRouter);

  // Inventory routes
  api.use("/inventory/warehouses", auth, warehousesRouter);
  api.use("/inventory/racks", auth, racksRouter);
  api.use("/inventory/lots", auth, lotsRouter);
  api.use("/inventory/stock-balances", auth, stockBalancesRouter);
  api.use("/inventory/stock-reservations", auth, stockReservationsRouter);
  api.use("/inventory/stock-movements", auth, stockMovementsRouter);
  api.use("/inventory/stock-opname", auth, stockOpnameRouter);

  // Planning routes
  api.use("/planning/forecasts", auth, forecastsRouter);
  api.use("/planning/mps", auth, mpsRouter);
  api.use("/planning/mrp", auth, mrpRouter);
  api.use("/planning/monthly-production-plans", auth, monthlyProductionPlansRouter);
  api.use("/reports", auth, reportingRouter);
  api.use("/planning/capacity-planning", auth, capacityPlanningRouter);
  api.use("/planning/demand-planning", auth, demandPlanningRouter);
  api.use("/planning/execution-cockpit", auth, planningExecutionCockpitRouter);

  // Purchasing routes
  api.use("/purchasing/purchase-order", auth, purchaseOrderRouter);
  api.use("/purchasing/purchase-requisitions", auth, purchaseRequisitionsRouter);
  api.use("/purchasing/purchase-suggestions", auth, purchaseSuggestionsRouter);
  api.use("/purchasing/purchase-invoices", auth, purchaseInvoicesRouter);

  // Incoming routes
  api.use("/incoming/goods-receipts", auth, goodsReceiptsRouter);
  api.use("/incoming/incoming-inspections", auth, incomingInspectionsRouter);
  api.use("/incoming/supplier-deliveries", auth, supplierDeliveriesRouter);
  api.use("/incoming/putaway", auth, putawayRouter);

  // Outgoing routes
  api.use("/outgoing/delivery-orders", auth, deliveryOrdersRouter);
  api.use("/outgoing/delivery-schedules", auth, deliverySchedulesRouter);
  api.use("/outgoing/picking-packing", auth, pickingPackingRouter);
  api.use("/outgoing/shipments", auth, shipmentsRouter);

  // Production routes
  api.use("/production/manufacturing-orders", auth, manufacturingOrdersRouter);
  api.use("/production/work-orders", auth, workOrdersRouter);
  api.use("/production/production-logs", auth, productionLogsRouter);
  api.use("/production/downtime-logs", auth, downtimeLogsRouter);
  api.use("/production/quality-inspections", auth, qualityInspectionsRouter);
  api.use("/production/ng-dispositions", auth, ngDispositionsRouter);
  api.use("/production/material-issues", auth, materialIssuesRouter);
  api.use("/production/production-reports", auth, productionReportsRouter);
  api.use("/production/wip", auth, wipRouter);
  api.use("/production/daily-production-schedules", auth, dailyProductionSchedulesRouter);
  api.use("/production/vendor-process-orders", auth, vendorProcessOrdersRouter);

  // Notification routes
  api.use("/notifications", auth, notificationsRouter);

  // Dashboard global

  // Export integration routes (token-based, without user login)
  api.use("/export", exportRouter);

  // System settings routes
  api.use("/system/settings", auth, systemSettingsRouter);

  // Maintenance routes

  // Mount api router
  app.use(BASE_PATH, api);

  console.log("✅ Routes registered at", BASE_PATH);
}

module.exports = registerRoutes;
