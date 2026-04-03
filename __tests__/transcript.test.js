'use strict';

const {
  parseVtt,
  parseTimestamp,
  formatTranscriptForAI,
  findCaptionsUrl,
  buildVttUrl
} = require('../lib/transcript.js');

describe('parseTimestamp', () => {
  test('parses HH:MM:SS.mmm', () => {
    expect(parseTimestamp('01:02:03.500')).toBeCloseTo(3600 + 120 + 3.5, 5);
  });

  test('parses MM:SS.mmm', () => {
    expect(parseTimestamp('02:30.5')).toBeCloseTo(150.5, 5);
  });
});

describe('parseVtt', () => {
  test('parses simple cues and strips tags', () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:03.000
Hello <c.color>world</c>

00:00:05.000 --> 00:00:07.000
Second line`;
    const cues = parseVtt(vtt);
    expect(cues).toHaveLength(2);
    expect(cues[0].start_time).toBe(1);
    expect(cues[0].end_time).toBe(3);
    expect(cues[0].text).toBe('Hello world');
    expect(cues[1].text).toBe('Second line');
  });

  test('returns empty array for empty input', () => {
    expect(parseVtt('')).toEqual([]);
  });
});

describe('formatTranscriptForAI', () => {
  test('formats cues with timestamps', () => {
    const cues = [{ start_time: 65, end_time: 70, text: 'Hi' }];
    expect(formatTranscriptForAI(cues)).toBe('[00:01:05] Hi');
  });
});

describe('findCaptionsUrl', () => {
  test('picks from top-level captions array', () => {
    const url = findCaptionsUrl({
      captions: [{ lang: 'de', url: 'https://example.com/captions.vtt' }]
    });
    expect(url).toBe('https://example.com/captions.vtt');
  });

  test('prefers en or de when present', () => {
    const url = findCaptionsUrl({
      captions: [
        { lang: 'fr', url: 'https://x/fr.vtt' },
        { lang: 'en', url: 'https://x/en.vtt' }
      ]
    });
    expect(url).toBe('https://x/en.vtt');
  });

  test('reads streams[].sources.captions', () => {
    const url = findCaptionsUrl({
      streams: [{ sources: { captions: [{ lang: 'de', src: 'https://z/a.vtt' }] } }]
    });
    expect(url).toBe('https://z/a.vtt');
  });

  test('returns null when no tracks', () => {
    expect(findCaptionsUrl({})).toBeNull();
  });
});

describe('buildVttUrl', () => {
  test('builds known ETH pattern', () => {
    const u = buildVttUrl('event-uuid', 'track-1');
    expect(u).toContain('event-uuid');
    expect(u).toContain('captions-track-1.vtt');
  });
});
