/**
 * Which guide block covers playback time `t` (seconds).
 *
 * Loaded by the sidebar as a script tag and by Jest via require, so the test
 * and the extension run the same code. It used to be a copy of the sidebar's
 * own version, which meant the test could pass while the real one was broken.
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
