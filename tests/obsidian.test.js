'use strict';

const { buildObsidianUri, notePath, cleanPathPart, URI_LIMIT } = require('../lib/obsidian.js');

describe('notePath', () => {
  test('drops the .md, since Obsidian adds it', () => {
    expect(notePath('', 'Week 1.md')).toBe('Week 1');
    expect(notePath('', 'Week 1.MD')).toBe('Week 1');
  });

  test('puts the note in the chosen folder', () => {
    expect(notePath('ETH/Lectures', 'Week 1.md')).toBe('ETH/Lectures/Week 1');
  });

  test('cannot be walked out of the vault', () => {
    // A guide title is model output, so it is not trusted to be a safe path.
    expect(notePath('../../etc', '../evil.md')).toBe('etc/evil');
    expect(notePath('.', './x.md')).toBe('x');
  });

  test('normalises separators and blank segments', () => {
    expect(notePath('ETH//Lectures/', 'Week 1.md')).toBe('ETH/Lectures/Week 1');
    expect(cleanPathPart('\\a\\\\b')).toBe('a/b');
  });

  test('falls back to a usable name when there is nothing to use', () => {
    expect(notePath('', '')).toBe('Lecture guide');
    expect(notePath('', '???.md')).toBe('Lecture guide');
    expect(notePath('Notes', '???.md')).toBe('Notes/Lecture guide');
  });

  test('strips characters a vault path cannot hold', () => {
    expect(notePath('', 'A: "B" | C?.md')).toBe('A B  C');
  });
});

describe('buildObsidianUri', () => {
  test('a short note travels inside the link', () => {
    const res = buildObsidianUri({ vault: 'My Vault', folder: 'ETH', filename: 'W1.md', content: '# Hello' });
    expect(res.usesClipboard).toBe(false);
    expect(res.uri).toContain('vault=My%20Vault');
    expect(res.uri).toContain('file=ETH%2FW1');
    expect(res.uri).toContain('content=%23%20Hello');
  });

  test('no vault named means Obsidian uses whichever was open last', () => {
    expect(buildObsidianUri({ filename: 'W1.md', content: 'x' }).uri).not.toContain('vault=');
    expect(buildObsidianUri({ vault: '   ', filename: 'W1.md', content: 'x' }).uri).not.toContain('vault=');
  });

  test('a real guide is too long for a link and goes via the clipboard', () => {
    // This is the normal case: guides run to tens of kilobytes.
    const res = buildObsidianUri({ filename: 'W1.md', content: '# Guide\n'.repeat(5000) });
    expect(res.usesClipboard).toBe(true);
    expect(res.uri).toContain('clipboard=true');
    expect(res.uri).not.toContain('content=');
    expect(res.uri.length).toBeLessThan(URI_LIMIT);
  });

  test('the switch happens at the limit, not past it', () => {
    const justUnder = buildObsidianUri({ filename: 'n', content: 'a'.repeat(10), limit: 100 });
    expect(justUnder.usesClipboard).toBe(false);
    const justOver = buildObsidianUri({ filename: 'n', content: 'a'.repeat(500), limit: 100 });
    expect(justOver.usesClipboard).toBe(true);
  });

  test('counts the encoded length, not the raw length', () => {
    // Encoding a newline triples it, so the raw size is not what matters.
    const res = buildObsidianUri({ filename: 'n', content: '\n'.repeat(40), limit: 80 });
    expect(res.usesClipboard).toBe(true);
  });

  test('the clipboard link still names where the note goes', () => {
    const res = buildObsidianUri({
      vault: 'V', folder: 'ETH', filename: 'W1.md', content: 'x'.repeat(9000)
    });
    expect(res.uri).toContain('vault=V');
    expect(res.uri).toContain('file=ETH%2FW1');
    expect(res.path).toBe('ETH/W1');
  });

  test('survives being called with nothing', () => {
    const res = buildObsidianUri();
    expect(res.uri.startsWith('obsidian://new?')).toBe(true);
    expect(res.path).toBe('Lecture guide');
  });
});
