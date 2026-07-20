const multer = require("multer");
const path = require("path");
const fs = require("fs");

// ─── Shared MIME type lists ───────────────────────────────────────────────────

const MIME_IMAGES = ["image/jpeg", "image/jpg", "image/png", "image/gif", "image/webp"];

const MIME_DOCUMENTS = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
];

const MIME_CAD = [
  "application/x-autocad",
  "application/acad",
  "image/vnd.dwg",
  "image/vnd.dxf",
];

const MIME_TEXT = ["text/plain", "text/csv"];

// Semua tipe file yang diizinkan untuk attachment/quotation
const MIME_ALL_FILES = [...MIME_IMAGES, ...MIME_DOCUMENTS, ...MIME_CAD, ...MIME_TEXT];

/**
 * Kelas Konfigurasi Upload
 * Kelas dasar untuk konfigurasi upload yang dapat digunakan kembali
 */
class UploadConfig {
  constructor(options = {}) {
    this.uploadDir =
      options.uploadDir || path.join(__dirname, "../../../uploads/general");
    this.filenamePrefix = options.filenamePrefix || "";
    this.maxFileSize = options.maxFileSize || 5 * 1024 * 1024; // default 5MB
    this.maxFiles = options.maxFiles || 1;
    this.allowedMimeTypes = options.allowedMimeTypes || [
      "image/jpeg",
      "image/png",
      "image/gif",
      "image/webp",
    ];
    this.pathPrefix = options.pathPrefix || "/uploads/general";

    this.ensureUploadDir();
  }

  /**
   * Memastikan direktori upload ada
   */
  ensureUploadDir() {
    if (!fs.existsSync(this.uploadDir)) {
      fs.mkdirSync(this.uploadDir, { recursive: true });
    }
  }

  generateFilename(req, file) {
    const ext = path.extname(file.originalname) || "";

    let code = (req && req.body && req.body.code) || "";
    code =
      String(code).trim().toUpperCase().replace(/\s+/g, "-") || file.fieldname;

    const id =
      (req && req.params && req.params.id) ||
      (req && req.body && (req.body.id || req.body._id)) ||
      this.generateUniqueId();

    // Menghasilkan timestamp untuk keunikan
    const timestamp = Date.now();
    
    // Menghasilkan string acak untuk keunikan tambahan
    const randomString = Math.random().toString(36).substring(2, 8);

    return `${this.filenamePrefix}${code}_&_${id}_${timestamp}_${randomString}${ext}`;
  }

  /**
   * Menghasilkan ID unik untuk nama file
   */
  generateUniqueId() {
    return Date.now().toString(36) + Math.random().toString(36).substring(2);
  }

  /**
   * Menyaring kode untuk nama file (menghapus karakter khusus, membatasi panjang)
   */
  sanitizeCode(code) {
    return String(code)
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9\-_]/g, "") // Menghapus karakter khusus kecuali - dan _
      .substring(0, 20); // Membatasi panjang
  }

  /**
   * Menghasilkan string mirip UUID pendek
   */
  generateShortUUID() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < 8; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }

  /**
   * Filter file untuk validasi
   */
  fileFilter = (req, file, cb) => {
    if (this.allowedMimeTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(
        new Error(
          `Hanya file ${this.allowedMimeTypes.join(", ")} yang diperbolehkan!`
        ),
        false
      );
    }
  };

  /**
   * Mendapatkan konfigurasi penyimpanan
   */
  getStorage() {
    return multer.diskStorage({
      destination: (req, file, cb) => {
        cb(null, this.uploadDir);
      },
      filename: (req, file, cb) => {
        const filename = this.generateFilename(req, file);
        cb(null, filename);
      },
    });
  }

  /**
   * Mendapatkan konfigurasi multer
   */
  getMulterConfig() {
    return multer({
      storage: this.getStorage(),
      limits: {
        fileSize: this.maxFileSize,
        files: this.maxFiles,
      },
      fileFilter: this.fileFilter,
    });
  }

  /**
   * Mendapatkan path relatif untuk penyimpanan database
   */
  getRelativePath(filename) {
    return `${this.pathPrefix}/${filename}`;
  }

  /**
   * Mendapatkan path absolut untuk operasi file
   */
  getAbsolutePath(relativePath) {
    // Menghapus pathPrefix dari relativePath untuk mendapatkan nama file
    const filename = relativePath.replace(this.pathPrefix + "/", "");
    return path.join(this.uploadDir, filename);
  }

  /**
   * Menghapus file berdasarkan path relatif
   */
  deleteFile(relativePath) {
    if (!relativePath || !relativePath.startsWith(this.pathPrefix)) {
      return false;
    }

    try {
      const fullPath = this.getAbsolutePath(relativePath);
      if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
        return true;
      }
    } catch (error) {
      console.error("Kesalahan saat menghapus file:", error);
    }
    return false;
  }

  /**
   * Menangani kesalahan multer
   */
  handleMulterError(err) {
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return {
          status: 400,
          error: `File terlalu besar. Ukuran maksimum adalah ${Math.round(
            this.maxFileSize / 1024 / 1024
          )}MB.`,
        };
      }
      if (err.code === "LIMIT_FILE_COUNT") {
        return {
          status: 400,
          error: `Terlalu banyak file. Maksimum ${this.maxFiles} file diperbolehkan.`,
        };
      }
      return {
        status: 400,
        error: err.message,
      };
    }

    return {
      status: 400,
      error: err.message,
    };
  }
}

