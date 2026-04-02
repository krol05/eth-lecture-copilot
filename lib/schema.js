/**
 * schema.js
 * Validates and sanitizes the AI-generated lecture guide JSON.
 */

/**
 * Parse the raw AI response string into a guide object.
 * Handles common issues: markdown fences, leading text, trailing garbage.
 *
 * @param {string} raw
 * @returns {object} parsed guide
 * @throws {Error} if parsing fails after cleanup
 */
function parseGuideResponse(raw) {
  let text = raw.trim();

  // Strip markdown code fences (```json ... ``` or ``` ... ```)
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');

  // Find the first { to handle any leading explanation text
  const start = text.indexOf('{');
  if (start === -1) throw new Error('No JSON object found in response');
  text = text.slice(start);

  // Find matching closing brace
  const end = findMatchingBrace(text);
  if (end !== -1) text = text.slice(0, end + 1);

  return JSON.parse(text);
}

/**
 * Find the position of the closing brace that matches the first { in a string.
 */
function findMatchingBrace(str) {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (escape) { escape = false; continue; }
    if (c === '\\' && inString) { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{') depth++;
    if (c === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/**
 * Validate a parsed guide object against the expected schema.
 * Returns { valid: bool, errors: string[] }.
 */
function validateGuide(guide) {
  const errors = [];

  if (typeof guide !== 'object' || guide === null) {
    return { valid: false, errors: ['Guide is not an object'] };
  }

  if (typeof guide.lecture_title !== 'string' || !guide.lecture_title) {
    errors.push('Missing or invalid lecture_title');
  }

  if (typeof guide.total_duration_seconds !== 'number') {
    errors.push('Missing or invalid total_duration_seconds');
  }

  if (!Array.isArray(guide.guide)) {
    errors.push('Missing guide array');
    return { valid: false, errors };
  }

  if (guide.guide.length === 0) {
    errors.push('Guide array is empty');
  }

  guide.guide.forEach((block, i) => {
    if (typeof block.start_time !== 'number') errors.push(`Block ${i}: missing start_time`);
    if (typeof block.end_time !== 'number') errors.push(`Block ${i}: missing end_time`);
    if (typeof block.title !== 'string' || !block.title) errors.push(`Block ${i}: missing title`);
    if (!Array.isArray(block.key_concepts)) errors.push(`Block ${i}: key_concepts must be array`);
    if (!Array.isArray(block.formulas)) errors.push(`Block ${i}: formulas must be array`);
    if (!Array.isArray(block.definitions)) errors.push(`Block ${i}: definitions must be array`);

    block.formulas?.forEach((f, fi) => {
      if (typeof f.label !== 'string') errors.push(`Block ${i} formula ${fi}: missing label`);
      if (typeof f.latex !== 'string') errors.push(`Block ${i} formula ${fi}: missing latex`);
    });

    block.definitions?.forEach((d, di) => {
      if (typeof d.term !== 'string') errors.push(`Block ${i} def ${di}: missing term`);
      if (typeof d.definition !== 'string') errors.push(`Block ${i} def ${di}: missing definition`);
    });
  });

  return { valid: errors.length === 0, errors };
}

/**
 * Sanitize a guide: fill in missing optional fields with defaults.
 */
function sanitizeGuide(guide) {
  if (!Array.isArray(guide.guide)) return guide;

  guide.guide = guide.guide.map(block => ({
    start_time: block.start_time ?? 0,
    end_time: block.end_time ?? 0,
    title: block.title ?? 'Untitled Section',
    key_concepts: Array.isArray(block.key_concepts) ? block.key_concepts : [],
    formulas: Array.isArray(block.formulas) ? block.formulas : [],
    definitions: Array.isArray(block.definitions) ? block.definitions : [],
    notes: typeof block.notes === 'string' ? block.notes : ''
  }));

  return guide;
}

/**
 * Find the guide block that covers a given video timestamp (in seconds).
 * Returns the last block if past the end, first block if before the start.
 *
 * @param {object} guide — parsed guide object
 * @param {number} currentTime — seconds
 * @returns {object|null} guide block
 */
function getBlockForTime(guide, currentTime) {
  if (!guide?.guide?.length) return null;

  const blocks = guide.guide;

  // Find block where start_time <= currentTime < end_time
  for (const block of blocks) {
    if (currentTime >= block.start_time && currentTime < block.end_time) {
      return block;
    }
  }

  // If past the last block, return the last one
  if (currentTime >= blocks[blocks.length - 1].start_time) {
    return blocks[blocks.length - 1];
  }

  // Before everything, return first
  return blocks[0];
}

if (typeof module !== 'undefined') {
  module.exports = { parseGuideResponse, validateGuide, sanitizeGuide, getBlockForTime };
}
