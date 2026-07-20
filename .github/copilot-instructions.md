# Mitsutoyo ERP Backend - AI Coding Instructions

## Project Overview
ERP backend untuk manufacturing dengan Node.js/Express dan **PostgreSQL via Prisma ORM**. Mengelola master data, engineering (EBOM/MBOM), sales orders, inventory, planning, purchasing, dan produksi dengan arsitektur modular berbasis domain.

**Tech Stack**: Express 5.x, **Prisma 7.x** (PostgreSQL), JWT auth, Multer untuk uploads, Socket.io untuk real-time notifications, node-cron untuk scheduled jobs, Nodemon untuk development.

**Entry point**: `server.js` → `src/prisma/routes/registerRoutes(app)`  
**Database client**: `src/prisma/index.js` → exports `{ prisma, connectDatabase }`  
**Schema**: `prisma/schema.prisma`

## Architecture Patterns

### Modular Route Organization
Routing menggunakan domain-based grouping dengan base path `/api`:
```
// src/prisma/routes/index.js
/api/master-data/customers, /api/master-data/suppliers, /api/master-data/parts, dll
/api/ebom/ebom, /api/ebom/ebom-process, /api/ebom/ebom-costing, /api/ebom/ebom-report
/api/mbom/mbom, /api/mbom/mbom-process, /api/mbom/mbom-costing, /api/mbom/mbom-report
/api/sales/quotations, /api/sales/sales-orders, /api/sales/delivery-schedules
/api/inventory/warehouses, /api/inventory/stock-balances, /api/inventory/stock-movements
/api/planning/forecasts, /api/planning/mps, /api/planning/mrp
/api/purchasing/purchase-requisition, /api/purchasing/purchase-order, /api/purchasing/good-receipt
/api/production/manufacturing-orders, /api/production/work-orders
/api/notifications, /api/auth, /api/users, /api/logs
```
- Semua rute API **wajib** menggunakan middleware `auth` kecuali `/api/auth` dan `/api/health`
- Rute didaftarkan di `src/prisma/routes/index.js` menggunakan `registerRoutes(app)`

### Authentication & Authorization Pattern
**File**: `src/prisma/middleware/auth.js`

```javascript
const { prisma } = require("../index");

// Middleware auth: verify JWT token
exports.auth = async (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  const decoded = jwt.verify(token, JWT_SECRET);
  const user = await prisma.user.findUnique({ where: { id: decoded.id } });
  req.user = user;
  next();
};

// Middleware authorize: check resource-level permissions
exports.authorize = (resource, action = "read") => {
  return (req, res, next) => {
    if (req.user.isSuperAdmin) return next(); // bypass semua
    // Cek listMenu (JSON column di DB)
    const hasAccess = listMenu.some(entry => {
      // wildcard "*", empty actions = auto read, read granted jika punya create/update/delete
    });
  };
};
```

**Permission Model** di kolom `User.listMenu` (JSON):
```json
[
  { "resource": "customers", "actions": ["read", "create", "update"] },
  { "resource": "mbom", "actions": ["*"] }
]
```

**Rules**:
- `isSuperAdmin: true` → bypass semua permission checks
- Action `"read"` otomatis granted jika user punya `create/update/delete` pada resource tersebut
- Empty actions array → auto `read` access only
- Gunakan `authorize(resource, action)` setelah `auth` di routes yang butuh granular control

### Logging Middleware Pattern
**File**: `src/prisma/middleware/logger.js`

Middleware `logger` digunakan untuk audit trail semua CUD operations:
```javascript
const { logger } = require("../../middleware/logger");

// Wrap route dengan logger — untuk UPDATE, otomatis fetch old data dan attach ke req.oldData
router.patch("/:id", authorize("entity", "update"),
  logger("entity", "update", {
    modelName: "Entity",          // Prisma model name (untuk fetch old data sebelum update)
    includeOptions: { details: true } // Optional: relasi yang perlu di-include
  }),
  ctrl.update
);

router.post("/", authorize("entity", "create"), logger("entity", "create"), ctrl.create);
router.delete("/:id", authorize("entity", "delete"), logger("entity", "delete"), ctrl.remove);
router.patch("/bulk-remove", authorize("entity", "delete"), logger("entity", "bulk-remove", { modelName: "Entity" }), ctrl.bulkRemove);
```

