// HTTP layer for Gradescope. Every request goes to www.gradescope.com only,
// with the saved session cookie. Cookies Gradescope rotates in responses are
// written back so the saved session stays current.
import * as cheerio from 'cheerio';
import { GS_BASE_URL, GS_HOST, GS_SESSION_FILE } from '../config.js';
import { loadSession, saveSession } from '../session.js';
import { SessionError } from '../client.js';

const EXPIRED = 'Gradescope session expired. Run `npm run login:gradescope` (or `gradescope login`) again.';

function session() {
  const s = loadSession(GS_SESSION_FILE);
  if (!s) throw new SessionError('Not signed in to Gradescope. Run `npm run login:gradescope` (or `gradescope login`) first.');
  return s;
}

function resolve(path) {
  const u = new URL(path, GS_BASE_URL);
  if (u.protocol !== 'https:' || u.host !== GS_HOST) {
    throw new Error(`Refusing to send the Gradescope session to ${u.host}`);
  }
  return u;
}

function remember(s, res) {
  const set = res.headers.getSetCookie?.() ?? [];
  if (!set.length) return;
  let changed = false;
  for (const line of set) {
    const [pair, ...attrs] = line.split(';');
    const eq = pair.indexOf('=');
    if (eq < 1) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    const domainAttr = attrs.map((a) => a.trim()).find((a) => /^domain=/i.test(a));
    const domain = domainAttr ? domainAttr.split('=')[1] : GS_HOST;
    if (!(domain.replace(/^\./, '') === GS_HOST || GS_HOST.endsWith(`.${domain.replace(/^\./, '')}`))) continue;
    const existing = s.cookies.find((c) => c.name === name);
    if (existing) {
      if (existing.value !== value) {
        existing.value = value;
        changed = true;
      }
    } else {
      s.cookies.push({ name, value, domain, path: '/' });
      changed = true;
    }
  }
  if (changed) saveSession(s, GS_SESSION_FILE);
}

/**
 * Sends one request. Redirects are never followed automatically: a redirect to
 * the login page means the session expired; any other redirect is returned to
 * the caller (Gradescope answers some form posts with a redirect).
 */
export async function request(method, path, { body, headers = {}, accept = 'text/html' } = {}) {
  const s = session();
  const u = resolve(path);
  const res = await fetch(u, {
    method,
    body,
    redirect: 'manual',
    headers: {
      Accept: accept,
      Cookie: s.cookies.map((c) => `${c.name}=${c.value}`).join('; '),
      ...headers,
    },
  });
  remember(s, res);
  if (res.status >= 300 && res.status < 400) {
    const to = new URL(res.headers.get('location'), u);
    if (to.host === GS_HOST && (to.pathname === '/login' || to.pathname === '/')) throw new SessionError(EXPIRED);
  }
  if (res.status === 401) throw new SessionError(EXPIRED);
  return res;
}

export async function html(path) {
  const res = await request('GET', path);
  if (res.status >= 300 && res.status < 400) {
    throw new Error(`Gradescope redirected ${path} to ${res.headers.get('location')}`);
  }
  if (!res.ok) throw new Error(`Gradescope HTTP ${res.status} for ${path}`);
  return res.text();
}

export async function page(path) {
  return cheerio.load(await html(path));
}

export async function json(path) {
  const res = await request('GET', path, { accept: 'application/json' });
  if (!res.ok) throw new Error(`Gradescope HTTP ${res.status} for ${path}`);
  return res.json();
}

// Rails' per-session CSRF token, read from any page's <meta name="csrf-token">.
export async function csrfToken(path = '/account') {
  const $ = await page(path);
  const token = $('meta[name="csrf-token"]').attr('content');
  if (!token) throw new Error('Could not find the Gradescope CSRF token');
  return token;
}

export { SessionError };
