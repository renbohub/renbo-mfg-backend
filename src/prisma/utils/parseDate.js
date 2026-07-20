/**
 * Parse date string ke Date object dengan local timezone
 * 
 * Ketika date string format YYYY-MM-DD di-parse dengan new Date(),
 * JavaScript akan parse sebagai UTC midnight, yang bisa berbeda dengan local timezone.
 * 
 * Fungsi ini memastikan date-only format (YYYY-MM-DD) di-parse dengan menggabungkan
 * tanggal dari input dan waktu dari moment saat ini (current time).
 * Hindari waktu 00:00 dengan menambah 5 menit secara default.
 * 
 * @param {string|Date|null|undefined} dateValue - Date string atau Date object
 * @param {Object} options - Parse options
 * @param {boolean} options.avoidMidnight - Hindari jam 00:00 (default: true)
 * @param {number} options.midnightOffset - Offset menit jika midnight (default: 5)
 * @returns {Date|null} Date object dalam local timezone atau null jika input kosong
 * 
 * @example
 * parseDate("2025-12-15") // Returns: 2025-12-15 dengan waktu saat ini, hindari 00:00
 * parseDate("2025-12-15", { avoidMidnight: false }) // Returns: exact current time
 * parseDate("2025-12-15T14:30:00Z") // Returns: Date dengan timezone info preserved
 * parseDate(new Date()) // Returns: Date object as-is
 * parseDate(null) // Returns: null
 */
function parseDate(dateValue, options = {}) {
  const { avoidMidnight = true, midnightOffset = 5 } = options;
  
  // Jika null, undefined, atau empty string, return null
  if (!dateValue) return null;
  
  // Jika sudah Date object, return as-is
  if (dateValue instanceof Date) return dateValue;
  
  // Jika bukan string, return null
  if (typeof dateValue !== 'string') return null;
  
  // Trim whitespace
  const trimmedValue = dateValue.trim();
  if (!trimmedValue) return null;
  
  // Jika format date-only (YYYY-MM-DD), gabungkan dengan waktu local saat ini
  if (trimmedValue.match(/^\d{4}-\d{2}-\d{2}$/)) {
    const now = new Date();
    const [year, month, day] = trimmedValue.split('-').map(Number);
    let hours = now.getHours();
    let minutes = now.getMinutes();
    
    // Hindari midnight (00:00) dengan menambah offset
    if (avoidMidnight && hours === 0 && minutes === 0) {
      minutes = midnightOffset;
    }
    
    return new Date(year, month - 1, day, hours, minutes, now.getSeconds(), now.getMilliseconds());
  }
  
  // Untuk format lain (ISO datetime, dll), parse langsung
  return new Date(trimmedValue);
}

/**
 * Parse multiple date fields dalam object
 * 
 * @param {Object} obj - Object yang berisi date fields
 * @param {string[]} dateFields - Array nama field yang harus di-parse sebagai date
 * @param {Object} options - Parse options (passed to parseDate)
 * @returns {Object} Object yang sama dengan date fields sudah di-convert
 * 
 * @example
 * const data = {
 *   name: "Test",
 *   startDate: "2025-12-15",
 *   endDate: "2025-12-31"
 * };
 * parseDates(data, ['startDate', 'endDate']);
 * // data.startDate dan data.endDate sekarang Date objects
 */
function parseDates(obj, dateFields, options = {}) {
  if (!obj || typeof obj !== 'object') return obj;
  if (!Array.isArray(dateFields)) return obj;
  
  for (const field of dateFields) {
    if (obj[field] !== undefined) {
      obj[field] = parseDate(obj[field], options);
    }
  }
  
  return obj;
}

/**
 * Parse date untuk Prisma DateTime field
 * Alias untuk parseDate, dibuat untuk clarity
 * 
 * @param {string|Date|null|undefined} dateValue
 * @returns {Date|null}
 */
function parsePrismaDate(dateValue) {
  return parseDate(dateValue);
}

/**
 * Get current date with time set to midnight (00:00:00) in local timezone
 * Useful untuk default date values
 * 
 * @returns {Date}
 */
function getLocalMidnight() {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return now;
}

/**
 * Format Date object ke YYYY-MM-DD string
 * 
 * @param {Date} date
 * @returns {string}
 */
function formatDateOnly(date) {
  if (!(date instanceof Date) || isNaN(date)) return null;
  
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  
  return `${year}-${month}-${day}`;
}

module.exports = {
  parseDate,
  parseDates,
  parsePrismaDate,
  getLocalMidnight,
  formatDateOnly,
};
