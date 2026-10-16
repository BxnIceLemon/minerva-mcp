#!/usr/bin/env node
// Opens a real browser window on Minerva. You sign in yourself (University SSO
// + MFA); this script never sees your password. Once Blackboard accepts the
// session, its cookies are saved for the MCP server to reuse.
import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { BASE_URL, PROFILE_DIR, SESSION_FILE } from './config.js';
import { saveSession, minervaCookies, bbRouterField } from './session.js';

const TIMEOUT_MS = 5 * 60 * 1000;
const FALLBACK_TTL_MS = 3 * 60 * 60 * 1000;

async function launch() {
  fs.mkdirSync(PROFILE_DIR, { recursive: true, mode: 0o700 });
  const errors = [];
  // Use a browser that is already installed so nothing extra is downloaded.
  for (const channel of [process.env.MINERVA_BROWSER, 'msedge', 'chrome'].filter(Boolean)) {
    try {
      return await chromium.launchPersistentContext(PROFILE_DIR, {
        channel,
        headless: false,
        viewport: null,
      });
    } catch (e) {
      errors.push(`${channel}: ${e.message.split('\n')[0]}`);
    }
  }
  throw new Error(`Could not start Edge or Chrome.\n${errors.join('\n')}`);
}

async function whoami(context) {
  const r = await context.request.get(`${BASE_URL}/learn/api/public/v1/users/me`, {
    headers: { Accept: 'application/json' },
    failOnStatusCode: false,
  });
  return r.ok() ? r.json() : null;
}

async function main() {
  console.log('Opening Minerva. Sign in with your University of Leeds account in the browser window.');
  const context = await launch();
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(`${BASE_URL}/ultra`, { waitUntil: 'domcontentloaded' }).catch(() => {});

  const deadline = Date.now() + TIMEOUT_MS;
  let user = null;
  while (Date.now() < deadline) {
    user = await whoami(context).catch(() => null);
    if (user) break;
    if (context.pages().length === 0) break; // window closed by the user
    await new Promise((r) => setTimeout(r, 2000));
  }

  if (!user) {
    await context.close().catch(() => {});
    console.error('Login was not completed (timed out or the window was closed).');
    process.exit(1);
  }

  const cookies = minervaCookies(await context.cookies());
  const expiresSec = Number(bbRouterField(cookies, 'expires'));
  const expiresAt = expiresSec > 0 ? expiresSec * 1000 : Date.now() + FALLBACK_TTL_MS;

  saveSession({
    cookies: cookies.map(({ name, value, domain, path }) => ({ name, value, domain, path })),
    xsrf: bbRouterField(cookies, 'xsrf') ?? null,
    userId: user.id,
    userName: user.userName,
    displayName: [user.name?.given, user.name?.family].filter(Boolean).join(' ') || user.userName,
    savedAt: new Date().toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
  });
  await context.close();

  console.log(`Signed in as ${user.userName}. Session saved to ${SESSION_FILE}`);
  console.log(`Blackboard says it is valid until about ${new Date(expiresAt).toLocaleString()}.`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
