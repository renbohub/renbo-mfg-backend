const path = require('path');
require('dotenv').config({
  path: path.resolve(__dirname, '../../.env'),
  override: true,
});
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');

const resolveDatabaseConfig = () => {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return { poolConfig: {}, schema: undefined };

  try {
    const parsed = new URL(connectionString);
    const schema = parsed.searchParams.get('schema');
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
console.log('📦 Prisma schema:', schema || 'default');

// Create PostgreSQL pool
const pool = new Pool(poolConfig);

// Create Prisma adapter
const adapter = new PrismaPg(pool, schema ? { schema } : undefined);

// Create Prisma Client with adapter
const prisma = new PrismaClient({
  adapter,
  log: process.env.NODE_ENV === 'development' 
    ? ['query', 'info', 'warn', 'error']
    : ['error'],
});

// Connection test
async function connectDatabase() {
  try {
    await prisma.$connect();
    // PrismaPg membuka koneksi secara lazy. Query ringan ini memastikan
    // PostgreSQL benar-benar menerima koneksi sebelum server dijalankan.
    await prisma.$queryRaw`SELECT 1`;
    console.log('✅ PostgreSQL Connected successfully');
    
    // Run seeder after connection
    const runSeeders = require('./utils/seeder');
    await runSeeders();
  } catch (error) {
    console.error('❌ PostgreSQL Connection Failed:', error.message);
    console.error('   Make sure PostgreSQL is running and DATABASE_URL is correct');
    console.error('   DATABASE_URL:', process.env.DATABASE_URL?.replace(/:[^:@]+@/, ':***@')); // hide password
    process.exit(1);
  }
}
// berkat
// Graceful shutdown
async function disconnectDatabase() {
  await prisma.$disconnect();
  console.log('PostgreSQL Disconnected');
}

process.on('beforeExit', disconnectDatabase);
process.on('SIGINT', async () => {
  await disconnectDatabase();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  await disconnectDatabase();
  process.exit(0);
});

module.exports = { prisma, connectDatabase, disconnectDatabase };