/**
 * Konfigurasi upload untuk file PDF Quotation
 * Digunakan untuk VendorPriceList - upload quotation PDF dari vendor
 */
class QuotationUploadConfig extends UploadConfig {
  constructor() {
    super({
      uploadDir: path.join(__dirname, "../../../uploads/quotations"),
      filenamePrefix: "QUOTATION-",
      maxFileSize: 10 * 1024 * 1024, // 10MB
      maxFiles: 10,
      pathPrefix: "/uploads/quotations",
      allowedMimeTypes: MIME_ALL_FILES,
    });
  }

  generateFilename(req, file) {
    // Gunakan nama file asli
    const originalName = file.originalname;
    const ext = path.extname(originalName);
    const nameWithoutExt = path.basename(originalName, ext);
    
    // Cek apakah file dengan nama yang sama sudah ada
    let finalFilename = originalName;
    let counter = 1;
    
    while (fs.existsSync(path.join(this.uploadDir, finalFilename))) {
      finalFilename = `${nameWithoutExt} (${counter})${ext}`;
      counter++;
    }
    
    return finalFilename;
  }
}

/**
 * Konfigurasi upload untuk file invoice pembelian dari supplier/vendor.
 */
class PurchaseInvoiceUploadConfig extends UploadConfig {
  constructor() {
    super({
      uploadDir: path.join(__dirname, "../../../uploads/purchase-invoices"),
      filenamePrefix: "PURCHASE-INVOICE-",
      maxFileSize: 10 * 1024 * 1024,
      maxFiles: 10,
      pathPrefix: "/uploads/purchase-invoices",
      allowedMimeTypes: ["application/pdf"],
    });
  }

  generateFilename(req, file) {
    const ext = path.extname(file.originalname) || ".pdf";
    const invoiceNo = this.sanitizeCode(req?.body?.supplierInvoiceNumber || req?.body?.invoiceNumber || "UNKNOWN");
    const timestamp = Date.now();
    const shortUUID = this.generateShortUUID();

    return `${this.filenamePrefix}${invoiceNo}_${timestamp}_${shortUUID}${ext}`;
  }
}

/**
 * Konfigurasi upload untuk foto Part
 * Digunakan untuk Part - upload foto part
 */
class PartPhotoUploadConfig extends UploadConfig {
  constructor() {
    super({
      uploadDir: path.join(__dirname, "../../../uploads/parts"),
      filenamePrefix: "PART-",
      maxFileSize: 5 * 1024 * 1024, // 5MB untuk gambar
      maxFiles: 1,
      pathPrefix: "/uploads/parts",
      allowedMimeTypes: MIME_IMAGES,
    });
  }

  generateFilename(req, file) {
    const ext = path.extname(file.originalname) || "";
    
    // Mendapatkan partCode dari permintaan
    let partCode = (req && req.body && req.body.partCode) || "";
    partCode = this.sanitizeCode(partCode) || "UNKNOWN";
    
    // Menghasilkan komponen unik
    const timestamp = Date.now();
    const shortUUID = this.generateShortUUID();
    
    // Format: PART-{CODE}_{TIMESTAMP}_{UUID}.ext
    return `${this.filenamePrefix}${partCode}_${timestamp}_${shortUUID}${ext}`;
  }
}

/**
 * Konfigurasi upload untuk Part Attachments (dynamic files)
 * Support berbagai tipe file: PDF, Excel, Word, Images, dll
 */
class PartAttachmentUploadConfig extends UploadConfig {
  constructor() {
    super({
      uploadDir: path.join(__dirname, "../../../uploads/parts/attachments"),
      filenamePrefix: "PART-ATTACH-",
      maxFileSize: 10 * 1024 * 1024, // 10MB untuk attachments
      maxFiles: 10, // Max 10 files untuk multiple attachments
      pathPrefix: "/uploads/parts/attachments",
      allowedMimeTypes: MIME_ALL_FILES,
    });
  }

  generateFilename(req, file) {
    const ext = path.extname(file.originalname) || "";
    
    // Mendapatkan partCode dari permintaan
    let partCode = (req && req.body && req.body.partCode) || "";
    partCode = this.sanitizeCode(partCode) || "UNKNOWN";
    
    // Menghasilkan komponen unik
    const timestamp = Date.now();
    const shortUUID = this.generateShortUUID();
    
    // Format: PART-ATTACH-{CODE}_{TIMESTAMP}_{UUID}.ext
    return `${this.filenamePrefix}${partCode}_${timestamp}_${shortUUID}${ext}`;
  }
}

module.exports = { 
  UploadConfig, 
  QuotationUploadConfig, 
  PurchaseInvoiceUploadConfig,
  PartPhotoUploadConfig,
  PartAttachmentUploadConfig,
  MIME_IMAGES,
  MIME_DOCUMENTS,
  MIME_CAD,
  MIME_TEXT,
  MIME_ALL_FILES,
};
