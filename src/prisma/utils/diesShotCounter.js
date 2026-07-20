// Utility untuk operasi shot counter Dies secara atomic

async function incrementDiesShotCounter(tx, diesId, shotCount) {
  if (!shotCount || shotCount <= 0) return;

  await tx.dies.update({
    where: { id: diesId },
    data: {
      shotCounter: { increment: shotCount },
    },
  });
}

async function decrementDiesShotCounter(tx, diesId, shotCount) {
  if (!shotCount || shotCount <= 0) return;

  await tx.$executeRaw`
    UPDATE tbl_dies
    SET shot_counter = GREATEST(shot_counter - ${shotCount}, 0)
    WHERE id = ${diesId}
  `;
}

async function adjustDiesShotCounter(tx, diesId, shotDiff) {
  if (!shotDiff || shotDiff === 0) return;

  if (shotDiff > 0) {
    await incrementDiesShotCounter(tx, diesId, shotDiff);
    return;
  }

  await decrementDiesShotCounter(tx, diesId, Math.abs(shotDiff));
}

async function resetDiesShotCounter(tx, diesId) {
  await tx.dies.update({
    where: { id: diesId },
    data: {
      shotCounter: 0,
    },
  });
}

module.exports = {
  incrementDiesShotCounter,
  decrementDiesShotCounter,
  adjustDiesShotCounter,
  resetDiesShotCounter,
};
