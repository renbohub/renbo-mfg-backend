"use strict";

const OPEN_FORECAST_STATUSES = Object.freeze(["Confirmed", "Consumed", "Partial Product"]);

function isOpenForecast(forecast) {
  return Boolean(
    forecast
    && !forecast.isDeleted
    && forecast.isCurrentVersion
    && OPEN_FORECAST_STATUSES.includes(String(forecast.status || "")),
  );
}

module.exports = { OPEN_FORECAST_STATUSES, isOpenForecast };
