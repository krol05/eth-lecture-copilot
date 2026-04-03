'use strict';

const { findBlockIndexForTime } = require('../lib/block-index.js');

describe('findBlockIndexForTime', () => {
  const blocks = [
    { start_time: 0, end_time: 60, title: 'A' },
    { start_time: 60, end_time: 120, title: 'B' },
    { start_time: 120, end_time: 180, title: 'C' }
  ];

  test('returns block when t inside range', () => {
    expect(findBlockIndexForTime(blocks, 30)).toBe(0);
    expect(findBlockIndexForTime(blocks, 90)).toBe(1);
  });

  test('at boundary uses start-inclusive rule', () => {
    expect(findBlockIndexForTime(blocks, 60)).toBe(1);
  });

  test('after last block end stays on last block', () => {
    expect(findBlockIndexForTime(blocks, 999)).toBe(2);
  });

  test('empty blocks returns 0', () => {
    expect(findBlockIndexForTime([], 5)).toBe(0);
    expect(findBlockIndexForTime(null, 5)).toBe(0);
  });
});
