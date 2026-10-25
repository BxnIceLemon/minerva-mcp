import fs from 'node:fs';
import path from 'node:path';
import { BASE_URL, HOST, DOWNLOAD_DIR } from './config.js';
import { loadSession } from './session.js';

export class SessionError extends Error {}

// Signed file downloads redirect to Blackboard's alternate content host
// (alt-<id>.leeds.ac.uk) or CDN hosts; those are followed without the session cookie.
const DOWNLOAD_HOSTS = /(?:^alt-[a-z0-9]+\.leeds\.ac\.uk|(?:^|\.)(?:blackboard\.com|blackboardcdn\.com|amazonaws\.com))$/i;

function resolve(url) {
  const u = new URL(url, BASE_URL);
  if (u.protocol !== 'https:' || u.host !== HOST) {
    throw new Error(`Refusing to send the Minerva session to ${u.host}`);
  }
  return u;
}

function session() {
  const s = loadSession();
  if (!s) throw new SessionError('Not signed in to Minerva. Call the minerva_login tool, or run `npm run login` in the minerva-mcp folder.');
  return s;
}

function headers(s, accept = 'application/json') {
  return {
    Accept: accept,
    Cookie: s.cookies.map((c) => `${c.name}=${c.value}`).join('; '),
    ...(s.xsrf ? { 'X-Blackboard-XSRF': s.xsrf } : {}),
  };
}

// Read-only by construction: this client only ever issues GET requests.
export async function get(pathOrUrl, params) {
  const s = session();
  const u = resolve(pathOrUrl);
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
  }
  const r = await fetch(u, { headers: headers(s), redirect: 'manual' });
  if (r.status === 401 || (r.status >= 300 && r.status < 400)) {
    throw new SessionError('Minerva session expired. Call the minerva_login tool, or run `npm run login` in the minerva-mcp folder.');
  }
  const text = await r.text();
  if (!r.ok) {
    let msg = text;
    try { msg = JSON.parse(text).message ?? text; } catch {}
    throw new Error(`Minerva API ${r.status} for ${u.pathname}: ${msg}`.slice(0, 500));
  }
  return text ? JSON.parse(text) : null;
}

// Follows Blackboard's paging.nextPage links up to `max` results.
export async function getAll(pathOrUrl, params, max = 500) {
  const out = [];
  let page = await get(pathOrUrl, { limit: 100, ...params });
  while (page) {
    out.push(...(page.results ?? []));
    const next = page.paging?.nextPage;
    if (!next || out.length >= max) break;
    page = await get(next);
  }
  return out.slice(0, max);
}

function safeName(name) {
  const base = path.basename(String(name || 'download')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  if (!base || base === '.' || base === '..') return 'download';
  return base;
}

export async function download(pathOrUrl, fileName) {
  const s = session();
  let u = resolve(pathOrUrl);
  let sendCookies = true;
  for (let hop = 0; hop < 6; hop++) {
    const r = await fetch(u, {
      headers: sendCookies ? headers(s, '*/*') : { Accept: '*/*' },
      redirect: 'manual',
    });
    if (r.status >= 300 && r.status < 400) {
      const next = new URL(r.headers.get('location'), u);
      if (next.protocol !== 'https:') throw new Error('Refusing non-HTTPS redirect');
      if (next.host === HOST) {
        if (next.pathname.startsWith('/auth') || next.pathname === '/') {
          throw new SessionError('Minerva session expired. Call the minerva_login tool, or run `npm run login`.');
        }
      } else if (DOWNLOAD_HOSTS.test(next.hostname)) {
        sendCookies = false;
      } else {
        throw new Error(`Refusing to follow redirect to untrusted host ${next.hostname}`);
      }
      u = next;
      continue;
    }
    if (r.status === 401) throw new SessionError('Minerva session expired. Call the minerva_login tool, or run `npm run login`.');
    if (!r.ok) throw new Error(`Download failed with HTTP ${r.status}`);

    const disp = r.headers.get('content-disposition') ?? '';
    const m = disp.match(/filename\*=UTF-8''([^;]+)/i) ?? disp.match(/filename="?([^";]+)"?/i);
    const name = safeName(fileName || (m && decodeURIComponent(m[1])) || path.basename(u.pathname));
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
    const dest = path.join(DOWNLOAD_DIR, name);
    fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
    return { path: dest, bytes: fs.statSync(dest).size, contentType: r.headers.get('content-type') };
  }
  throw new Error('Too many redirects');
}
