const { prisma } = require("../index");
const {
  activityEvent,
  classifyAlarm,
  resolvePageContext,
  safeLogDetails,
} = require("../utils/pageContext");

function lowerFirst(value) {
  if (!value || typeof value !== "string") return value;
  return value.charAt(0).toLowerCase() + value.slice(1);
}

function resolveModelAccessor(modelName) {
  if (!modelName) return null;
  return prisma[modelName] || prisma[lowerFirst(modelName)] || null;
}

function resolveIdentifier(req, nameRoute, options = {}) {
  const paramKey = options.paramKey;
  if (paramKey && req.params?.[paramKey] != null) {
    return { key: options.whereKey || paramKey, value: req.params[paramKey] };
  }

  const fallbackPairs = [
    ["id", "id"],
    ["noReg", "noReg"],
    ["code", "code"],
    [`${nameRoute}Code`, `${nameRoute}Code`],
  ];

  for (const [param, whereKey] of fallbackPairs) {
    if (req.params?.[param] != null) {
      return { key: options.whereKey || whereKey, value: req.params[param] };
    }
  }

  const dynamicParamEntries = Object.entries(req.params || {});
  if (dynamicParamEntries.length === 1) {
    const [onlyKey, onlyValue] = dynamicParamEntries[0];
    return { key: options.whereKey || onlyKey, value: onlyValue };
  }

  return { key: options.whereKey || "id", value: null };
}

/**
 * Extract client IP address dari request
 */
function getClientIp(req) {
  return (
    req.ip ||
    req.headers["x-forwarded-for"]?.split(",")[0] ||
    req.headers["x-real-ip"] ||
    req.connection?.remoteAddress ||
    req.socket?.remoteAddress ||
    null
  );
}

/**
 * Middleware untuk logging global dengan auto-track ALL fields
 * Fetch old data sekali, attach ke req.oldData, track changes otomatis
 *
 * @param {string} nameRoute - Nama route untuk identifikasi (e.g., 'bom', 'customer', 'supplier')
 * @param {string} action - Action yang dilakukan (e.g., 'create', 'update', 'delete')
 * @param {object} options - Optional config:
 *   - modelName: Prisma model name (e.g., 'bOMHeader', 'customer')
 *   - includeOptions: Custom Prisma include untuk fetch relations (e.g., { details: { include: { part: true } } })
 *   - getEntityId: Custom function untuk extract entity ID
 *   - fieldsToSkip: Additional fields to skip in comparison
 */
