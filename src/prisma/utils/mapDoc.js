// Utilitas untuk mengonversi hasil Prisma ke format yang konsisten
// Prisma sudah mengembalikan plain objects, jadi lebih sederhana dari Mongoose

/**
 * Memetakan dokumen Prisma ke format yang konsisten
 * @param {Object} doc - Dokumen yang akan dipetakan
 * @returns {Object|null} - Objek yang telah dipetakan atau null
 */
const mapDoc = function (doc) {
  if (doc == null) return null;
  
  // Prisma sudah mengembalikan plain object, tidak perlu konversi seperti Mongoose
  // Hanya perlu memastikan format konsisten
  return doc;
};

/**
 * Memetakan array dokumen Prisma ke format yang konsisten
 * @param {Array} docs - Array dokumen yang akan dipetakan
 * @returns {Array} - Array objek yang telah dipetakan
 */
const mapDocs = function (docs) {
  if (!Array.isArray(docs)) return [];
  return docs.map(mapDoc);
};

module.exports = { mapDoc, mapDocs };

/**
 * Dokumentasi Penggunaan:
 * 
 * 1. mapDoc(doc)
 *    - Mengonversi dokumen Prisma tunggal (sudah plain object by default).
 *    - Parameter:
 *      - doc: Dokumen Prisma yang akan dipetakan.
 *    - Contoh:
 *      const plainDoc = mapDoc(prismaDoc);
 * 
 * 2. mapDocs(docs)
 *    - Mengonversi array dokumen Prisma.
 *    - Parameter:
 *      - docs: Array dokumen Prisma yang akan dipetakan.
 *    - Contoh:
 *      const plainDocs = mapDocs(prismaDocsArray);
 * 
 * Note: Prisma client sudah mengembalikan plain JavaScript objects,
 * tidak seperti Mongoose yang mengembalikan Document instances.
 * Utility ini tetap ada untuk konsistensi API dan future extensibility.
 */
