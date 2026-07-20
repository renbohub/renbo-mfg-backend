const multer = require("multer");
const path = require("path");
const fs = require("fs");

const {
  QuotationUploadConfig,
  PurchaseInvoiceUploadConfig,
  PartPhotoUploadConfig,
  PartAttachmentUploadConfig,
  MIME_IMAGES,
} = require("../utils/uploadConfigs");

// ============================================
// HELPER UTILITIES
// ============================================

function setNestedProperty(obj, dotPath, value) {
  const keys = dotPath.split(".");
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (!isNaN(key)) {
      const index = parseInt(key);
      if (!Array.isArray(current)) current = [];
      while (current.length <= index) current.push({});
      if (!current[index] || typeof current[index] !== "object") current[index] = {};
      current = current[index];
    } else {
      if (!current[key] || typeof current[key] !== "object") current[key] = {};
      current = current[key];
    }
  }
  current[keys[keys.length - 1]] = value;
}

function getNestedProperty(obj, dotPath) {
  return dotPath.split(".").reduce((cur, key) => (cur == null ? undefined : cur[key]), obj);
}

function createSingleUpload(uploadConfig, fieldName = "image", targetPath = "imageUrl") {
  const upload = uploadConfig.getMulterConfig();
  return (req, res, next) => {
    upload.single(fieldName)(req, res, (err) => {
      if (err) {
        const { status, error } = uploadConfig.handleMulterError(err);
        return res.status(status).json({ error });
      }
      if (req.file) {
        setNestedProperty(req.body, targetPath, uploadConfig.getRelativePath(req.file.filename));
      }
      next();
    });
  };
}

function createFileCleanup(uploadConfig) {
  return {
    deleteFile: (filePath) => uploadConfig.deleteFile(filePath),
    cleanupFiles: (data, paths) => {
      if (!data) return;
      paths.forEach((p) => {
        const filePath = getNestedProperty(data, p);
        if (filePath) uploadConfig.deleteFile(filePath);
      });
    },
    cleanupFromArray: (items, paths) => {
      if (!Array.isArray(items)) return;
      items.forEach((item) => {
        paths.forEach((p) => {
          const filePath = getNestedProperty(item, p);
          if (filePath) uploadConfig.deleteFile(filePath);
        });
      });
    },
  };
}

// ============================================
// QUOTATION UPLOADS (PDF - multiple files)
// ============================================

const quotationUploadConfig = new QuotationUploadConfig();
const quotationFileCleanup = createFileCleanup(quotationUploadConfig);
const deleteQuotationFile = (filePath) => quotationFileCleanup.deleteFile(filePath);

// Upload multiple quotation files (field: quotationFiles)
const uploadQuotationFiles = multer({
  storage: quotationUploadConfig.getStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 10 },
  fileFilter: quotationUploadConfig.fileFilter,
}).fields([{ name: "quotationFiles", maxCount: 10 }]);

// Backward-compat alias (digunakan beberapa route lama)
const uploadQuotationPDF = uploadQuotationFiles;

// ============================================
// PURCHASE INVOICE UPLOADS (PDF - multiple files)
// ============================================

const purchaseInvoiceUploadConfig = new PurchaseInvoiceUploadConfig();
const purchaseInvoiceFileCleanup = createFileCleanup(purchaseInvoiceUploadConfig);
const deletePurchaseInvoiceFile = (filePath) => purchaseInvoiceFileCleanup.deleteFile(filePath);

const uploadPurchaseInvoiceFiles = multer({
  storage: purchaseInvoiceUploadConfig.getStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 10 },
  fileFilter: purchaseInvoiceUploadConfig.fileFilter,
}).fields([{ name: "invoiceFiles", maxCount: 10 }]);

// ============================================
// PART PHOTO UPLOADS
// ============================================

const partPhotoUploadConfig = new PartPhotoUploadConfig();
const uploadPartPhoto = partPhotoUploadConfig.getMulterConfig().array("photos", 10);
const partPhotoFileCleanup = createFileCleanup(partPhotoUploadConfig);
const deletePartPhoto = (filePath) => partPhotoFileCleanup.deleteFile(filePath);

// ============================================
// PART ATTACHMENT UPLOADS
// ============================================

const partAttachmentUploadConfig = new PartAttachmentUploadConfig();
const uploadPartAttachment = partAttachmentUploadConfig.getMulterConfig();
const partAttachmentFileCleanup = createFileCleanup(partAttachmentUploadConfig);
const deletePartAttachment = (filePath) => partAttachmentFileCleanup.deleteFile(filePath);

