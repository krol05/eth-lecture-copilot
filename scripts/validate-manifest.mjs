/**
 * Checks manifest.json against the files that actually exist.
 *
 * The extension has no build step, so a renamed or forgotten file shows up as
 * a blank sidebar in Chrome rather than as an error anywhere. This turns that
 * into a failed CI run instead.
 *
 * Run: npm run validate:manifest
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const notes = [];

const fail = (msg) => problems.push(msg);

/** A resource entry may be a glob; check the directory exists in that case. */
function resourceExists(rel) {
  if (!rel.includes('*')) return fs.existsSync(path.join(ROOT, rel));
  const dir = path.join(ROOT, path.dirname(rel.replace(/\*.*$/, '')));
  return fs.existsSync(dir);
}

// ─── Parse ───────────────────────────────────────────────────────────────────

const manifestPath = path.join(ROOT, 'manifest.json');
if (!fs.existsSync(manifestPath)) {
  console.error('manifest.json is missing');
  process.exit(1);
}

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
} catch (err) {
  console.error(`manifest.json is not valid JSON: ${err.message}`);
  process.exit(1);
}

// ─── Required keys ───────────────────────────────────────────────────────────

if (manifest.manifest_version !== 3) fail(`manifest_version must be 3, found ${manifest.manifest_version}`);
for (const key of ['name', 'version']) {
  if (!manifest[key]) fail(`missing required key: ${key}`);
}
if (manifest.version && !/^\d+(\.\d+){0,3}$/.test(manifest.version)) {
  fail(`version "${manifest.version}" is not a valid Chrome version string`);
}

// Anything not on this list is either a typo or something worth noticing.
const KNOWN_KEYS = new Set([
  'manifest_version', 'name', 'version', 'description', 'icons', 'action',
  'background', 'content_scripts', 'permissions', 'optional_permissions',
  'host_permissions', 'optional_host_permissions', 'web_accessible_resources',
  'options_page', 'options_ui', 'commands', 'content_security_policy',
  'default_locale', 'minimum_chrome_version', 'homepage_url', 'author',
  'short_name', 'incognito', 'storage', 'declarative_net_request'
]);
for (const key of Object.keys(manifest)) {
  if (!KNOWN_KEYS.has(key)) fail(`unrecognised manifest key: "${key}"`);
}

// ─── Every referenced file exists ────────────────────────────────────────────

const seen = new Set();
const checkFile = (rel, where) => {
  seen.add(rel);
  if (!fs.existsSync(path.join(ROOT, rel))) fail(`${where} refers to a missing file: ${rel}`);
};

if (manifest.background?.service_worker) {
  checkFile(manifest.background.service_worker, 'background.service_worker');
}
for (const [size, file] of Object.entries(manifest.icons || {})) {
  checkFile(file, `icons["${size}"]`);
}
for (const [size, file] of Object.entries(manifest.action?.default_icon || {})) {
  checkFile(file, `action.default_icon["${size}"]`);
}
if (manifest.action?.default_popup) checkFile(manifest.action.default_popup, 'action.default_popup');
if (manifest.options_page) checkFile(manifest.options_page, 'options_page');

(manifest.content_scripts || []).forEach((cs, i) => {
  (cs.js || []).forEach(f => checkFile(f, `content_scripts[${i}].js`));
  (cs.css || []).forEach(f => checkFile(f, `content_scripts[${i}].css`));
  if (!cs.matches?.length) fail(`content_scripts[${i}] has no matches`);
});

(manifest.web_accessible_resources || []).forEach((group, i) => {
  if (!group.matches?.length) fail(`web_accessible_resources[${i}] has no matches`);
  (group.resources || []).forEach(rel => {
    seen.add(rel);
    if (!resourceExists(rel)) fail(`web_accessible_resources[${i}] refers to a missing file: ${rel}`);
  });
});

// ─── Every file the pages load is reachable ──────────────────────────────────
//
// A sidebar script tag pointing at something not in web_accessible_resources
// loads fine in some contexts and is blocked in others, which is a miserable
// bug to track down. Check it here instead.

const reachable = new Set(
  (manifest.web_accessible_resources || []).flatMap(g => g.resources || [])
);

for (const page of ['sidebar/sidebar.html', 'popup/popup.html', 'ui/ui-settings.html']) {
  const full = path.join(ROOT, page);
  if (!fs.existsSync(full)) continue;
  const html = fs.readFileSync(full, 'utf8');
  const dir = path.dirname(page);
  for (const [, src] of html.matchAll(/<script\s+src="([^"]+)"/g)) {
    const rel = path.normalize(path.join(dir, src)).replace(/\\/g, '/');
    if (!fs.existsSync(path.join(ROOT, rel))) {
      fail(`${page} loads a script that does not exist: ${src}`);
      continue;
    }
    // An extension page may load any extension file, so this is not a bug —
    // but every other sidebar script is listed, and the odd one out is usually
    // a file someone forgot when adding it. Worth saying, not worth failing.
    if (page.startsWith('sidebar/') && !reachable.has(rel) && !rel.startsWith('lib/katex/')) {
      notes.push(`${page} loads ${rel}, which is not listed in web_accessible_resources (every other one is)`);
    }
  }
  for (const [, href] of html.matchAll(/<link[^>]+href="([^"]+\.css)"/g)) {
    const rel = path.normalize(path.join(dir, href)).replace(/\\/g, '/');
    if (!fs.existsSync(path.join(ROOT, rel))) {
      fail(`${page} links a stylesheet that does not exist: ${href}`);
    }
  }
}

// ─── Permissions sanity ──────────────────────────────────────────────────────

const required = manifest.host_permissions || [];
const broad = required.filter(p => p === '<all_urls>' || /^\*:\/\/\*\/|^https?:\/\/\*\/\*$/.test(p));
if (broad.length) {
  fail(`host_permissions asks for everything at install time: ${broad.join(', ')} — these belong in optional_host_permissions`);
}
if ((manifest.permissions || []).includes('<all_urls>')) {
  fail('"<all_urls>" is a host permission, not an API permission');
}
if (required.length) {
  notes.push(`install warning will name: ${required.join(', ')}`);
}

// ─── Commands ────────────────────────────────────────────────────────────────

for (const [name, cmd] of Object.entries(manifest.commands || {})) {
  if (!cmd.description && name !== '_execute_action') fail(`command "${name}" has no description`);
}

// ─── Report ──────────────────────────────────────────────────────────────────

if (problems.length) {
  console.error(`manifest.json: ${problems.length} problem${problems.length === 1 ? '' : 's'}\n`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(`manifest.json is valid — ${seen.size} referenced files all exist.`);
for (const n of notes) console.log(`  note: ${n}`);
