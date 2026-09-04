'use strict';

const {
  parseVtt,
  parseTimestamp,
  formatTranscriptForAI,
  formatSeconds,
  decodeVttEntities
} = require('../lib/transcript.js');

describe('parseTimestamp', () => {
  test('parses HH:MM:SS.mmm', () => {
    expect(parseTimestamp('01:02:03.500')).toBeCloseTo(3600 + 120 + 3.5, 5);
  });

  test('parses MM:SS.mmm', () => {
    expect(parseTimestamp('02:30.5')).toBeCloseTo(150.5, 5);
  });

  test('anything else is NaN, so the cue gets skipped rather than placed at 0', () => {
    expect(parseTimestamp('nonsense')).toBeNaN();
    expect(parseTimestamp('12')).toBeNaN();
    expect(parseTimestamp('')).toBeNaN();
  });
});

describe('decodeVttEntities', () => {
  test('decodes the escapes WebVTT requires', () => {
    // Captions cannot contain a bare "&", so every ampersand arrives escaped.
    expect(decodeVttEntities('AT&amp;T')).toBe('AT&T');
    expect(decodeVttEntities('&lt;tag&gt;')).toBe('<tag>');
    expect(decodeVttEntities('a&nbsp;b')).toBe('a b');
  });

  test('decodes ampersands last, so a double escape survives', () => {
    expect(decodeVttEntities('&amp;lt;')).toBe('&lt;');
  });

  test('leaves ordinary text alone', () => {
    expect(decodeVttEntities('plain text & nothing')).toBe('plain text & nothing');
  });
});

describe('parseVtt', () => {
  const vtt = [
    'WEBVTT',
    '',
    '1',
    '00:00:01.000 --> 00:00:04.000',
    'First line of the lecture',
    '',
    '00:00:04.000 --> 00:00:07.500 align:start position:10%',
    'Second cue with settings',
    '',
    'NOTE this is a comment block, not a cue',
    '',
    '00:01:30.000 --> 00:01:35.000',
    'Wrapped over',
    'two lines'
  ].join('\n');

  test('reads cues with their times', () => {
    const cues = parseVtt(vtt);
    expect(cues).toHaveLength(3);
    expect(cues[0]).toEqual({ start_time: 1, end_time: 4, text: 'First line of the lecture' });
    expect(cues[2].start_time).toBe(90);
  });

  test('ignores the header and NOTE blocks', () => {
    expect(parseVtt(vtt).some(c => c.text.includes('WEBVTT'))).toBe(false);
    expect(parseVtt(vtt).some(c => c.text.includes('comment block'))).toBe(false);
  });

  test('ignores cue settings after the end time', () => {
    expect(parseVtt(vtt)[1]).toMatchObject({ start_time: 4, end_time: 7.5 });
  });

  test('joins a cue that wraps over several lines', () => {
    expect(parseVtt(vtt)[2].text).toBe('Wrapped over two lines');
  });

  test('strips styling tags but keeps the words', () => {
    const styled = 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n<c.yellow>Bayes</c> <b>rule</b>';
    expect(parseVtt(styled)[0].text).toBe('Bayes rule');
  });

  test('decodes escapes, so no cue reaches the model as raw markup', () => {
    // The content script used to strip tags without decoding, putting the
    // literal text "AT&amp;T" into the transcript and every prompt built on it.
    const escaped = 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nAT&amp;T and 5 &lt; 6';
    expect(parseVtt(escaped)[0].text).toBe('AT&T and 5 < 6');
  });

  test('drops cues with an unreadable timestamp instead of placing them at zero', () => {
    const broken = 'WEBVTT\n\nbogus --> 00:00:01.000\nignored\n\n00:00:02.000 --> 00:00:03.000\nkept';
    expect(parseVtt(broken).map(c => c.text)).toEqual(['kept']);
  });

  test('drops empty cues', () => {
    const empty = 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n<c.x></c>\n\n00:00:01.000 --> 00:00:02.000\nreal';
    expect(parseVtt(empty).map(c => c.text)).toEqual(['real']);
  });

  test('handles Windows line endings', () => {
    const crlf = 'WEBVTT\r\n\r\n00:00:01.000 --> 00:00:02.000\r\nline';
    expect(parseVtt(crlf)).toEqual([{ start_time: 1, end_time: 2, text: 'line' }]);
  });

  test('nothing in, nothing out', () => {
    expect(parseVtt('')).toEqual([]);
    expect(parseVtt(null)).toEqual([]);
    expect(parseVtt('WEBVTT')).toEqual([]);
  });
});

describe('formatSeconds', () => {
  test('always HH:MM:SS', () => {
    expect(formatSeconds(0)).toBe('00:00:00');
    expect(formatSeconds(3661.9)).toBe('01:01:01');
    expect(formatSeconds(-5)).toBe('00:00:00');
  });
});

describe('formatTranscriptForAI', () => {
  test('one timestamped line per cue', () => {
    const cues = [
      { start_time: 0, end_time: 2, text: 'hello' },
      { start_time: 90, end_time: 95, text: 'world' }
    ];
    expect(formatTranscriptForAI(cues)).toBe('[00:00:00] hello\n[00:01:30] world');
  });

  test('no cues is an empty string, not a crash', () => {
    expect(formatTranscriptForAI([])).toBe('');
    expect(formatTranscriptForAI(null)).toBe('');
  });
});