### Standard Controller Pattern
**File**: `src/prisma/controllers/{domain}/{Entity}Controller.js`

Semua controllers mengikuti pola export function yang konsisten:
```javascript
const { prisma } = require("../../index");
const { buildSort } = require("../../utils/buildSort");
const { mapDoc } = require("../../utils/mapDoc");

exports.list = async (req, res, next) => {
  try {
    const { q, isDeleted, page = 1, limit = 20 } = req.query;
    const where = { isDeleted: isDeleted === "true" ? true : false };

    // Search: gunakan OR contains insensitive (BUKAN MongoDB text index)
    if (q) {
      where.OR = [
        { code: { contains: q, mode: "insensitive" } },
        { name: { contains: q, mode: "insensitive" } },
      ];
    }

    const orderBy = buildSort(req.query); // Returns Prisma orderBy object
    const skip = (Number(page) - 1) * Number(limit);

    const [items, total] = await Promise.all([
      prisma.entity.findMany({ where, orderBy, skip, take: Number(limit) }),
      prisma.entity.count({ where }),
    ]);

    res.json({ items: items.map(mapDoc), total, page: Number(page), limit: Number(limit) });
  } catch (e) { next(e); }
};

exports.get = async (req, res, next) => {
  try {
    const item = await prisma.entity.findUnique({ where: { id: req.params.id } });
    if (!item) return res.status(404).json({ message: "Data tidak ditemukan" });
    res.json(mapDoc(item));
  } catch (e) { next(e); }
};

exports.create = async (req, res, next) => {
  try {
    const item = await prisma.entity.create({ data: req.body });
    res.json(mapDoc(item));
  } catch (e) { next(e); }
};

exports.update = async (req, res, next) => {
  try {
    const item = await prisma.entity.update({ where: { id: req.params.id }, data: req.body });
    res.json(mapDoc(item));
  } catch (e) { next(e); }
};

exports.remove = async (req, res, next) => {
  try {
    // SOFT DELETE — jangan hard delete
    await prisma.entity.update({ where: { id: req.params.id }, data: { isDeleted: true } });
    res.json({ ok: true });
  } catch (e) { next(e); }
};

exports.bulkRemove = async (req, res, next) => {
  try {
    const { ids } = req.body;
    await prisma.entity.updateMany({ where: { id: { in: ids } }, data: { isDeleted: true } });
    res.json({ ok: true });
  } catch (e) { next(e); }
};

// VARIAN 1: bulkCreate dengan duplicate detection (untuk master data)
// Response: { message, success[], failed[], duplicates[], total }
exports.bulkCreate = async (req, res, next) => {
  try {
    const { entities } = req.body; // array dari entity
    if (!Array.isArray(entities) || entities.length === 0) {
      return res.status(400).json({ message: "entities array required" });
    }

    const results = { success: [], failed: [], duplicates: [], total: entities.length };

    for (const data of entities) {
      try {
        const existing = await prisma.entity.findUnique({ where: { code: data.code } });

        if (existing && !existing.isDeleted) {
          results.duplicates.push({ code: data.code, existingId: existing.id });
          continue;
        }

        let doc;
        if (existing && existing.isDeleted) {
          // Restore soft-deleted record
          doc = await prisma.entity.update({ where: { id: existing.id }, data: { ...data, isDeleted: false } });
        } else {
          doc = await prisma.entity.create({ data });
        }
        results.success.push(mapDoc(doc));
      } catch (error) {
        results.failed.push({ data, error: error.message });
      }
    }

    res.status(201).json({
      message: `Bulk create completed: ${results.success.length} success, ${results.failed.length} failed, ${results.duplicates.length} duplicates`,
      ...results,
    });
  } catch (e) { next(e); }
};

// VARIAN 2: bulkCreate dengan transaction (untuk data yang tidak butuh duplicate check)
// Response: { items[], total }
exports.bulkCreate = async (req, res, next) => {
  try {
    const { entities } = req.body;
    if (!Array.isArray(entities) || entities.length === 0) {
      return res.status(400).json({ message: "entities array required" });
    }

    const created = await prisma.$transaction(
      entities.map((data) => prisma.entity.create({ data }))
    );

    res.status(201).json({ items: created.map(mapDoc), total: created.length });
  } catch (e) { next(e); }
};
```

