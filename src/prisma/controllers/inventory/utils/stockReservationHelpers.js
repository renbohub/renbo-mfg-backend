const {
  normalizeText,
  parseLegacySpecIdentity,
  sanitizeItemIdentityFields,
  resolveItemIdentity: resolveItemIdentityWithFallback,
  IDENTITY_REQUIRED_MESSAGE,
  hasItemIdentity,
  buildIdentityWhere,
} = require("./itemIdentity");

const SPECIAL_RACK_PREFIXES = ["RACK-SCRAP", "RACK-REJECT", "RACK-REWORK"];

const isSpecialRackCode = (rackCode) => {
  const normalizedRackCode = normalizeText(rackCode).toUpperCase();
  return SPECIAL_RACK_PREFIXES.some((prefix) =>
    normalizedRackCode.startsWith(prefix),
  );
};

const buildExcludeSpecialRackCondition = () => ({
  NOT: {
    OR: SPECIAL_RACK_PREFIXES.map((prefix) => ({
      rackCode: { startsWith: prefix, mode: "insensitive" },
    })),
  },
});

const resolveReservationBalanceWhere = (
  reservation,
  { excludeSpecialRacks = false } = {},
) => {
  let where;

  if (reservation.stockBalanceId) {
    where = { id: reservation.stockBalanceId };
  } else {
    const identityWhere = buildIdentityWhere({
      partCode: reservation.partCode,
      productId: reservation.productId,
      description: reservation.description,
      spec: reservation.spec,
      thickness: reservation.thickness,
      width: reservation.width,
      CSP: reservation.CSP,
      partNumber: reservation.partNumber,
    });

    where = {
      warehouseCode: reservation.warehouseCode,
      rackCode: reservation.rackCode || null,
      lotNumber: reservation.lotNumber || null,
      ...identityWhere,
      isDeleted: false,
    };
  }

  if (!excludeSpecialRacks) {
    return where;
  }

  return {
    AND: [where, buildExcludeSpecialRackCondition()],
  };
};

const generateReservationNumber = async (db, reservationDate) => {
  const baseDate = reservationDate ? new Date(reservationDate) : new Date();
  const dateStr = baseDate.toISOString().split("T")[0].replace(/-/g, "");

  const lastReservation = await db.stockReservation.findFirst({
    where: {
      reservationNumber: { startsWith: `RSV-${dateStr}-` },
    },
    orderBy: { reservationNumber: "desc" },
    select: { reservationNumber: true },
  });

  let nextSeq = 1;
  if (lastReservation) {
    const match = lastReservation.reservationNumber.match(/-(\d+)$/);
    if (match) {
      nextSeq = parseInt(match[1], 10) + 1;
    }
  }

  return `RSV-${dateStr}-${String(nextSeq).padStart(4, "0")}`;
};

module.exports = {
  normalizeText,
  parseLegacySpecIdentity,
  sanitizeItemIdentityFields,
  resolveItemIdentityWithFallback,
  IDENTITY_REQUIRED_MESSAGE,
  hasItemIdentity,
  buildIdentityWhere,
  SPECIAL_RACK_PREFIXES,
  isSpecialRackCode,
  buildExcludeSpecialRackCondition,
  resolveReservationBalanceWhere,
  generateReservationNumber,
};
