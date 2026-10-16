#!/usr/bin/env node
// Opens Gradescope in the shared browser profile. Sign in however you normally
// do: "School Credentials" with your Leeds account, an email + password, or by
// opening any Gradescope assignment link from Minerva. Once Gradescope shows
// you as signed in, its cookies are saved for the MCP server.
import { GS_BASE_URL, GS_HOST, GS_SESSION_FILE } from './config.js';
import { saveSession, cookiesFor } from './session.js';
import { launch, waitFor, plainCookies } from './browser.js';

async function signedIn(context) {
  const r = await context.request.get(`${GS_BASE_URL}/account`, {
    maxRedirects: 0,
    failOnStatusCode: false,
  });
  return r.status() === 200 ? true : null;
}

async function main() {
  console.log('Opening Gradescope. Sign in in the browser window (or open a Gradescope link from Minerva).');
  const context = await launch();
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(`${GS_BASE_URL}/login`, { waitUntil: 'domcontentloaded' }).catch(() => {});

  const ok = await waitFor(context, () => signedIn(context));
  if (!ok) {
    await context.close().catch(() => {});
    console.error('Login was not completed (timed out or the window was closed).');
    process.exit(1);
  }

  const cookies = cookiesFor(await context.cookies(), GS_HOST);
  const remember = cookies.find((c) => c.name === 'signed_token' && c.expires > 0);
  saveSession(
    {
      cookies: plainCookies(cookies),
      savedAt: new Date().toISOString(),
      expiresAt: remember ? new Date(remember.expires * 1000).toISOString() : null,
    },
    GS_SESSION_FILE,
  );
  await context.close();
  console.log(`Gradescope session saved to ${GS_SESSION_FILE}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