**Utilities** yang wajib digunakan:
- `buildSort(req.query, { allowed, fieldMap })` - Sorting dinamis, returns Prisma `orderBy` object
- `mapDoc(doc)` / `mapDocs(docs)` - Pass-through untuk Prisma (sudah plain object)
- `deepMerge(target, ...sources)` - Deep merge untuk nested update
- `notificationHelper.create(data)` - Kirim notifikasi real-time via Socket.io

### Prisma Schema Patterns
**File**: `prisma/schema.prisma`

```prisma
model Entity {
  id        String   @id @default(uuid())
  code      String   @unique
  name      String
  isDeleted Boolean  @default(false) @map("is_deleted")
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")

  @@index([isDeleted])
  @@map("tbl_entity")
}
```

**Setelah mengubah schema**, wajib jalankan:
```bash
npm run db:migrate   # npx prisma migrate dev
# ATAU untuk development cepat (tanpa migration file):
npm run db:push      # npx prisma db push
```

**Auto-generated Codes & Numbers** (dilakukan di controller, bukan trigger DB):

```javascript
// VARIAN 1: generateCode — sequence numerik dengan gap detection (master data)
// Digunakan di: customers, suppliers, vendors, parts, materials, employees, dll
// Response: { entityCode: "001" }
exports.generateCode = async (req, res, next) => {
  try {
    const all = await prisma.entity.findMany({ select: { code: true } });
    const nums = all.map(x => parseInt(x.code)).filter(n => !isNaN(n)).sort((a,b) => a - b);
    let next = 1;
    for (const n of nums) { if (n === next) next++; else break; }
    res.json({ entityCode: String(next).padStart(3, "0") });
  } catch (e) { next(e); }
};

// VARIAN 2: generateCode — prefix + last+1 (inventory, e.g., RACK-001)
// Digunakan di: racks, warehouses
// Response: { rackCode: "RACK-001" }
exports.generateCode = async (req, res, next) => {
  try {
    const last = await prisma.entity.findFirst({
      orderBy: { code: "desc" },
      select: { code: true },
    });
    let nextNumber = 1;
    if (last) {
      const match = last.code.match(/^PREFIX-(\d+)$/);
      if (match) nextNumber = parseInt(match[1]) + 1;
    }
    res.json({ entityCode: `PREFIX-${String(nextNumber).padStart(3, "0")}` });
  } catch (e) { next(e); }
};

// VARIAN 3: generateNumber — prefix tahun + sequence (planning/transaksional)
// Digunakan di: forecasts (FCT-YYYY-0001), mps, mrp
// Response: { forecastNumber: "FCT-2026-0001" }
exports.generateNumber = async (req, res, next) => {
  try {
    const year = new Date().getFullYear();
    const prefix = `ENTITY-${year}-`;
    const last = await prisma.entity.findFirst({
      where: { number: { startsWith: prefix } },
      orderBy: { number: "desc" },
      select: { number: true },
    });
    let nextSeq = 1;
    if (last) {
      const match = last.number.match(/-(\d+)$/);
      if (match) nextSeq = parseInt(match[1]) + 1;
    }
    res.json({ entityNumber: `${prefix}${String(nextSeq).padStart(4, "0")}` });
  } catch (e) { next(e); }
};

// VARIAN 4: generateNumber — dengan query param (e.g., PO by poType)
// Digunakan di: purchase-orders (poType menentukan format nomor)
// Response: { poNumber: "PO/CSM/001/MI/III/2026" }
exports.generateNumber = async (req, res, next) => {
  try {
    const { poType = "Other" } = req.query;
    const poNumber = await generatePONumber(poType);
    res.json({ poNumber });
  } catch (e) { next(e); }
};
```

**Get All Codes** (untuk dropdown / autocomplete tanpa pagination):

```javascript
// getAllCodes — return flat array of codes (master data)
// Digunakan di: customers, suppliers, vendors, materials, parts, uom, dll
// Response: ["001", "002", "003"]
exports.getAllCodes = async (req, res, next) => {
  try {
    const items = await prisma.entity.findMany({
      where: { isDeleted: false },
      select: { code: true },
      orderBy: { code: "asc" },
    });
    res.json(items.map(i => i.code));
  } catch (e) { next(e); }
};

// allCodes — return array of codes dengan optional filter (inventory)
// Digunakan di: racks, warehouses (support filter isActive, dll)
// Response: ["RACK-001", "RACK-002"]
exports.allCodes = async (req, res, next) => {
  try {
    const { isActive } = req.query;
    const where = { isDeleted: false };
    if (isActive !== undefined) where.isActive = isActive === "true";
    const items = await prisma.entity.findMany({
      where,
      select: { code: true },
      orderBy: { code: "asc" },
    });
    res.json(items.map(i => i.code));
  } catch (e) { next(e); }
};
```

