const { stopStreamFlush, scheduleStreamFlush } = require('../lib/qa-stream-flush.js');

describe('qa-stream-flush', () => {
  test('stopStreamFlush marks finalized and cancels pending rAF', () => {
    const cancelled = [];
    global.cancelAnimationFrame = (id) => { cancelled.push(id); };
    const state = { rafPending: true, rafHandle: 42, finalized: false };
    stopStreamFlush(state);
    expect(state.finalized).toBe(true);
    expect(state.rafPending).toBe(false);
    expect(state.rafHandle).toBeNull();
    expect(cancelled).toEqual([42]);
  });

  test('scheduleStreamFlush does not run after stopStreamFlush', () => {
    const state = { finalized: false, rafPending: false };
    let ran = 0;
    global.requestAnimationFrame = (fn) => { fn(); return 1; };
    scheduleStreamFlush(state, () => { ran += 1; });
    expect(ran).toBe(1);
    stopStreamFlush(state);
    scheduleStreamFlush(state, () => { ran += 1; });
    expect(ran).toBe(1);
  });

  test('scheduled flush skips when finalized before rAF runs', () => {
    const state = { finalized: false, rafPending: false };
    let ran = 0;
    global.requestAnimationFrame = (fn) => {
      stopStreamFlush(state);
      fn();
      return 7;
    };
    scheduleStreamFlush(state, () => { ran += 1; });
    expect(ran).toBe(0);
  });
});
