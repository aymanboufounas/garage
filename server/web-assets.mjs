import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { ApiError } from './core.mjs';

const versionedTypes = new Set(['.js', '.mjs', '.css', '.html']);

// A release namespace gives the entire relative ES-module graph a new cache key.
// Hash source files rather than Git metadata so ZIP and Docker installs work too.
export function createWebAssets(web) {
  const hash = createHash('sha256');
  function collect(directory, relative = '') {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (name === 'assets/host-photos') continue;
      const filename = join(directory, entry.name);
      if (entry.isDirectory()) collect(filename, name);
      else if (entry.isFile() && versionedTypes.has(extname(entry.name))) {
        const bytes = readFileSync(filename);
        hash.update(`${name.length}:${name}${bytes.length}:`);
        hash.update(bytes);
      }
    }
  }
  collect(web);
  const version = hash.digest('hex').slice(0, 16);
  const prefix = `/__assets/${version}/`;
  function staticPath(path) {
    if (path !== '/__assets' && !path.startsWith('/__assets/')) return path;
    const match = path.match(/^\/__assets\/([a-f0-9]{16})\/(.+)$/);
    if (!match || match[1] !== version) throw new ApiError('Not found.', 404);
    const mapped = '/' + match[2];
    let decoded;
    try { decoded = decodeURIComponent(mapped); } catch { throw new ApiError('Invalid URL.', 400); }
    // Documents keep their canonical unversioned URLs and no-store policy.
    if (extname(decoded) === '.html') throw new ApiError('Not found.', 404);
    return mapped;
  }
  function rewriteAdminHtml(html) {
    return html.replace(/<(?:script|link)\b[^>]*>/gi, tag => {
      const module = /^<script\b/i.test(tag) && /\btype\s*=\s*(['"])module\1/i.test(tag);
      const stylesheet = /^<link\b/i.test(tag) && /\brel\s*=\s*(['"])[^'"]*\bstylesheet\b[^'"]*\1/i.test(tag);
      if (!module && !stylesheet) return tag;
      const attribute = module ? 'src' : 'href';
      return tag.replace(new RegExp(`\\b${attribute}\\s*=\\s*(['"])(.*?)\\1`, 'i'), (whole, quote, value) => {
        if (!value || /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(value)) return whole;
        const url = new URL(value, 'https://assets.invalid/');
        return `${attribute}=${quote}${prefix}${url.pathname.slice(1)}${url.search}${url.hash}${quote}`;
      });
    });
  }
  return { version, prefix, staticPath, rewriteAdminHtml };
}
