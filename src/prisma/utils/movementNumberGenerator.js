// ============================================
// MOVEMENT NUMBER GENERATOR
// ============================================
// Helper untuk generate movement number dengan format:
// IN-20260325-0001, OUT-20260325-0002, TRF-20260325-0001, ADJ-20260325-0001
const { generateConfiguredNumber } = require("../services/numberingService");

async function generateMovementNumber(movementType = "MV", tx = null) {
  const prisma = tx || require("../index").prisma;
  const today = new Date();
  const dateStr = today.toISOString().split("T")[0].replace(/-/g, "");

  let prefix = "MV";
  if (movementType === "IN") prefix = "IN";
  else if (movementType === "OUT") prefix = "OUT";
  else if (movementType === "TRANSFER") prefix = "TRF";
  else if (movementType === "ADJUSTMENT") prefix = "ADJ";

  return generateConfiguredNumber("STOCK_MOVEMENT", { db: prisma, context: { prefix }, fallback: async () => {

  const lastMovement = await prisma.stockMovement.findFirst({
    where: {
      movementNumber: { startsWith: `${prefix}-${dateStr}-` },
    },
    orderBy: { movementNumber: "desc" },
    select: { movementNumber: true },
  });

  let nextSeq = 1;
  if (lastMovement) {
    const match = lastMovement.movementNumber.match(/-(\d+)$/);
    if (match) {
      nextSeq = parseInt(match[1]) + 1;
    }
  }

  return `${prefix}-${dateStr}-${String(nextSeq).padStart(4, "0")}`;
  } });
}

module.exports = { generateMovementNumber };
