const SO_FENCE_DAYS_KEY = "SO_DEMAND_TIME_FENCE_DAYS";
const SO_FENCE_HOURS_KEY = "SO_DEMAND_TIME_FENCE_HOURS";

function toNonNegativeInt(value, fallback = 0) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(Math.trunc(num), 0);
}

function buildDefaultSoDemandTimeFence() {
  return {
    // Default: SO demand within 30 days akan di-netting dari forecast
    // Bisa di-override via environment variable atau system setting
    days: toNonNegativeInt(process.env.SO_DEMAND_TIME_FENCE_DAYS, 30),
    hours: toNonNegativeInt(process.env.SO_DEMAND_TIME_FENCE_HOURS, 0),
  };
}

async function getSoDemandTimeFenceSetting(tx) {
  const defaults = buildDefaultSoDemandTimeFence();
  const systemSettingModel = tx?.systemSetting;

  // Backward compatibility:
  // beberapa environment belum punya model SystemSetting di Prisma schema/client.
  // Dalam kondisi itu MRP tetap harus bisa jalan dengan fallback env/default.
  if (!systemSettingModel || typeof systemSettingModel.findMany !== "function") {
    return {
      ...defaults,
      metadata: {
        daySource: "env",
        hourSource: "env",
        dayUpdatedBy: null,
        hourUpdatedBy: null,
        dayUpdatedAt: null,
        hourUpdatedAt: null,
        fallbackReason: "systemSetting model is unavailable in Prisma client",
      },
    };
  }

  const rows = await systemSettingModel.findMany({
    where: {
      settingKey: { in: [SO_FENCE_DAYS_KEY, SO_FENCE_HOURS_KEY] },
      isDeleted: false,
    },
    select: {
      settingKey: true,
      settingValue: true,
      updatedBy: true,
      updatedAt: true,
    },
  });

  const map = Object.fromEntries(rows.map((row) => [row.settingKey, row]));

  return {
    days: toNonNegativeInt(map[SO_FENCE_DAYS_KEY]?.settingValue, defaults.days),
    hours: toNonNegativeInt(map[SO_FENCE_HOURS_KEY]?.settingValue, defaults.hours),
    metadata: {
      daySource: map[SO_FENCE_DAYS_KEY] ? "db" : "env",
      hourSource: map[SO_FENCE_HOURS_KEY] ? "db" : "env",
      dayUpdatedBy: map[SO_FENCE_DAYS_KEY]?.updatedBy || null,
      hourUpdatedBy: map[SO_FENCE_HOURS_KEY]?.updatedBy || null,
      dayUpdatedAt: map[SO_FENCE_DAYS_KEY]?.updatedAt || null,
      hourUpdatedAt: map[SO_FENCE_HOURS_KEY]?.updatedAt || null,
    },
  };
}

async function upsertSoDemandTimeFenceSetting(tx, payload) {
  const days = toNonNegativeInt(payload?.days, 0);
  const hours = toNonNegativeInt(payload?.hours, 0);
  const updatedBy = payload?.updatedBy || "system";
  const systemSettingModel = tx?.systemSetting;

  if (!systemSettingModel || typeof systemSettingModel.upsert !== "function") {
    throw new Error(
      "SystemSetting model belum tersedia di Prisma client. Tambahkan model SystemSetting ke schema.prisma lalu generate ulang Prisma client."
    );
  }

  await systemSettingModel.upsert({
    where: { settingKey: SO_FENCE_DAYS_KEY },
    update: {
      settingValue: String(days),
      updatedBy,
      isDeleted: false,
    },
    create: {
      settingKey: SO_FENCE_DAYS_KEY,
      settingValue: String(days),
      description: "Batas hari netting demand SO terhadap forecast/MPS",
      updatedBy,
    },
  });

  await systemSettingModel.upsert({
    where: { settingKey: SO_FENCE_HOURS_KEY },
    update: {
      settingValue: String(hours),
      updatedBy,
      isDeleted: false,
    },
    create: {
      settingKey: SO_FENCE_HOURS_KEY,
      settingValue: String(hours),
      description: "Batas jam tambahan netting demand SO terhadap forecast/MPS",
      updatedBy,
    },
  });

  return { days, hours };
}

module.exports = {
  SO_FENCE_DAYS_KEY,
  SO_FENCE_HOURS_KEY,
  toNonNegativeInt,
  buildDefaultSoDemandTimeFence,
  getSoDemandTimeFenceSetting,
  upsertSoDemandTimeFenceSetting,
};
