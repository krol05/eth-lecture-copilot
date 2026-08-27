'use strict';

const { splitConceptText } = require('../lib/concept-split.js');

describe('splitConceptText', () => {
  test('splits a short takeaway sentence from supporting detail', () => {
    expect(splitConceptText('Radical hardware designs can become commercial products. Wafer-scale chips show that ideas once considered impractical can succeed.')).toEqual({
      lead: 'Radical hardware designs can become commercial products.',
      body: 'Wafer-scale chips show that ideas once considered impractical can succeed.'
    });
  });

  test('does not split inside inline LaTeX', () => {
    const text = 'Consider a loop accessing parallel blocks $P_1, P_2, P_3, P_4$ followed by serial blocks $S_1, S_2, S_3$. This setup determines the miss pattern.';
    expect(splitConceptText(text)).toEqual({
      lead: 'Consider a loop accessing parallel blocks $P_1, P_2, P_3, P_4$ followed by serial blocks $S_1, S_2, S_3$.',
      body: 'This setup determines the miss pattern.'
    });
  });

  test('splits overly long one-sentence concepts into lead and body', () => {
    const text = 'Nach dem Einfärben zählt man, wie häufig jede Farbe im Graphen vorkommt, was der Größe der jeweiligen Zusammenhangskomponente entspricht';
    const out = splitConceptText(text);
    expect(out.lead.split(/\s+/).length).toBeLessThanOrEqual(12);
    expect(out.body).toContain('Graphen vorkommt');
  });

  test('does not split at common abbreviation dots', () => {
    const text = 'Für große praktische Anwendungen (z.B. soziale Netzwerke) ist ein quadratischer Algorithmus zu teuer. Man braucht lineare oder nahezu lineare Verfahren.';
    expect(splitConceptText(text)).toEqual({
      lead: 'Für große praktische Anwendungen (z.B. soziale Netzwerke) ist ein quadratischer Algorithmus zu teuer.',
      body: 'Man braucht lineare oder nahezu lineare Verfahren.'
    });
  });
});

// Guides hold key_concepts in two shapes: structured objects (current) and
// plain strings (saved before the schema changed). Assuming strings is what
// broke Markdown export with "c.replace is not a function".
describe('conceptToParts / conceptToText handle both guide shapes', () => {
  const { conceptToParts, conceptToText } = require('../lib/concept-split.js');

  test('structured concept keeps its label, lead and body', () => {
    expect(conceptToParts({ label: 'MOTIVATION', lead: 'Big systems use distributed memory.', body: 'Models over 70B do not fit on one machine.' }))
      .toEqual({ label: 'MOTIVATION', lead: 'Big systems use distributed memory.', body: 'Models over 70B do not fit on one machine.' });
  });

  test('older alternate field names are accepted', () => {
    expect(conceptToParts({ title: 'A lead', text: 'Some body' }))
      .toEqual({ label: '', lead: 'A lead', body: 'Some body' });
  });

  test('a body-only object still yields a lead', () => {
    expect(conceptToParts({ label: 'X', body: 'Only body here.' }))
      .toEqual({ label: 'X', lead: 'Only body here.', body: '' });
  });

  test('plain strings are split like before', () => {
    const parts = conceptToParts('BFS explores level by level. It uses a queue.');
    expect(parts.label).toBe('');
    expect(parts.lead).toBeTruthy();
    expect(`${parts.lead} ${parts.body}`).toContain('BFS explores level by level');
  });

  test('empty and malformed entries never throw', () => {
    for (const bad of [null, undefined, '', {}, [], 42]) {
      expect(() => conceptToParts(bad)).not.toThrow();
      expect(() => conceptToText(bad)).not.toThrow();
    }
    expect(conceptToParts(null)).toEqual({ label: '', lead: '', body: '' });
  });

  test('conceptToText flattens either shape to one line', () => {
    expect(conceptToText({ lead: 'Lead here.', body: 'Body here.' })).toBe('Lead here. Body here.');
    expect(conceptToText('Just a string')).toBe('Just a string');
  });
});