**Soft Delete Pattern**:
- Semua models wajib memiliki field `isDeleted Boolean @default(false)`
- Query default: `where: { isDeleted: false }` kecuali user explicitly filter
- Soft delete via `updateMany({ where: { id: { in: ids } }, data: { isDeleted: true } })`

### Snapshot Pattern (Historical Data Integrity)
**File**: `src/prisma/utils/snapshotHelpers.js`

Digunakan untuk menyimpan data historis yang immutable (e.g., customer data saat SO dibuat):

```javascript
const { createSnapshot, createSnapshotFromRef } = require("../../utils/snapshotHelpers");

// Buat snapshot dari object langsung
const customer = await prisma.customer.findUnique({ where: { customerCode } });
const snapshot = createSnapshot(customer, ["customerName", "address", "contact"]);
// snapshot = { customerName: "...", address: "...", contact: "..." }

// Buat snapshot dari reference (dengan relasi)
const snapshot = await createSnapshotFromRef("customer", customerId, ["customerName"], { address: true });

// Assign snapshot ke data SO sebelum create
const soData = { ...req.body, ...snapshot };
```

**Kenapa Snapshot?** Jika customer data berubah, SO tetap memiliki data customer saat order dibuat. Field snapshot di-store langsung di tabel SO (bukan sebagai relasi).

### Real-time Notifications
**File**: `src/prisma/utils/notificationHelper.js`

Socket.io di-expose via `global.io`. Gunakan `notificationHelper` untuk create + broadcast:
```javascript
const notificationHelper = require("../../utils/notificationHelper");

await notificationHelper.create({
  type: "purchase_order",        // tipe untuk filter di frontend
  title: "PO Baru Dibuat",
  message: `PO ${poNumber} telah dibuat`,
  entityId: poNumber,
  entityUrl: `/purchasing/purchase-order/${poNumber}`,
  userId: null,                  // null = broadcast ke semua user
  metadata: { poNumber, totalAmount },
  createdBy: req.user.username,
});
```

## Development Workflows

### Starting the Application
```bash
# Terminal 1: Pastikan PostgreSQL running di port 5432

# Terminal 2: Start application
npm run start  # Menggunakan nodemon, auto-restart on file changes
```

### Database Connection & Seeding
**File**: `src/prisma/index.js`

- PostgreSQL URL dari `process.env.DATABASE_URL` (lihat `.env.example`)
- Menggunakan `@prisma/adapter-pg` dengan connection pooling via `pg.Pool`
- **Auto-seeding**: Setelah koneksi berhasil, `runSeeders()` otomatis dijalankan
- Seeder di `src/prisma/utils/seeder.js` — buat default admin, payment terms, UOM jika belum ada

### Database Migration Commands
```bash
npm run db:migrate         # Buat & apply migration baru (development)
npm run db:migrate:deploy  # Apply migration di production (tanpa prompt)
npm run db:migrate:reset   # Reset DB + re-apply semua migration
npm run db:push            # Sync schema tanpa migration file (prototyping)
npm run db:studio          # Buka Prisma Studio di browser
```

### API Response Format
**Success Response**:
```javascript
// List dengan pagination
res.json({ items: [...], total: 100, page: 1, limit: 20 });

// Single item
res.json({ id: "uuid", code: "...", name: "..." });

// Action success
res.json({ ok: true });
```

**Error Handling**:
- Controllers use `next(error)` untuk global error handler
- Global error handler di `server.js` tangkap semua error
- Format error: `{ message: "Deskripsi error" }` dengan HTTP status code (default 400)

### Common Query Parameters
Standardized across all list endpoints:
- `q` - Search query (OR contains insensitive di multiple field)
- `page` - Page number (default: 1)
- `limit` - Items per page (default: 20)
- `sort` - Format: `field:asc` atau `field:desc` (e.g., `sort=createdAt:desc`)
- `isDeleted` - Filter deleted items (`true`/`false`, default: `false`)

### Adding New Entity (Step-by-step)

