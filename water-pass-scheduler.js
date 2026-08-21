// One application-frame scheduler for water's nested reflection and caustic renders.
// Both passes keep their own cadence, but only one may consume a frame's heavy-pass slot.

const normalizeRate = (value) => Math.max(1, Math.round(Number(value) || 1));

export function createWaterHeavyPassScheduler({ reflectionEvery = 1, causticEvery = 1 } = {}) {
  const rates = {
    reflection: normalizeRate(reflectionEvery),
    caustic: normalizeRate(causticEvery),
  };
  const pending = { reflection: false, caustic: false };
  let frame = -1;
  let scheduled = null;
  let completed = false;
  let lastCompleted = null;

  function beginFrame({ reflectionEnabled = true, causticEnabled = true } = {}) {
    frame++;
    completed = false;

    if (!reflectionEnabled) pending.reflection = false;
    else if (frame % rates.reflection === 0) pending.reflection = true;

    if (!causticEnabled) pending.caustic = false;
    else if (frame % rates.caustic === 0) pending.caustic = true;

    if (pending.reflection && pending.caustic) {
      // Alternate collision winners. This also prevents starvation when both rates are 1.
      scheduled = lastCompleted === 'reflection' ? 'caustic' : 'reflection';
    } else if (pending.reflection) {
      scheduled = 'reflection';
    } else if (pending.caustic) {
      scheduled = 'caustic';
    } else {
      scheduled = null;
    }
    return scheduled;
  }

  function shouldRun(kind) {
    return !completed && scheduled === kind;
  }

  function complete(kind) {
    if (!shouldRun(kind)) return false;
    pending[kind] = false;
    completed = true;
    lastCompleted = kind;
    return true;
  }

  function setRate(kind, value) {
    if (!(kind in rates)) throw new Error(`unknown water pass: ${kind}`);
    rates[kind] = normalizeRate(value);
    pending[kind] = true;
  }

  return {
    beginFrame,
    shouldRun,
    complete,
    setRate,
    isPending: (kind) => !!pending[kind],
    get frame() { return frame; },
    get scheduled() { return scheduled; },
    get rates() { return { ...rates }; },
  };
}
