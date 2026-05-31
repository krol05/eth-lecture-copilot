'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadRenderMarkdownInline() {
  const src = fs.readFileSync(path.join(__dirname, '../sidebar/sidebar.js'), 'utf8');
  const start = src.indexOf('  function renderMarkdownInline');
  const end = src.indexOf('  function persistChat', start);
  const snippet = src.slice(start, end);
  const context = {
    escHtml: (str) => String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;')
  };
  vm.createContext(context);
  vm.runInContext(`${snippet}\nthis.renderMarkdownInline = renderMarkdownInline;`, context);
  return context.renderMarkdownInline;
}

describe('renderMarkdownInline', () => {
  const renderMarkdownInline = loadRenderMarkdownInline();

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
