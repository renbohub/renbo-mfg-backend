"use strict";

function queueError(code, message) {
  return Object.assign(new Error(message), { statusCode: 429, status: 429, code });
}

function createAiRequestQueue({ maxGlobalPending = 20, maxUserPending = 2 } = {}) {
  const pending = [];
  let sequence = 0;

  function ordered() {
    pending.sort((left, right) => {
      const priorityDelta = Number(left.priority || 100) - Number(right.priority || 100);
      return priorityDelta || left.__sequence - right.__sequence;
    });
  }

  function enqueue(job) {
    if (!job?.id || !job?.userId) throw new TypeError("AI queue job membutuhkan id dan userId.");
    if (pending.some((row) => row.id === job.id)) {
      throw queueError("AI_REQUEST_DUPLICATE", "Request AI sudah berada di antrean.");
    }
    if (pending.length >= maxGlobalPending) {
      throw queueError("AI_QUEUE_FULL", "Antrean AI sedang penuh.");
    }
    if (pending.filter((row) => row.userId === job.userId).length >= maxUserPending) {
      throw queueError("AI_USER_QUEUE_FULL", "Batas antrean AI pengguna tercapai.");
    }
    const stored = { ...job, __sequence: sequence++ };
    pending.push(stored);
    ordered();
    return stored;
  }

  function takeNext() {
    ordered();
    return pending.shift() || null;
  }

  function cancel(id, userId) {
    const index = pending.findIndex((job) => job.id === id && job.userId === userId);
    if (index < 0) return false;
    pending.splice(index, 1);
    return true;
  }

  function position(id) {
    ordered();
    const index = pending.findIndex((job) => job.id === id);
    return index < 0 ? null : index + 1;
  }

  return {
    enqueue,
    takeNext,
    cancel,
    position,
    size: () => pending.length,
    countForUser: (userId) => pending.filter((row) => row.userId === userId).length,
    snapshot: () => pending.map(({ __sequence, ...job }) => ({ ...job })),
  };
}

module.exports = { createAiRequestQueue };
