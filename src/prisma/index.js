const path = require("path");
require("dotenv").config({
  path: path.resolve(__dirname, "../../.env"),
  // PM2/deployment environment is authoritative; .env only supplies values
  // that were not injected by the process manager.
  override: false,
});
const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const { Pool } = require("pg");

const resolveDatabaseConfig = () => {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return { poolConfig: {}, schema: undefined };

  try {
    const parsed = new URL(connectionString);
    const schema = parsed.searchParams.get("schema");
    if (!schema) return { poolConfig: { connectionString }, schema: undefined };

    return {
      poolConfig: {
        connectionString,
        options: `-c search_path=${schema}`,
      },
      schema,
    };
  } catch {
    return { poolConfig: { connectionString }, schema: undefined };
  }
};

const { poolConfig, schema } = resolveDatabaseConfig();
console.log("📦 Prisma schema:", schema || "default");

// Create PostgreSQL pool
const pool = new Pool(poolConfig);

// Create Prisma adapter
const adapter = new PrismaPg(pool, schema ? { schema } : undefined);

// Create Prisma Client with adapter
const prisma = new PrismaClient({
  adapter,
  log:
    process.env.NODE_ENV === "development"
      ? ["query", "info", "warn", "error"]
      : ["error"],
});

async function assertDatabaseSchemaReady() {
  const missing = await prisma.$queryRaw`
    SELECT expected.table_name
    FROM (VALUES
      ('tbl_users'),
      ('tbl_paymentterm'),
      ('tbl_uom'),
      ('tbl_currency'),
      ('tbl_process'),
      ('tbl_rack')
    ) AS expected(table_name)
    WHERE to_regclass('public.' || expected.table_name) IS NULL
  `;
  if (missing.length) {
    const names = missing.map((row) => row.table_name).join(", ");
    throw new Error(
      `Database schema belum siap. Tabel hilang: ${names}. Jalankan "npm run db:bootstrap" (atau "npx prisma migrate deploy") dari folder backend dengan DATABASE_URL yang benar, lalu restart server.`,
    );
  }
}

// Connection test
async function connectDatabase(options = {}) {
  try {
    await prisma.$connect();
    // PrismaPg membuka koneksi secara lazy. Query ringan ini memastikan
    // PostgreSQL benar-benar menerima koneksi sebelum server dijalankan.
    await prisma.$queryRaw`SELECT 1`;
    console.log("✅ PostgreSQL Connected successfully");
    await assertDatabaseSchemaReady();

    if (options.seed !== false) {
      const runSeeders = require("./utils/seeder");
      await runSeeders();
    }
  } catch (error) {
    console.error("❌ PostgreSQL Connection Failed:", error.message);
    console.error(
      "   Make sure PostgreSQL is running and DATABASE_URL is correct",
    );
    console.error(
      "   DATABASE_URL:",
      process.env.DATABASE_URL?.replace(/:[^:@]+@/, ":***@"),
    ); // hide password
    process.exit(1);
  }
}
// berkat
// Graceful shutdown
async function disconnectDatabase() {
  await prisma.$disconnect();
  console.log("PostgreSQL Disconnected");
}

process.on("beforeExit", disconnectDatabase);
process.on("SIGINT", async () => {
  await disconnectDatabase();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await disconnectDatabase();
  process.exit(0);
});

module.exports = { prisma, connectDatabase, disconnectDatabase };
