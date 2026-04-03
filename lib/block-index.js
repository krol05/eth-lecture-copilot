/**
 * Pure: which guide block index matches playback time t (seconds).
 * Mirrors sidebar findBlockIndex logic without DOM state.
 */
function findBlockIndexForTime(blocks, t) {
  if (!blocks || !blocks.length) return 0;
  const n = blocks.length;
  for (let i = 0; i < n; i++) {
    if (t >= blocks[i].start_time && t < blocks[i].end_time) return i;
  }
  if (t >= blocks[n - 1].start_time) return n - 1;
  return 0;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { findBlockIndexForTime };
}
