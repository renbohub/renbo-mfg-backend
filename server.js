require("dotenv").config({ override: true });
const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const cors = require("cors");
// const { assertLicenseIntegrity } = require("./src/prisma/security/licenseIntegrity");
const { assertAuthServerIpAllowed } = require("./src/prisma/utils/authIps");

// assertLicenseIntegrity();

const app = express();
const server = http.createServer(app);

// --- Setup Socket.io dengan CORS
const io = new Server(server, {
  cors: {
    origin: "*", // Adjust ini sesuai frontend origin di production
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ["websocket", "polling"], // Support fallback
  pingTimeout: 60000,
  pingInterval: 25000
});

// Export io untuk digunakan di controller/helpers
global.io = io;

// --- Parsers (pasang paling atas)
app.use(express.json({ limit: "100mb" }));
app.use(express.urlencoded({ extended: true, limit: "100mb" }));

// --- CORS sederhana
app.use(function (req, res, next) {
  res.header("Access-Control-Allow-Origin", "*");
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept, Authorization, X-Page-Module, X-Page-Code, X-Page-Record"
  );
  res.header("Access-Control-Allow-Methods", "PUT, PATCH, POST, GET, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// --- Static files
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// --- Logger ringkas
app.set("trust proxy", true);
app.use((req, _res, next) => {
  console.log(
    "GOT REQUEST.",
    "FROM:",
    req.ip,
    "TO:",
    req.originalUrl,
    "TIME:",
    new Date().toISOString()
  );
  next();
});

// --- Routes (gunakan Prisma routes)
const registerRoutes = require("./src/prisma/routes");
registerRoutes(app);

// --- 404 fallback untuk non-API (opsional)
app.use((req, res, next) => {
  if (req.originalUrl.startsWith("/api")) {
    return res.status(404).json({ message: "API route not found" });
  }
  next();
});

// --- Error handler global (tetap paling bawah)
app.use((err, req, res, _next) => {
  console.error("ERROR:", err);
  const code = err.status || 500;
  const { recordError } = require("./src/prisma/utils/pageContext");
  req.contextErrorRecorded = true;
  recordError(req, err, code);
  res.status(code).json({ message: err.message || "Error" });
});

app.post("/test-body", express.json(), (req, res) => {
  console.log("HEADERS:", req.headers);
  console.log("BODY:", req.body);
  res.json({ body: req.body });
});

// --- Connect to PostgreSQL with Prisma (replace MongoDB)
const { connectDatabase } = require("./src/prisma");
const { refreshLicense, getLicenseStatus } = require("./src/prisma/services/licenseService");

// --- Socket.io Authentication & Events
const jwt = require("jsonwebtoken");

// Middleware untuk authenticate socket connection
io.use((socket, next) => {
  try {
    const token = socket.handshake.auth.token || socket.handshake.query.token;
    
    if (!token) {
      return next(new Error("Authentication token required"));
    }

    // Verify JWT token
    const decoded = jwt.verify(token, process.env.JWT_SECRET || "your-secret-key");
    socket.userId = decoded.id;
    socket.username = decoded.username;
    next();
  } catch (err) {
    console.error("Socket authentication error:", err.message);
    next(new Error("Invalid authentication token"));
  }
});

// Socket connection handler
io.on("connection", (socket) => {
  console.log(`✅ Socket connected: ${socket.id} (User: ${socket.username})`);
  
  // Join user ke room pribadi mereka (untuk targeted notifications)
  socket.join(`user:${socket.userId}`);
  
  // Handle disconnect
  socket.on("disconnect", (reason) => {
    console.log(`❌ Socket disconnected: ${socket.id} (${reason})`);
  });

  // Client bisa mark notification as read via socket
  socket.on("notification:read", async (notificationId) => {
    try {
      const { notificationHelper } = require("./src/prisma/utils/notificationHelper");
      await notificationHelper.markAsRead(notificationId, socket.userId);
      socket.emit("notification:read:success", { notificationId });
    } catch (err) {
      socket.emit("notification:read:error", { error: err.message });
    }
  });

  // Send initial connection success
  socket.emit("connected", { 
    message: "Connected to notification service",
    userId: socket.userId 
  });
});

// --- Start
const PORT = process.env.PORT || 5005;

// --- Setup Auto-Cleanup Scheduler
const cron = require('node-cron');
const { notificationHelper } = require('./src/prisma/utils/notificationHelper');

// Schedule auto-cleanup setiap hari jam 2 pagi (02:00)
cron.schedule('0 2 * * *', async () => {
  console.log('🧹 [CRON] Starting scheduled notification cleanup...');
  try {
    const summary = await notificationHelper.autoCleanup({
      oldDays: 30,      // Hapus notifikasi > 30 hari
      readDays: 7,      // Hapus notifikasi yang sudah dibaca > 7 hari  
      userLimit: 100    // Max 100 notifikasi per user
    });
    console.log('✅ [CRON] Cleanup completed:', {
      totalDeleted: summary.totalDeleted,
      oldNotifications: summary.oldNotifications,
      readNotifications: summary.readNotifications,
      limitExceeded: summary.limitExceeded,
      timestamp: summary.timestamp
    });
  } catch (error) {
    console.error('❌ [CRON] Cleanup error:', error.message);
  }
});

// Schedule auto-obsolete forecast Draft yang sudah melewati periodEnd — setiap hari jam 00:05
// Hanya Draft yang di-obsolete otomatis; Confirmed dijaga untuk keperluan audit & history MPS
cron.schedule('5 0 * * *', async () => {
  console.log('📦 [CRON] Checking expired forecasts...');
  try {
    const { prisma } = require('./src/prisma');
    const now = new Date();
    const result = await prisma.forecast.updateMany({
      where: {
        periodEnd: { lt: now },
        status: 'Draft',
        isDeleted: false,
      },
      data: { status: 'Obsolete' },
    });
    if (result.count > 0) {
      console.log(`✅ [CRON] ${result.count} forecast(s) marked as Obsolete`);
    } else {
      console.log('✅ [CRON] No expired forecasts found');
    }
  } catch (error) {
    console.error('❌ [CRON] Forecast expiry error:', error.message);
  }
});

async function startServer() {
  try {
    assertAuthServerIpAllowed();

    await connectDatabase();

    const license = await refreshLicense({ force: true });
    const licenseStatus = getLicenseStatus();
    if (!license.valid) {
      console.error("❌ License validation failed:", licenseStatus.error || "License inactive");
      console.error("   License status:", licenseStatus);
      process.exit(1);
    }

    if (licenseStatus.enabled) {
      console.log("✅ License validated:", {
        licenseId: licenseStatus.licenseId,
        clientName: licenseStatus.clientName,
        instanceId: licenseStatus.instanceId,
        expiresAt: licenseStatus.expiresAt,
      });
    }

    server.listen(PORT, () => {
      console.log("✅ Server is running on port:", PORT);
      console.log("🔗 API Base URL: http://localhost:" + PORT + "/api");
      console.log("🕐 Auto-cleanup scheduled: Every day at 02:00 AM");
      console.log("📦 Forecast expiry scheduled: Every day at 00:05 AM");
      console.log("Hybrid MRP scheduler: disabled; MPS/MRP dijalankan manual oleh PPIC");
    });
  } catch (error) {
    console.error("❌ Failed to start server:", error.message);
    process.exit(1);
  }
}

startServer();