**1. Define Model** (`prisma/schema.prisma`):
```prisma
model Entity {
  id        String   @id @default(uuid())
  code      String   @unique
  name      String
  isDeleted Boolean  @default(false) @map("is_deleted")
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")

  @@index([isDeleted])
  @@map("tbl_entity")
}
```
Kemudian jalankan `npm run db:migrate`.

**2. Create Controller** (`src/prisma/controllers/{domain}/EntityController.js`):
- Import `prisma` dari `../../index`
- Import `buildSort` dari `../../utils/buildSort`
- Import `mapDoc` dari `../../utils/mapDoc`
- Ikuti pola `list/get/create/update/remove/bulkRemove` di atas
- Search gunakan `where.OR = [{ field: { contains: q, mode: "insensitive" } }]`

**3. Create Routes** (`src/prisma/routes/{domain}/entities.js`):
```javascript
const router = require("express").Router();
const ctrl = require("../../controllers/{domain}/EntityController");
const { authorize } = require("../../middleware/auth");
const { logger } = require("../../middleware/logger");

// Helper routes di atas /:id agar tidak tertangkap sebagai ID
router.get("/generate-code", authorize("entities", "create"), ctrl.generateCode);   // atau generate-number
router.get("/all-codes", authorize("entities", "read"), ctrl.getAllCodes);           // atau allCodes
router.post("/bulk-create", authorize("entities", "create"), logger("entities", "bulk-create"), ctrl.bulkCreate);
router.patch("/bulk-remove", authorize("entities", "delete"), logger("entities", "bulk-remove", { modelName: "Entity" }), ctrl.bulkRemove);

// Standard CRUD
router.get("/", authorize("entities", "read"), ctrl.list);
router.get("/:id", authorize("entities", "read"), ctrl.get);
router.post("/", authorize("entities", "create"), logger("entities", "create"), ctrl.create);
router.patch("/:id", authorize("entities", "update"), logger("entities", "update", { modelName: "Entity" }), ctrl.update);
router.delete("/:id", authorize("entities", "delete"), logger("entities", "delete"), ctrl.remove);

module.exports = router;
```

**4. Register Routes** (`src/prisma/routes/index.js`):
```javascript
const entitiesRouter = require("./{domain}/entities");
// ...
api.use("/{domain}/entities", auth, entitiesRouter);
```

## Code Conventions

### File Organization
```
prisma/
└── schema.prisma            # Single source of truth untuk semua model DB
src/
└── prisma/
    ├── index.js             # Prisma client instance + connectDatabase()
    ├── controllers/         # Logika bisnis per domain
    │   ├── master-data/
    │   ├── ebom/
    │   ├── mbom/
    │   ├── sales/
    │   ├── inventory/
    │   ├── planning/
    │   ├── purchasing/
    │   └── production/
    ├── middleware/
    │   ├── auth.js          # JWT verify + authorize()
    │   ├── logger.js        # Audit trail middleware
    │   └── uploads.js       # Multer config
    ├── routes/              # Route definitions per domain
    │   ├── index.js         # registerRoutes(app) — daftarkan semua router di sini
    │   ├── master-data/
    │   ├── ebom/, mbom/, sales/, inventory/, planning/, purchasing/, production/
    └── utils/
        ├── buildSort.js     # Prisma orderBy builder dari query string
        ├── mapDoc.js        # mapDoc/mapDocs (pass-through untuk Prisma)
        ├── deepMerge.js     # Deep merge objects
        ├── snapshotHelpers.js
        ├── notificationHelper.js  # Socket.io broadcast + DB create
        ├── seeder.js        # Default data seeder
        ├── parseDate.js
        └── numericConverter.js
uploads/                     # Static file storage (served di /uploads)
```

### Naming Conventions
- **Prisma models**: Singular, PascalCase di schema (e.g., `Customer`, `SalesOrderHeader`)
  - Table mapping: `@@map("tbl_customer")`, `@@map("tbl_salesorderheader")`
- **Controllers**: `{Entity}Controller.js`, exports functions (tidak pakai class)
- **Routes**: Plural, kebab-case (e.g., `customers.js`, `sales-orders.js`)
- **API Paths**: Kebab-case dengan domain prefix (e.g., `/api/master-data/customers`)
- **HTTP methods**: Gunakan `PATCH` (bukan `PUT`) untuk partial update dan status changes

