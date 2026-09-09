const { prisma } = require("../index");
const clock = require("../utils/businessClock");

exports.getCurrentDate = async (_req, res, next) => {
  try {
    const demoDate = await clock.readDemoDate(prisma);
    res.set("Cache-Control", "no-store").json({ demoDate, enabled: Boolean(demoDate) });
  } catch (error) { next(error); }
};

exports.updateCurrentDate = async (req, res, next) => {
  try {
    const demoDate = clock.validateDate(req.body?.demoDate);
    const data = { settingValue: demoDate || "", isDeleted: false, updatedBy: req.user?.username || "system" };
    await prisma.systemSetting.upsert({
      where: { settingKey: clock.KEY },
      create: { settingKey: clock.KEY, description: "Tanggal acuan demo seluruh pengguna aplikasi", ...data },
      update: data,
    });
    res.json({ demoDate, enabled: Boolean(demoDate) });
  } catch (error) { next(error); }
};
const {
  toNonNegativeInt,
  getSoDemandTimeFenceSetting,
  upsertSoDemandTimeFenceSetting,
} = require("../utils/systemSettings");

exports.getMrpDemandFence = async (req, res, next) => {
  try {
    const settings = await getSoDemandTimeFenceSetting(prisma);

    res.json({
      soDemandTimeFenceDays: settings.days,
      soDemandTimeFenceHours: settings.hours,
      metadata: settings.metadata,
    });
  } catch (error) {
    next(error);
  }
};

exports.updateMrpDemandFence = async (req, res, next) => {
  try {
    const hasDays = req.body?.soDemandTimeFenceDays !== undefined;
    const hasHours = req.body?.soDemandTimeFenceHours !== undefined;

    if (!hasDays && !hasHours) {
      return res.status(400).json({
        message: "soDemandTimeFenceDays atau soDemandTimeFenceHours wajib diisi",
      });
    }

    if (hasDays && Number(req.body.soDemandTimeFenceDays) < 0) {
      return res.status(400).json({
        message: "soDemandTimeFenceDays tidak boleh negatif",
      });
    }

    if (hasHours && Number(req.body.soDemandTimeFenceHours) < 0) {
      return res.status(400).json({
        message: "soDemandTimeFenceHours tidak boleh negatif",
      });
    }

    const current = await getSoDemandTimeFenceSetting(prisma);
    const nextDays = hasDays
      ? toNonNegativeInt(req.body.soDemandTimeFenceDays, current.days)
      : current.days;
    const nextHours = hasHours
      ? toNonNegativeInt(req.body.soDemandTimeFenceHours, current.hours)
      : current.hours;

    const saved = await prisma.$transaction((tx) =>
      upsertSoDemandTimeFenceSetting(tx, {
        days: nextDays,
        hours: nextHours,
        updatedBy: req.user?.username || "system",
      })
    );

    const latest = await getSoDemandTimeFenceSetting(prisma);

    res.json({
      message: "Setting demand time fence MRP berhasil diperbarui",
      soDemandTimeFenceDays: saved.days,
      soDemandTimeFenceHours: saved.hours,
      metadata: latest.metadata,
    });
  } catch (error) {
    next(error);
  }
};
