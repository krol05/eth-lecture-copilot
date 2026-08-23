'use strict';

const { renderMarkdownInline, escHtml } = require('../lib/render-inline.js');

describe('renderMarkdownInline', () => {
  test('wraps obvious undelimited exponential math', () => {
    expect(renderMarkdownInline('Euler-Ansatz y = e^{\\lambda t}.'))
      .toContain('$y = e^{\\lambda t}$');
  });

  test('wraps prime equation math without escaping primes inside math', () => {
    expect(renderMarkdownInline("Zuerst wird y'' - y = e^{2t} aufgestellt."))
      .toContain("$y'' - y = e^{2t}$");
  });

  test('does not wrap ordinary prose', () => {
    expect(renderMarkdownInline('Plain sentence without math stays plain.'))
      .toBe('Plain sentence without math stays plain.');
  });

  test('does not wrap letters inside ordinary words', () => {
    expect(renderMarkdownInline('Die Kreisfrequenz omega = 1.'))
      .toBe('Die Kreisfrequenz omega = 1.');
  });

  test('wraps standalone trig commands without swallowing prose', () => {
    expect(renderMarkdownInline('Die Störfunktion ist \\sin(1 \\cdot t).'))
      .toContain('$\\sin(1 \\cdot t)$');
  });

  test('wraps compact raw powers', () => {
    expect(renderMarkdownInline('Der Ansatz muss mit t^m multipliziert werden.'))
      .toContain('$t^m$');
  });
});

describe('escHtml', () => {
  test('escapes HTML-sensitive characters', () => {
    expect(escHtml('<b a="x">&</b>')).toBe('&lt;b a=&quot;x&quot;&gt;&amp;&lt;/b&gt;');
  });

  test('stringifies null and undefined to empty', () => {
    expect(escHtml(null)).toBe('');
    expect(escHtml(undefined)).toBe('');
  });
});