### Environment Variables
**File**: `.env` (never commit)
```bash
NODE_ENV=development
PORT=5005
DATABASE_URL=postgresql://user:password@localhost:5432/erpmitsutoyo
JWT_SECRET=your-super-secret-jwt-key-here
DEFAULT_ADMIN_USERNAME=admin
DEFAULT_ADMIN_PASSWORD=admin123
DEFAULT_ADMIN_FULLNAME=Super Administrator
```

### Error Messages & Logging
- **Console logs**: Setiap request logged dengan IP, URL, timestamp (di `server.js`)
- **Error handler**: `console.error('ERROR:', err)` di global handler
- **Response messages**: Bahasa Indonesia untuk user-facing messages
- **Comments**: Bahasa Indonesia untuk code comments (konvensi tim)

## Testing & Debugging

### Health Check
```bash
GET /api/health
# Response: { "ok": true, "ts": "2026-04-01T10:00:00.000Z" }
```

### Common Issues

**PostgreSQL Connection Failed**:
1. Pastikan PostgreSQL running di port 5432
2. Check `DATABASE_URL` di `.env`
3. Format: `postgresql://user:password@localhost:5432/dbname`

**JWT Unauthorized**:
1. Check token format: `Authorization: Bearer <token>`
2. Verify `JWT_SECRET` di `.env` sama dengan yang digunakan saat login
3. Token expired? Re-login untuk dapat token baru

**Route Not Found**:
1. Check route registered di `src/prisma/routes/index.js`
2. Verify middleware order: `auth` harus sebelum `authorize` dan controller
3. Pastikan helper routes (e.g., `/generate-code`) dideklarasikan **sebelum** `/:id`
4. Check BASE_PATH = `/api` di route registration

**Prisma Schema Error**:
1. Setelah edit `schema.prisma`, wajib jalankan `npm run db:migrate` atau `npm run db:push`
2. Regenerate Prisma Client jika perlu: `npx prisma generate`

## Utility Functions Reference

### `buildSort(query, options)`
```javascript
const { buildSort } = require("./utils/buildSort");

const orderBy = buildSort(req.query, {
  allowed: ["createdAt", "name", "code"],  // whitelist field
  fieldMap: { "customerName": "customer.name" } // alias FE → Prisma field
});
// Input: ?sort=createdAt:desc
// Output: { createdAt: "desc" }  ← Prisma orderBy format (bukan Mongoose sort)
```

### `mapDoc(doc)` / `mapDocs(docs)`
```javascript
const { mapDoc, mapDocs } = require("./utils/mapDoc");

// Prisma sudah return plain object, fungsi ini untuk konsistensi API
const result = mapDoc(prismaDoc);
const results = mapDocs(prismaDocArray);
```

### `deepMerge(target, ...sources)`
```javascript
const { deepMerge } = require("./utils/deepMerge");
const merged = deepMerge(targetObj, source1, source2);
```

### `createSnapshot(doc, includeFields?)`
```javascript
const { createSnapshot, createSnapshotFromRef } = require("./utils/snapshotHelpers");

// Snapshot dari object (exclude: id, createdAt, updatedAt, isDeleted)
const snap = createSnapshot(customerDoc, ["customerName", "address"]);

// Snapshot dari DB ref
const snap = await createSnapshotFromRef("customer", id, ["customerName"], { address: true });
```

### `notificationHelper.create(data)`
```javascript
const notificationHelper = require("./utils/notificationHelper");

await notificationHelper.create({
  type: "sales_order",
  title: "SO Baru",
  message: "Sales Order SO-20260401-001 telah dibuat",
  entityId: "SO-20260401-001",
  entityUrl: "/sales/sales-orders/SO-20260401-001",
  userId: null,          // null = broadcast ke semua
  createdBy: req.user.username,
});
```

## Project-Specific Notes

