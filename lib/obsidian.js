/**
 * Building obsidian:// links for the Markdown export.
 *
 * Obsidian opens a note from a URI, but a URI is not a file transfer: the
 * whole note has to fit in the address. Browsers stop handing an external
 * protocol link to the operating system somewhere around two thousand
 * characters, and a lecture guide is comfortably longer than that.
 *
 * So there are two shapes. A short note goes straight in the link. Anything
 * longer is put on the clipboard and Obsidian is asked to read it from there,
 * which is what `clipboard=true` is for.
 *
 * ALPHA: written against Obsidian's documented URI scheme, not yet verified
 * against a real install.
 */
(function (root) {
  'use strict';

  /**
   * Conservative ceiling for a URI handed to an external application.
   * Chrome has historically truncated or dropped external-protocol links
   * beyond about 2 KB, and a silently truncated note is worse than a
   * clipboard hand-off.
   */
  const URI_LIMIT = 2000;

  /** Trim a path piece so it cannot escape the folder or break the URI. */
  function cleanPathPart(part) {
    return String(part || '')
      .replace(/[\\/]+/g, '/')
      .split('/')
      .map(seg => seg.replace(/[<>:"|?*]/g, '').trim())
      .filter(seg => seg && seg !== '.' && seg !== '..')
      .join('/');
  }

  /** Where the note should land inside the vault, without the .md suffix. */
  function notePath(folder, filename) {
    const name = cleanPathPart(String(filename || 'Lecture guide').replace(/\.md$/i, ''));
    const dir = cleanPathPart(folder);
    return dir ? `${dir}/${name || 'Lecture guide'}` : (name || 'Lecture guide');
  }

  /**
   * Build the link.
   *
   * @param {object}  opts
   * @param {string}  [opts.vault]   vault name; omitted means Obsidian's last used
   * @param {string}  [opts.folder]  folder inside the vault
   * @param {string}  [opts.filename]
   * @param {string}  [opts.content] the Markdown
   * @param {number}  [opts.limit]
   * @returns {{uri:string, usesClipboard:boolean, path:string, length:number}}
   */
  function buildObsidianUri({ vault, folder, filename, content, limit = URI_LIMIT } = {}) {
    const path = notePath(folder, filename);
    const params = [];
    if (vault && String(vault).trim()) {
      params.push(`vault=${encodeURIComponent(String(vault).trim())}`);
    }
    params.push(`file=${encodeURIComponent(path)}`);
    const base = `obsidian://new?${params.join('&')}`;

    const inline = `${base}&content=${encodeURIComponent(String(content || ''))}`;
    if (inline.length <= limit) {
      return { uri: inline, usesClipboard: false, path, length: inline.length };
    }

    const viaClipboard = `${base}&clipboard=true`;
    return { uri: viaClipboard, usesClipboard: true, path, length: viaClipboard.length };
  }

  const api = { URI_LIMIT, buildObsidianUri, notePath, cleanPathPart };

  if (typeof root !== 'undefined') root.Obsidian = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
