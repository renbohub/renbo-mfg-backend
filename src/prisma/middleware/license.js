const { isLicenseValid, getLicenseStatus } = require("../services/licenseService");

function licenseGuard() {
  return async (_req, res, next) => {
    const valid = await isLicenseValid();

    if (valid) return next();

    return res.status(403).json({
      message: "License inactive",
      license: getLicenseStatus(),
    });
  };
}

module.exports = {
  licenseGuard,
};
