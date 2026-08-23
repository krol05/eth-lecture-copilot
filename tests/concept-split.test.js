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