// ============================================
// EMPLOYEE IMAGE UPLOADS (profile photo, signature)
// ============================================

const employeeImageStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const subdirMap = { profilePhoto: "profile", signature: "signature" };
    const subdir = subdirMap[file.fieldname] || "other";
    const uploadPath = path.join(__dirname, `../../../uploads/employees/${subdir}`);
    if (!fs.existsSync(uploadPath)) fs.mkdirSync(uploadPath, { recursive: true });
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const uniqueSuffix = `${Date.now()}_${Math.random().toString(36).substring(2, 10).toUpperCase()}`;
    const fieldPrefix = file.fieldname === "profilePhoto" ? "PROFILE" : "SIGNATURE";
    const employeeCode = (req.body.employeeId || "UNKNOWN").replace(/[^A-Z0-9\-_]/gi, "").toUpperCase();
    cb(null, `EMPLOYEE-${fieldPrefix}-${employeeCode}_${uniqueSuffix}${ext}`);
  },
});

const uploadEmployeeImages = multer({
  storage: employeeImageStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (["profilePhoto", "signature"].includes(file.fieldname)) {
      if (MIME_IMAGES.includes(file.mimetype)) cb(null, true);
      else cb(new Error("File harus berupa gambar (JPEG, PNG, GIF, WEBP)"));
    } else {
      cb(new Error("Field upload employee tidak valid"));
    }
  },
}).fields([
  { name: "profilePhoto", maxCount: 1 },
  { name: "signature", maxCount: 1 },
]);

const deleteEmployeeImage = (fileUrl) => {
  if (!fileUrl) return;
  const subdirs = ["profile", "signature"];
  for (const subdir of subdirs) {
    const prefix = `/uploads/employees/${subdir}/`;
    if (fileUrl.startsWith(prefix)) {
      const filename = fileUrl.slice(prefix.length);
      const fullPath = path.join(__dirname, "../../../uploads/employees", subdir, filename);
      try { if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath); } catch { /* ignore */ }
      return;
    }
  }
};

// ============================================
// PART WITH ATTACHMENTS (COMBINED UPLOAD)
// Menggabungkan upload foto part + file attachment dalam satu request.
// - Field 'photos'       → /uploads/parts/
// - Field lainnya        → /uploads/parts/attachments/
// ============================================

const partCombinedStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadPath = file.fieldname === "photos"
      ? path.join(__dirname, "../../../uploads/parts")
      : path.join(__dirname, "../../../uploads/parts/attachments");

    if (!fs.existsSync(uploadPath)) fs.mkdirSync(uploadPath, { recursive: true });
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const uniqueSuffix = `${Date.now()}_${Math.random().toString(36).substring(2, 10).toUpperCase()}`;
    const prefix = file.fieldname === "photos" ? "PART-PHOTO" : "PART-ATTACH";
    const partCode = (req.body.partCode || "UNKNOWN").replace(/[^A-Z0-9\-_]/gi, "").toUpperCase();
    cb(null, `${prefix}-${partCode}_${uniqueSuffix}${ext}`);
  },
});

const uploadPartWithAttachments = multer({
  storage: partCombinedStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
  fileFilter: (req, file, cb) => {
    if (file.fieldname === "photos") {
      if (MIME_IMAGES.includes(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new Error("Photo harus berupa file gambar (JPEG, PNG, GIF, WEBP)"));
      }
    } else {
      // files, replacedFiles, dll — semua tipe file diterima
      cb(null, true);
    }
  },
}).fields([
  { name: "photos", maxCount: 10 },
  { name: "files", maxCount: 40 },
  { name: "replacedFiles", maxCount: 40 },
]);

// ============================================
// DIES FILE UPLOADS (photos, drawings, specs)
// ============================================

const diesCombinedStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const subdirMap = { photos: "photos", drawings: "drawings", specs: "specs" };
    const subdir = subdirMap[file.fieldname] || "other";
    const uploadPath = path.join(__dirname, `../../../uploads/dies/${subdir}`);
    if (!fs.existsSync(uploadPath)) fs.mkdirSync(uploadPath, { recursive: true });
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const uniqueSuffix = `${Date.now()}_${Math.random().toString(36).substring(2, 10).toUpperCase()}`;
    const fieldPrefix = file.fieldname.toUpperCase();
    const diesCode = (req.body.diesCode || "UNKNOWN").replace(/[^A-Z0-9\-_]/gi, "").toUpperCase();
    cb(null, `DIES-${fieldPrefix}-${diesCode}_${uniqueSuffix}${ext}`);
  },
});

