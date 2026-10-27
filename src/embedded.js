// Files embedded in an Ultra document's HTML body. Ultra stores these inline
// (as <a>/<img> tags with a data-bbfile JSON blob) rather than as REST
// attachments, so the attachments endpoint never lists them.
import * as cheerio from 'cheerio';
import path from 'node:path';
import { BASE_URL, HOST } from './config.js';

// Only same-host content-system links are downloadable with the session.
function minervaFileUrl(href) {
  if (!href) return null;
  let u;
  try { u = new URL(href, BASE_URL); } catch { return null; }
  if (u.protocol !== 'https:' || u.host !== HOST || !u.pathname.startsWith('/bbcswebdav/')) return null;
  return u.toString();
}

function nameFromUrl(url) {
  try { return decodeURIComponent(path.basename(new URL(url).pathname)); } catch { return undefined; }
}

// Returns [{ fileName, mimeType, url }] in document order, without duplicates.
export function parseEmbeddedFiles(html) {
  if (!html || !String(html).includes('bbcswebdav')) return [];
  const $ = cheerio.load(String(html));
  const out = [];
  const seen = new Set();
  $('[data-bbfile], a[href*="/bbcswebdav/"], img[src*="/bbcswebdav/"]').each((_, el) => {
    const $el = $(el);
    let meta = {};
    try { meta = JSON.parse($el.attr('data-bbfile') ?? '{}') ?? {}; } catch {}
    const url = minervaFileUrl(meta.resourceUrl) ?? minervaFileUrl($el.attr('href')) ?? minervaFileUrl($el.attr('src'));
    if (!url) return;
    const key = new URL(url).pathname;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      fileName: meta.displayName || meta.linkName || $el.text().trim() || $el.attr('alt') || nameFromUrl(url),
      mimeType: meta.mimeType,
      url,
    });
  });
  return out;
}