### Domain Overview
| Domain | Route Prefix | Models Utama |
|---|---|---|
| Master Data | `/api/master-data/` | Customer, Supplier, Vendor, VendorProcess, Part, PartBase, PartAttachment, Material, Process, SubProcess, UOM, Currency, PaymentTerm, Dies, DiesPart, DiesMaintenance, DiesUsage, Machine, Department, Division, Employee, Product, *PriceList per entitas |
| EBOM | `/api/ebom/` | EBOMHeader, EBOMDetail, EBOMProcess, EBOMCostHeader, EBOMCostDetail |
| MBOM | `/api/mbom/` | MBOMHeader, MBOMDetail, MBOMProcess, MBOMCostHeader, MBOMCostDetail |
| Sales | `/api/sales/` | QuotationHeader, QuotationDetail, SalesOrderHeader, SalesOrderDetail, SalesOrderAttachment, DeliverySchedule, DeliveryScheduleDetail |
| Inventory | `/api/inventory/` | Warehouse, Rack, LotMaster, StockBalance, StockMovement, StockReservation |
| Planning | `/api/planning/` | Forecast, ForecastDetail, MPS, MPSDetail, MRPRun, MRPRequirement, PlannedOrder |
| Purchasing | `/api/purchasing/` | PurchaseRequisition, PurchaseRequisitionDetail, PurchaseOrder, PurchaseOrderPR, PurchaseOrderDetail, GoodsReceipt, GoodsReceiptDetail |
| Production | `/api/production/` | ManufacturingOrder, WorkOrder, ProductionLog, QualityInspection, QualityInspectionDetail, MaterialIssue, MaterialIssueDetail |

### BOM Structure (EBOM & MBOM)
- **EBOMHeader / MBOMHeader**: Header BOM (bomNumber, description, status, version, partId)
- **EBOMDetail / MBOMDetail**: Line items (partCode, quantity, uom, category: `inHouse | Purchase | Vendor`)
- **EBOMProcess / MBOMProcess**: Proses manufaktur per BOM (subProcessCode atau vendorCode)
- **EBOMCostHeader / MBOMCostHeader**: Header cost per BOM, berisi total cost
- **EBOMCostDetail / MBOMCostDetail**: Breakdown cost per line (`BomCostType`: `Material | Process | Overhead`)
- **PartBase**: Tabel dasar part type — satu part bisa punya beberapa base (multi-type)
- Report tersedia di `/api/ebom/ebom-report` dan `/api/mbom/mbom-report`

### Sales Workflow
```
Quotation (Draft → Pending → Approved/Rejected/Accepted)
    ↓ (jika Accepted)
SalesOrderHeader (Draft → Confirmed → Released/Cancelled)
    ↓ (jika Confirmed, auto-trigger notifikasi)
DeliverySchedule (status → Completed saat semua item terkirim)
    ↓ (Release ke produksi)
ManufacturingOrder
```
- `QuotationDetail` memiliki harga, qty, part, dan discount per item
- `SalesOrderAttachment` untuk dokumen SO (upload via Multer)
- `DeliveryScheduleDetail` menyimpan `qty` dan `qtyDelivered` per item per jadwal
- SO Confirmed → auto set `approvedBy` dan `approvedDate`
- SO Release → auto-reserve stock via `soReservationService` (`StockReservation.status: Active`)

### Planning Workflow
```
Forecast (Draft → Confirmed)
    ↓
MPS - Master Production Schedule (Draft → Confirmed → Released)
    ↓
MRPRun (status: Completed/Cancelled) → generates MRPRequirement
    ↓
PlannedOrder (Planned → Released/Cancelled)
    ↓ (convertToManufacturingOrder)
ManufacturingOrder
```
- `ForecastDetail` menyimpan quantity per periode (bulan/minggu)
- `MPSDetail` menyimpan planned production per periode
- `MRPRequirement` adalah output MRP: kebutuhan material/part per periode
- `PlannedOrder` bisa di-cancel bulk atau di-convert ke ManufacturingOrder

### Purchasing Workflow
```
PurchaseRequisition (Draft → Partially Ordered → Completed / Cancelled)
    ↓
PurchaseOrder (Draft → Sent → Confirmed → Completed / Cancelled)
    ↓ (via PurchaseOrderPR junction)
GoodsReceipt (Draft → Confirmed → Completed)
    ↓
StockBalance auto-update
```
- `PurchaseOrderPR`: junction table yang menghubungkan PO dengan satu atau lebih PR
- PO bisa `Approved`, `Partial Receipt`, atau `Partially Ordered` sebagai status intermediate
- GoodsReceipt `Completed` → auto update `StockBalance` dan `StockMovement`
- PO dengan GR status `Completed` tidak bisa dihapus/dibatalkan
- Purchasing reports tersedia di `/api/purchasing/purchasing-report`

