/**
 * The sidebar's modules all share one global scope — that is what lets each
 * file call the others without an import line. ESLint, though, reads one file
 * at a time, so every cross-file call would look undefined to it.
 *
 * This collects the top-level names the sidebar declares and hands them to
 * eslint.config.mjs as known globals. It is generated from the files rather
 * than hand-listed so it cannot drift; no-undef still catches a call to a name
 * that no module declares, which is the mistake worth catching.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as acorn from 'acorn';

const SIDEBAR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'sidebar');

/** Every top-level declaration in one file: functions, vars, classes. */
function declarationsIn(source, filename) {
  const names = [];
  const ast = acorn.parse(source, { ecmaVersion: 2022, sourceType: 'script' });

  const fromPattern = (node) => {
    if (!node) return;
    switch (node.type) {
      case 'Identifier': names.push(node.name); break;
      case 'ObjectPattern': node.properties.forEach(p =>
        fromPattern(p.type === 'RestElement' ? p.argument : p.value)); break;
      case 'ArrayPattern': node.elements.forEach(fromPattern); break;
      case 'AssignmentPattern': fromPattern(node.left); break;
      case 'RestElement': fromPattern(node.argument); break;
      default: throw new Error(`unhandled pattern ${node.type} in ${filename}`);
    }
  };

  for (const node of ast.body) {
    if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') {
      if (node.id) names.push(node.id.name);
    } else if (node.type === 'VariableDeclaration') {
      node.declarations.forEach(d => fromPattern(d.id));
    }
  }
  return names;
}

/**
 * One ESLint config block per sidebar file, declaring the names the *other*
 * files provide. A file's own declarations are left out — listing a name as
 * both a global and a local declaration is what no-redeclare complains about.
 */
export function sidebarGlobalConfigs() {
  const declsByFile = new Map();
  for (const file of fs.readdirSync(SIDEBAR).filter(f => f.endsWith('.js'))) {
    const source = fs.readFileSync(path.join(SIDEBAR, file), 'utf8');
    declsByFile.set(file, new Set(declarationsIn(source, file)));
  }

  return [...declsByFile.keys()].map(file => {
    const globals = {};
    for (const [other, names] of declsByFile) {
      if (other === file) continue;
      for (const name of names) {
        if (!declsByFile.get(file).has(name)) globals[name] = 'writable';
      }
    }
    return { files: [`sidebar/${file}`], languageOptions: { globals } };
  });
}

// `node scripts/sidebar-globals.mjs` prints what it found, for a quick look.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const block of sidebarGlobalConfigs()) {
    console.log(`${block.files[0]}: sees ${Object.keys(block.languageOptions.globals).length} names from its siblings`);
  }
}