const uploadDiesFiles = multer({
  storage: diesCombinedStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.fieldname === "photos") {
      if (MIME_IMAGES.includes(file.mimetype)) cb(null, true);
      else cb(new Error("Photo harus berupa file gambar (JPEG, PNG, GIF, WEBP)"));
    } else {
      cb(null, true); // drawings, specs — semua tipe file diterima
    }
  },
}).fields([
  { name: "photos", maxCount: 10 },
  { name: "drawings", maxCount: 10 },
  { name: "specs", maxCount: 10 },
]);

// Hapus satu file dies berdasarkan fileUrl
const deleteDiesFile = (fileUrl) => {
  if (!fileUrl) return;
  const subdirs = ["photos", "drawings", "specs"];
  for (const subdir of subdirs) {
    const prefix = `/uploads/dies/${subdir}/`;
    if (fileUrl.startsWith(prefix)) {
      const filename = fileUrl.slice(prefix.length);
      const fullPath = path.join(__dirname, "../../../uploads/dies", subdir, filename);
      try { if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath); } catch { /* ignore */ }
      return;
    }
  }
};

// ============================================
// MACHINE FILE UPLOADS (photos, drawings)
// ============================================

const machineCombinedStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const subdirMap = { photos: "photos", drawings: "drawings" };
    const subdir = subdirMap[file.fieldname] || "other";
    const uploadPath = path.join(__dirname, `../../../uploads/machines/${subdir}`);
    if (!fs.existsSync(uploadPath)) fs.mkdirSync(uploadPath, { recursive: true });
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const uniqueSuffix = `${Date.now()}_${Math.random().toString(36).substring(2, 10).toUpperCase()}`;
    const fieldPrefix = file.fieldname.toUpperCase();
    const machineCode = (req.body.machineCode || "UNKNOWN").replace(/[^A-Z0-9\-_]/gi, "").toUpperCase();
    cb(null, `MACHINE-${fieldPrefix}-${machineCode}_${uniqueSuffix}${ext}`);
  },
});

const uploadMachineFiles = multer({
  storage: machineCombinedStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.fieldname === "photos") {
      if (MIME_IMAGES.includes(file.mimetype)) cb(null, true);
      else cb(new Error("Photo harus berupa file gambar (JPEG, PNG, GIF, WEBP)"));
    } else {
      cb(null, true); // drawings — semua tipe file diterima
    }
  },
}).fields([
  { name: "photos", maxCount: 10 },
  { name: "drawings", maxCount: 10 },
]);

// Hapus satu file machine berdasarkan fileUrl
const deleteMachineFile = (fileUrl) => {
  if (!fileUrl) return;
  const subdirs = ["photos", "drawings"];
  for (const subdir of subdirs) {
    const prefix = `/uploads/machines/${subdir}/`;
    if (fileUrl.startsWith(prefix)) {
      const filename = fileUrl.slice(prefix.length);
      const fullPath = path.join(__dirname, "../../../uploads/machines", subdir, filename);
      try { if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath); } catch { /* ignore */ }
      return;
    }
  }
};

// ============================================
// EXPORTS
// ============================================

module.exports = {
  // Quotation
  uploadQuotationPDF,
  uploadQuotationFiles,
  quotationFileCleanup,
  deleteQuotationFile,

  // Purchase invoice
  uploadPurchaseInvoiceFiles,
  purchaseInvoiceFileCleanup,
  deletePurchaseInvoiceFile,

  // Part photo
  uploadPartPhoto,
  partPhotoFileCleanup,
  deletePartPhoto,

  // Part attachment (standalone endpoint)
  uploadPartAttachment,
  partAttachmentFileCleanup,
  deletePartAttachment,

  // Employee images
  uploadEmployeeImages,
  deleteEmployeeImage,

  // Part + attachment combined (create/update with-attachments)
  uploadPartWithAttachments,

  // Dies files (photos, drawings, specs)
  uploadDiesFiles,
  deleteDiesFile,

  // Machine files (photos, drawings)
  uploadMachineFiles,
  deleteMachineFile,

  // Configs
  quotationUploadConfig,
  purchaseInvoiceUploadConfig,
  partPhotoUploadConfig,
  partAttachmentUploadConfig,

  // Factories
  createSingleUpload,
  createFileCleanup,
};
