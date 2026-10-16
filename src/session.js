import fs from 'node:fs';
import { DATA_DIR, SESSION_FILE, HOST } from './config.js';

export function loadSession(file = SESSION_FILE) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function saveSession(session, file = SESSION_FILE) {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(session, null, 2), { mode: 0o600 });
}

export function clearSession(file = SESSION_FILE) {
  fs.rmSync(file, { force: true });
}

// Only cookies scoped to the given host are kept; Microsoft SSO cookies stay
// in the browser profile and never reach the API clients.
export function cookiesFor(cookies, host) {
  return cookies.filter((c) => {
    const domain = c.domain.replace(/^\./, '');
    return domain === host || host.endsWith(`.${domain}`);
  });
}

export function minervaCookies(cookies) {
  return cookiesFor(cookies, HOST);
}

// BbRouter looks like "expires:1760000000,id:...,xsrf:...,timeout:10800".
export function bbRouterField(cookies, field) {
  const bb = cookies.find((c) => c.name === 'BbRouter');
  const m = bb?.value.match(new RegExp(`${field}:([^,]+)`));
  return m ? m[1] : undefined;
}
