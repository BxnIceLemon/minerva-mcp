import fs from 'node:fs';
import { DATA_DIR, SESSION_FILE, HOST } from './config.js';

export function loadSession() {
  if (!fs.existsSync(SESSION_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
  } catch {
    return null;
  }
}

export function saveSession(session) {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2), { mode: 0o600 });
}

export function clearSession() {
  fs.rmSync(SESSION_FILE, { force: true });
}

// Only cookies scoped to the Minerva host are kept; Microsoft SSO cookies stay
// in the browser profile and never reach the API client.
export function minervaCookies(cookies) {
  return cookies.filter((c) => {
    const domain = c.domain.replace(/^\./, '');
    return domain === HOST || HOST.endsWith(`.${domain}`);
  });
}

// BbRouter looks like "expires:1760000000,id:...,xsrf:...,timeout:10800".
export function bbRouterField(cookies, field) {
  const bb = cookies.find((c) => c.name === 'BbRouter');
  const m = bb?.value.match(new RegExp(`${field}:([^,]+)`));
  return m ? m[1] : undefined;
}