const logger = (nameRoute, action = "read", options = {}) => {
  return async (req, res, next) => {
    req.activityLoggerAttached = true;
    const startTime = Date.now();

    // Untuk UPDATE: fetch old data sekali dan attach ke req (avoid double fetch di controller)
    if (action === "update" && options.modelName) {
      try {
        const { key: whereKey, value: identifier } = resolveIdentifier(
          req,
          nameRoute,
          options
        );
        if (identifier) {
          const model = resolveModelAccessor(options.modelName);
          if (!model) {
            throw new Error(`Model ${options.modelName} tidak ditemukan di Prisma client`);
          }

          // Use custom includeOptions if provided (fully customizable per route)
          const includeOptions = options.includeOptions || {};

          req.oldData = await model.findUnique({
            where: { [whereKey]: identifier },
            include:
              Object.keys(includeOptions).length > 0
                ? includeOptions
                : undefined,
          });
        }
      } catch (fetchError) {
        console.error(
          "Failed to fetch old data for logging:",
          fetchError.message
        );
      }
    }

    // Capture original res.json untuk intercept response
    const originalJson = res.json.bind(res);

    // Override res.json untuk capture response data
    res.json = function (data) {
      const responseTime = Date.now() - startTime;

      // Simpan log ke database (async, tidak block response)
      setImmediate(async () => {
        try {
          // Extract entity ID (bisa dari response, params, atau body)
          let entityId = null;
          if (typeof options.getEntityId === "function") {
            entityId = options.getEntityId(req, data);
          } else {
            const { value: identifierValue } = resolveIdentifier(req, nameRoute, options);
            // For delete/bulk-remove: prioritize request params/body
            if (action === "delete" || action === "bulk-remove") {
              // Bulk-remove: fetch data untuk ambil noReg/code yang readable
              if (
                req.body?.ids &&
                Array.isArray(req.body.ids) &&
                options.modelName
              ) {
                try {
                  const model = prisma[options.modelName];

                  // Fetch items - akan auto-filter fields yang ada saja
                  const items = await model.findMany({
                    where: { id: { in: req.body.ids } },
                  });

                  // Extract identifier (prioritize noReg > code > id)
                  const identifiers = items.map((item) => {
                    return item.noReg || item.code || item[nameRoute + "Code"];
                  });

                  entityId = identifiers.join(", ");
                } catch (fetchError) {
                  // Fallback: join IDs jika fetch gagal
                  entityId = req.body.ids.join(", ");
                }
              } else {
                // Single delete: use params
                entityId =
                  identifierValue ||
                  req.params?.noReg ||
                  req.params?.code ||
                  req.params?.[nameRoute + "Code"] ||
                  req.params?.id ||
                  null;
              }
            } else {
              // For create/update: prioritize response data
              entityId =
                (options.entityField ? data?.[options.entityField] : null) ||
                data?.noReg ||
                data?.code ||
                data?.[nameRoute + "Code"] ||
                data?.id ||
                identifierValue ||
                req.params?.noReg ||
                req.params?.code ||
                req.params?.[nameRoute + "Code"] ||
                req.params?.id ||
                null;
            }
          }

          // Auto-track changes untuk update (ALL FIELDS)
          let changes = null;
          if (action === "update" && req.oldData && data) {
            console.log("🔍 Tracking changes...");
            console.log(
              "OLD has details?",
              Array.isArray(req.oldData.details),
              req.oldData.details?.length
            );
            console.log(
              "NEW has details?",
              Array.isArray(data.details),
              data.details?.length
            );
            if (req.oldData.details?.length > 0) {
              console.log(
                "OLD detail[0] keys:",
                Object.keys(req.oldData.details[0])
              );
            }
            if (data.details?.length > 0) {
              console.log("NEW detail[0] keys:", Object.keys(data.details[0]));
            }

            changes = autoTrackChanges(req.oldData, data, options.fieldsToSkip);
            console.log("📊 Changes result:", changes);
          }

          const alarmType = classifyAlarm(res.statusCode, data);
          const event = activityEvent(action, req.method, req.originalUrl || req.url, data, res.statusCode);
          const responseDetails = safeLogDetails(data);
          if (responseDetails && (alarmType || event === "NEED_APPROVAL")) {
            changes = {
              ...(changes || {}),
              [alarmType ? "errorDetails" : "workflowDetails"]: responseDetails,
              attemptedAction: action,
            };
          }

          // Prepare log data (optimized for CUD operations only)
          const logData = {
            nameRoute,
            action: alarmType ? (alarmType === "ALARM" ? "BLOCKER" : "ERROR") : (event || action),
            method: req.method,
            url: req.originalUrl || req.url,
            statusCode: res.statusCode,
            responseTime,
            userId: req.user?.id || null,
            username: req.user?.username || null,
            ipAddress: getClientIp(req),
            userAgent: req.get("user-agent") || null,
            entityId,
            requestParams:
              Object.keys(req.params).length > 0 ? req.params : null,
            changes,
            errorMessage:
              res.statusCode >= 400 ? data?.message || "Error occurred" : null,
            ...resolvePageContext(req, entityId),
            logType: alarmType || "ACTIVITY",
          };

          await prisma.log.create({ data: logData });
        } catch (error) {
          // Log error tapi jangan ganggu response ke user
          console.error("Logger middleware error:", error.message);
        }
      });

      return originalJson(data);
    };

    next();
  };
};

/**
 * Auto-track ALL fields yang berubah (tanpa perlu specify fields)
 * Otomatis skip fields yang tidak relevan (id, timestamps, relations, dll)
 * Untuk details/array: track field-level changes per item
 */
function autoTrackChanges(oldData, newData, customSkipFields = []) {
  const DEFAULT_SKIP = new Set([
    "id",
    "createdAt",
    "updatedAt",
    "createdBy",
    "__v",
    "part",
    "uom",
    "material",
    "process",
    "customer",
    "supplier",
    "processes",
    "items",
    "lineItems", // Relations
    ...customSkipFields,
  ]);

  const changes = {};

  // Compare semua fields yang ada di newData
  for (const [key, newValue] of Object.entries(newData)) {
    // Skip fields yang tidak relevan
    if (DEFAULT_SKIP.has(key)) continue;

    const oldValue = oldData[key];

    // Special handling untuk array (details, items, dll)
    if (Array.isArray(newValue) && Array.isArray(oldValue)) {
      const detailChanges = trackArrayChanges(oldValue, newValue);
      if (detailChanges) {
        changes[key] = detailChanges;
      }
      continue;
    }

    // Normalize values untuk comparison
    const normalizedOld = normalizeValue(oldValue);
    const normalizedNew = normalizeValue(newValue);

    // Jika berbeda, track
    if (normalizedOld !== normalizedNew) {
      changes[key] = {
        old: normalizedOld,
        new: normalizedNew,
      };
    }
  }

  return Object.keys(changes).length > 0 ? changes : null;
}

