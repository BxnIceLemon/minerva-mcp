import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { PROFILE_DIR } from './config.js';

export const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

// One persistent profile is shared by the Minerva and Gradescope logins, so the
// University SSO session carries over and Minerva's Gradescope links work.
export async function launch() {
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

// Polls `check` until it returns a value, the timeout passes, or the user
// closes every window.
export async function waitFor(context, check) {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await check().catch(() => null);
    if (result) return result;
    if (context.pages().length === 0) return null;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return null;
}

export function plainCookies(cookies) {
  return cookies.map(({ name, value, domain, path, expires }) => ({ name, value, domain, path, expires }));
}
