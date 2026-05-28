'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadSplitConceptText() {
  const src = fs.readFileSync(path.join(__dirname, '../sidebar/sidebar.js'), 'utf8');
  const start = src.indexOf('  function splitConceptText');
  const end = src.indexOf('  function renderConceptItem', start);
  const snippet = src.slice(start, end).replace('  if (typeof window !== \'undefined\') {\n    window.__ethCopilotSplitConceptText = splitConceptText;\n  }\n\n', '');
  const context = {};
  vm.createContext(context);
  vm.runInContext(`${snippet}\nthis.splitConceptText = splitConceptText;`, context);
  return context.splitConceptText;
}

describe('splitConceptText', () => {
  const splitConceptText = loadSplitConceptText();

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
});