/**
 * Track changes untuk array items (details, lineItems, dll)
 * Return: { created: [...], updated: { id: { field: {old, new} } }, deleted: [...] }
 */
function trackArrayChanges(oldArray, newArray) {
  const result = {
    created: [],
    updated: {},
    deleted: [],
  };

  const DETAIL_SKIP = new Set([
    "id",
    "createdAt",
    "updatedAt",
    "createdBy",
    "__v",
    "part",
    "uom",
    "material",
    "process",
  ]);

  // Build maps untuk efficient lookup
  const oldMap = new Map();
  const newMap = new Map();

  oldArray.forEach((item) => {
    if (item.id) oldMap.set(item.id, item);
  });

  newArray.forEach((item) => {
    if (item.id) newMap.set(item.id, item);
  });

  // Track created items (ada di new, tidak ada di old)
  newArray.forEach((newItem) => {
    if (!newItem.id || !oldMap.has(newItem.id)) {
      // Extract relevant fields only (skip relations/metadata)
      const cleanItem = {};
      for (const [key, value] of Object.entries(newItem)) {
        if (!DETAIL_SKIP.has(key) && value !== undefined && value !== null) {
          cleanItem[key] = normalizeValue(value);
        }
      }
      if (Object.keys(cleanItem).length > 0) {
        result.created.push(cleanItem);
      }
    }
  });

  // Track deleted items (ada di old, tidak ada di new)
  oldArray.forEach((oldItem) => {
    if (oldItem.id && !newMap.has(oldItem.id)) {
      // Extract relevant fields only
      const cleanItem = {};
      for (const [key, value] of Object.entries(oldItem)) {
        if (!DETAIL_SKIP.has(key) && value !== undefined && value !== null) {
          cleanItem[key] = normalizeValue(value);
        }
      }
      if (Object.keys(cleanItem).length > 0) {
        result.deleted.push(cleanItem);
      }
    }
  });

  // Track updated items (ada di both, compare field by field)
  newMap.forEach((newItem, id) => {
    const oldItem = oldMap.get(id);
    if (!oldItem) return;

    const itemChanges = {};

    // Compare each field (hanya yang ada di OLD data untuk avoid false positives)
    for (const [key, oldValue] of Object.entries(oldItem)) {
      if (DETAIL_SKIP.has(key)) continue;

      // Skip jika field tidak ada di newItem (field removed)
      if (!(key in newItem)) continue;

      const newValue = newItem[key];
      const normalizedOld = normalizeValue(oldValue);
      const normalizedNew = normalizeValue(newValue);

      // Hanya track jika BENAR-BENAR berbeda (dan old bukan null/undefined)
      if (normalizedOld !== null && normalizedOld !== normalizedNew) {
        // Untuk field yang end dengan "Id", track full relation object
        if (key.endsWith("Id") && normalizedOld !== normalizedNew) {
          const relationKey = key.replace(/Id$/, ""); // materialId -> material

          // Cek apakah relation object ada di data
          if (oldItem[relationKey] && newItem[relationKey]) {
            itemChanges[relationKey] = {
              old: cleanRelationObject(oldItem[relationKey]),
              new: cleanRelationObject(newItem[relationKey]),
            };
          } else {
            // Fallback: track ID saja jika relation tidak di-include
            itemChanges[key] = {
              old: normalizedOld,
              new: normalizedNew,
            };
          }
        } else {
          // Track non-ID fields as usual
          itemChanges[key] = {
            old: normalizedOld,
            new: normalizedNew,
          };
        }
      }
    }

    if (Object.keys(itemChanges).length > 0) {
      result.updated[id] = itemChanges;
    }
  });

  // Return null jika tidak ada changes
  if (
    result.created.length === 0 &&
    result.deleted.length === 0 &&
    Object.keys(result.updated).length === 0
  ) {
    return null;
  }

  return result;
}

/**
 * Normalize value untuk comparison yang akurat
 */
function normalizeValue(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object" && !Array.isArray(value)) return null; // Skip nested objects
  return value;
}

/**
 * Clean relation object untuk logging (remove circular refs only)
 */
function cleanRelationObject(obj) {
  if (!obj || typeof obj !== "object") return obj;

  const cleaned = {};

  for (const [key, value] of Object.entries(obj)) {
    // Skip nested objects/arrays (avoid circular refs)
    if (typeof value === "object" && value !== null && !Array.isArray(value))
      continue;
    if (Array.isArray(value)) continue;
    cleaned[key] = value;
  }

  return Object.keys(cleaned).length > 0 ? cleaned : obj;
}

module.exports = { logger };
