// Sign-in flows shared by the CLIs and the MCP server. Each login first tries
// a silent refresh in a hidden window (the browser profile usually still has
// Microsoft's "Stay signed in" state), and only opens a visible window in the
// default browser when the user has to act. Passwords and MFA are typed by the
// user in the browser, except in the opt-in terminal sign-in (src/sso.js),
// where the user types them in the terminal and they go straight into
// Microsoft's and Duo's own forms in a hidden window.
import { BASE_URL, SESSION_FILE, GS_BASE_URL, GS_HOST, GS_SESSION_FILE, GS_SSO_PATH } from './config.js';
import { saveSession, minervaCookies, cookiesFor, bbRouterField } from './session.js';
import { launch, waitFor, plainCookies, chooseBrowser, hasDisplay, LOGIN_TIMEOUT_MS } from './browser.js';
import { driveSignIn } from './sso.js';

const SILENT_TIMEOUT_MS = 15 * 1000;
export const TERMINAL_COMMAND = { minerva: 'npm run login -- --terminal', gradescope: 'gradescope login --terminal' };
const FALLBACK_TTL_MS = 3 * 60 * 60 * 1000;

const services = {
  minerva: {
    label: 'Minerva',
    startUrl: `${BASE_URL}/ultra`,
    async check(context) {
      const r = await context.request.get(`${BASE_URL}/learn/api/public/v1/users/me`, {
        headers: { Accept: 'application/json' },
        failOnStatusCode: false,
      });
      return r.ok() ? r.json() : null;
    },
    async save(context, user) {
      const cookies = minervaCookies(await context.cookies());
      const expiresSec = Number(bbRouterField(cookies, 'expires'));
      const expiresAt = new Date(expiresSec > 0 ? expiresSec * 1000 : Date.now() + FALLBACK_TTL_MS).toISOString();
      saveSession(
        {
          cookies: plainCookies(cookies),
          xsrf: bbRouterField(cookies, 'xsrf') ?? null,
          userId: user.id,
          userName: user.userName,
          displayName: [user.name?.given, user.name?.family].filter(Boolean).join(' ') || user.userName,
          savedAt: new Date().toISOString(),
          expiresAt,
        },
        SESSION_FILE,
      );
      return { userName: user.userName, expiresAt };
    },
  },
  gradescope: {
    label: 'Gradescope',
    // Leeds SSO: silent when Microsoft remembers you, otherwise the familiar
    // University sign-in page. Set GRADESCOPE_SSO_PATH='' for the plain login page.
    startUrl: GS_SSO_PATH ? `${GS_BASE_URL}${GS_SSO_PATH}` : `${GS_BASE_URL}/login`,
    async check(context) {
      const r = await context.request.get(`${GS_BASE_URL}/account`, { maxRedirects: 0, failOnStatusCode: false });
      return r.status() === 200 ? true : null;
    },
    async save(context) {
      const cookies = cookiesFor(await context.cookies(), GS_HOST);
      const remember = cookies.find((c) => c.name === 'signed_token' && c.expires > 0);
      const expiresAt = remember ? new Date(remember.expires * 1000).toISOString() : null;
      saveSession({ cookies: plainCookies(cookies), savedAt: new Date().toISOString(), expiresAt }, GS_SESSION_FILE);
      return { expiresAt };
    },
  },
};

async function attempt(svc, { headless, timeoutMs, onOpen, terminal }) {
  const { context, browser } = await launch({ headless });
  const stop = new AbortController();
  let failed;
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(svc.startUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
    if (!headless) onOpen?.(browser);
    if (terminal) driveSignIn(page, terminal.io, { ...terminal, signal: stop.signal }).catch((e) => (failed = e));
    const result = await waitFor(context, () => svc.check(context), timeoutMs, () => failed);
    if (failed) throw failed;
    if (!result) return { ok: false, browser };
    return { ok: true, browser, saved: await svc.save(context, result) };
  } finally {
    stop.abort();
    await context.close().catch(() => {});
  }
}

/**
 * Signs in to "minerva" or "gradescope".
 * - silent: try a hidden window first (default true)
 * - interactive: open a visible window if silent fails (default true)
 * - terminal: { io, username, mfa } to sign in from the terminal in a hidden
 *   window instead of a visible one (see src/sso.js)
 * Resolves to { signedIn, mode, browser, ... }; never throws for a login that
 * simply wasn't completed.
 */
export async function login(service, { silent = true, interactive = true, timeoutMs = LOGIN_TIMEOUT_MS, onOpen, terminal } = {}) {
  const svc = services[service];
  if (!svc) throw new Error(`Unknown service "${service}"`);
  const chosen = chooseBrowser();
  const browserInfo = { name: chosen.name, source: chosen.source, note: chosen.note };

  if (silent) {
    const r = await attempt(svc, { headless: true, timeoutMs: SILENT_TIMEOUT_MS }).catch(() => ({ ok: false }));
    if (r.ok) return { signedIn: true, service, mode: 'silent', browser: browserInfo, ...r.saved };
  }
  if (!interactive) {
    return { signedIn: false, service, needsUser: true, browser: browserInfo };
  }
  if (terminal) {
    const r = await attempt(svc, { headless: true, timeoutMs, terminal });
    if (r.ok) return { signedIn: true, service, mode: 'terminal', browser: browserInfo, ...r.saved };
    return { signedIn: false, service, mode: 'terminal', browser: browserInfo, reason: 'Sign-in was not completed in time.' };
  }
  if (!hasDisplay()) {
    return {
      signedIn: false,
      service,
      needsUser: true,
      browser: browserInfo,
      reason: `There is no display to open a sign-in window on. Sign in from a terminal instead: \`${TERMINAL_COMMAND[service]}\`.`,
    };
  }
  const r = await attempt(svc, { headless: false, timeoutMs, onOpen });
  if (r.ok) return { signedIn: true, service, mode: 'interactive', browser: browserInfo, ...r.saved };
  return { signedIn: false, service, mode: 'interactive', browser: browserInfo, reason: 'Sign-in was not completed (timed out or the window was closed).' };
}

export const LABELS = Object.fromEntries(Object.entries(services).map(([k, v]) => [k, v.label]));