### Production Workflow
```
ManufacturingOrder (Draft → In Progress → Completed)
    ├── WorkOrder[] (Planned → In Progress → Completed) — per mesin/shift
    │       ↓ (saat Completed, auto-create DiesUsage)
    ├── ProductionLog[] (Draft → Approved) — pencatatan aktual produksi per shift
    │       └── QualityInspection[] (per log, status → Completed)
    │               └── QualityInspectionDetail[]
    └── MaterialIssue[] (Issued → Closed) — pengeluaran material ke produksi
            └── MaterialIssueDetail[]
```
- `WorkOrder` di-complete → auto-create `DiesUsage` (tracking shot count dies)
- `QualityInspection` linked ke `ProductionLog`, `WorkOrder`, dan `ManufacturingOrder`
- `MaterialIssue` mengurangi `StockBalance` saat berstatus `Issued`
- Production reports tersedia di `/api/production/production-reports`

### Inventory Structure
- **Warehouse** → memiliki banyak **Rack**
- **Rack** → tempat penyimpanan fisik, digunakan di `StockBalance`, `StockMovement`, `GoodsReceiptDetail`
- **LotMaster** → tracking lot/batch per part
- **StockBalance** → stok aktual per `partId + rackId + lotId` (unique constraint)
- **StockMovement** → audit trail setiap pergerakan stok (IN/OUT/TRANSFER/ADJUSTMENT)
- **StockReservation** → reservasi stok untuk SO (`Active → Released / Cancelled`)
- `StockBalance` juga menampilkan PO dalam pipeline (status: `Sent/Confirmed/Partial Receipt`)

### Master Data Dependencies
- **Part** → requires **UOM**; optional **SubProcess** (proses luar), **Vendor**; punya **PartBase[]**, **PartAttachment[]**, **PartPriceList[]**
- **Material** → requires **UOM**; punya **MaterialPriceList[]**
- **Vendor** → punya **VendorProcess[]** (via `EntityVendorProcess` junction) dan **VendorPriceList[]**
- **Product** → entitas produk jadi, punya **ProductPriceList[]**
- **EBOM/MBOM** → requires **Part** (header), **Parts/Materials/SubProcesses/Vendors** (detail)
- **SalesOrder** → requires **Customer**, **Currency**, **Part**; snapshot customer data tersimpan di SO
- **PurchaseOrder** → requires **Supplier** OR **Vendor** (tidak keduanya), item bisa **Part/Material/Product**
- **ManufacturingOrder** → dipicu dari **PlannedOrder** (planning) atau langsung dari **SalesOrder** (release)
- **Dies** → tracking shot count via `DiesUsage` (auto-create dari WorkOrder selesai); `DiesPart` mapping dies ke part; `DiesMaintenance` untuk jadwal perawatan

### Status Values Per Domain
| Entity | Status Flow |
|---|---|
| Quotation | `Draft → Pending → Approved / Rejected / Accepted` |
| SalesOrder | `Draft → Confirmed → Released / Cancelled` |
| DeliverySchedule | `(selesai) → Completed` |
| Forecast | `Draft → Confirmed` |
| MPS | `Draft → Confirmed → Released` |
| MRPRun | `Completed / Cancelled` |
| PlannedOrder | `Planned → Released / Cancelled` |
| PurchaseRequisition | `Draft → Partially Ordered → Completed / Cancelled` |
| PurchaseOrder | `Draft → Sent → Confirmed → Completed / Cancelled` (intermediate: `Approved`, `Partial Receipt`, `Partially Ordered`) |
| GoodsReceipt | `Draft → Confirmed → Completed` |
| ManufacturingOrder | `Draft → In Progress → Completed` |
| WorkOrder | `Planned → In Progress → Completed` |
| ProductionLog | `Draft → Approved` |
| QualityInspection | `(selesai) → Completed` |
| MaterialIssue | `Issued → Closed` |
| StockReservation | `Active → Released / Cancelled` |
| Dies | `Active / Maintenance / Retired / Scrapped / Reserved` |

### Enums di Prisma Schema
```
Status:       Draft | Pending | Approved | Rejected | Active | Inactive | Obsolete
Category:     inHouse | Purchase | Vendor
BomCostType:  Material | Process | Overhead
DiesStatus:   Active | Maintenance | Retired | Scrapped | Reserved
DiesOwnerType: Mitsutoyo | Customer
```

Semua komentar dalam kode **harus dalam bahasa Indonesia** untuk konsistensi tim.