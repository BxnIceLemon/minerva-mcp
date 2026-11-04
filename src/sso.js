// Terminal sign-in: drives the University's Microsoft sign-in and Duo prompt
// in a hidden window, asking for the username, password and second factor in
// the terminal. The password is typed into Microsoft's own form and then
// dropped; it is never saved, logged or sent anywhere else.

const DEFAULT_DOMAIN = 'leeds.ac.uk';
const STUCK_MS = 45 * 1000;
const MAX_TRIES = 3;

export const MFA_METHODS = ['push', 'passcode', 'sms', 'call'];

// Labels Duo's Universal Prompt uses in its "Other options" list.
const DUO_METHOD_TEXT = {
  push: /duo push/i,
  passcode: /duo mobile passcode|enter a passcode|passcode/i,
  sms: /text message/i,
  call: /phone call/i,
};
// Microsoft's own second-factor list, used if Duo isn't in front of it.
const MS_PROOF = {
  push: ['PhoneAppNotification'],
  passcode: ['PhoneAppOTP', 'SoftwareTokenBasedTOTP'],
  sms: ['OneWaySMS'],
  call: ['TwoWayVoiceMobile', 'TwoWayVoiceAlternateMobile'],
};

/** "ab12cd" → "ab12cd@leeds.ac.uk"; full addresses are kept as typed. */
export function normalizeUsername(name) {
  const n = name.trim();
  return n && !n.includes('@') ? `${n}@${DEFAULT_DOMAIN}` : n;
}

// What is on screen, gathered inside the page. Kept to the few facts
// classify() needs so the classification can be tested without a browser.
function snapshot() {
  const shown = (sel) => {
    const el = document.querySelector(sel);
    return Boolean(el && el.offsetParent !== null);
  };
  const textOf = (sel) => {
    const el = document.querySelector(sel);
    return el && el.offsetParent !== null ? el.innerText.trim() : '';
  };
  return {
    host: location.hostname,
    title: document.title,
    text: (document.body?.innerText ?? '').slice(0, 4000),
    username: shown('input[name=loginfmt]'),
    password: shown('input[name=passwd]'),
    tiles: shown('#otherTile'),
    external: shown('#externalAuthHeader'),
    kmsi: shown('#KmsiCheckboxField') || shown('#KmsiDescription') || shown('input[name=DontShowAgain]'),
    proofs: [...document.querySelectorAll('[data-value]')].filter((e) => e.offsetParent !== null).map((e) => e.getAttribute('data-value')),
    otc: shown('input[name=otc]'),
    msNumber: textOf('#idRichContext_DisplaySign'),
    msError: textOf('#usernameError') || textOf('#passwordError') || textOf('#idSpan_SAOTCC_Error_OTC') || textOf('#idTD_Error'),
    duoPasscode: shown('#passcode-input') || shown('input[name=passcode-input]'),
    duoTrust: shown('#trust-browser-button'),
    duoCode: textOf('.verification-code'),
  };
}

/** The number Duo's verified push shows for the user to type in Duo Mobile. */
export function duoVerificationCode(text) {
  if (!/enter (this |the )?(verification )?code/i.test(text)) return '';
  return text.match(/^\s*(\d{2,8})\s*$/m)?.[1] ?? '';
}

/** Names the sign-in step a page snapshot shows. Pure, so it can be tested. */
export function classify(s) {
  if (/duosecurity\.com$/.test(s.host)) {
    if (s.duoTrust || /is this your device/i.test(s.text)) return 'duo-trust';
    if (s.duoPasscode) return 'duo-passcode';
    if (s.duoCode || duoVerificationCode(s.text)) return 'duo-code';
    if (/timed out|denied|was not approved|couldn.t (send|verify)|try again|something went wrong/i.test(s.text)) return 'duo-failed';
    if (/other options to log in|choose an authentication method|other options/i.test(s.text) && !/check for a duo push|pushed a login request|sent to/i.test(s.text)) return 'duo-methods';
    if (/check for a duo push|pushed a login request|sent to|calling|sending/i.test(s.text)) return 'duo-wait';
    return 'duo-other';
  }
  if (/login\.(microsoftonline|live)\.com$/.test(s.host)) {
    if (s.password) return s.msError ? 'ms-password-error' : 'ms-password';
    if (s.username) return s.msError ? 'ms-username-error' : 'ms-username';
    if (s.tiles) return 'ms-tiles';
    if (s.kmsi) return 'ms-kmsi';
    if (s.external) return 'ms-external';
    if (s.otc) return s.msError ? 'ms-otc-error' : 'ms-otc';
    if (s.msNumber) return 'ms-number';
    if (s.proofs.length) return 'ms-proofs';
    return 'ms-other';
  }
  return 'other';
}

/** The proof to click on Microsoft's "Verify your identity" list: Duo first. */
export function pickProof(proofs, mfa) {
  return proofs.find((p) => /duo|external/i.test(p)) ?? MS_PROOF[mfa].find((p) => proofs.includes(p)) ?? proofs[0];
}

async function clickText(page, re) {
  for (const role of ['button', 'link', 'listitem']) {
    const el = page.getByRole(role, { name: re }).first();
    if (await el.isVisible().catch(() => false)) {
      await el.click();
      return true;
    }
  }
  const el = page.getByText(re).first();
  if (await el.isVisible().catch(() => false)) {
    await el.click();
    return true;
  }
  return false;
}

// Headless Chromium announces itself as "HeadlessChrome", which some sign-in
// pages refuse; present the ordinary Chrome user agent instead.
async function plainUserAgent(page) {
  try {
    const cdp = await page.context().newCDPSession(page);
    const { userAgent } = await cdp.send('Browser.getVersion');
    await cdp.send('Network.setUserAgentOverride', { userAgent: userAgent.replace('HeadlessChrome', 'Chrome') });
  } catch {
    // Not fatal; the default user agent usually works too.
  }
}

/**
 * Walks the sign-in pages in `page` until `signal` aborts (the caller stops it
 * once the session check passes). Throws when the user cancels or a step keeps
 * failing. `io` is { ask(q), askHidden(q), say(msg) }; `options` is
 * { username, mfa }.
 */
export async function driveSignIn(page, io, { username, mfa = 'push', signal } = {}) {
  if (!MFA_METHODS.includes(mfa)) throw new Error(`Unknown MFA method "${mfa}" (use ${MFA_METHODS.join(', ')})`);
  await plainUserAgent(page);
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});

  let user = username ? normalizeUsername(username) : null;
  let last = null;
  let since = Date.now();
  let method = mfa;
  const tries = { username: 0, password: 0, code: 0 };
  let switched = false;

  const once = (state, msg) => state !== last && io.say(msg);

  while (!signal?.aborted) {
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    const s = await page.evaluate(snapshot).catch(() => null);
    if (!s) {
      await page.waitForTimeout(500).catch(() => {});
      continue;
    }
    const state = classify(s);
    if (process.env.MINERVA_SSO_DEBUG && state !== last) {
      process.stderr.write(`[sso] ${state} (${s.host}: ${s.title})${state.endsWith("other") || state.startsWith("duo") ? `\n${s.text.slice(0, 600)}` : ""}\n`);
    }
    if (state !== last) since = Date.now();
    else if (Date.now() - since > STUCK_MS && !['duo-wait', 'duo-code', 'ms-number'].includes(state)) {
      throw new Error(`Sign-in stopped at an unexpected page ("${s.title}" on ${s.host}). Try again, or use the browser sign-in.`);
    }
    let acted = true;

    switch (state) {
      case 'ms-username-error':
        io.say(`Microsoft: ${s.msError}`);
        if (++tries.username >= MAX_TRIES) throw new Error('Too many unknown usernames.');
        user = null;
      // falls through
      case 'ms-username':
        if (state === last && state === 'ms-username') {
          acted = false;
          break;
        }
        user ??= normalizeUsername(await io.ask(`University username or email (e.g. ab12cd@${DEFAULT_DOMAIN}): `));
        if (!user) throw new Error('No username given.');
        await page.fill('input[name=loginfmt]', user);
        await page.click('#idSIButton9');
        break;

      case 'ms-tiles':
        await page.click('#otherTile');
        break;

      case 'ms-password-error':
        io.say(`Microsoft: ${s.msError}`);
        if (++tries.password >= MAX_TRIES) throw new Error('Too many failed password attempts.');
      // falls through
      case 'ms-password': {
        if (state === last && state === 'ms-password') {
          acted = false;
          break;
        }
        let password = await io.askHidden(`Password for ${user ?? 'your account'}: `);
        if (!password) throw new Error('No password given.');
        await page.fill('input[name=passwd]', password);
        password = null;
        await page.click('#idSIButton9');
        break;
      }

      case 'ms-external':
        // "Verification Required": the hand-off to Duo (an external MFA method).
        if (state === last) {
          acted = false;
          break;
        }
        await page.click('#idSIButton9', { timeout: 5000 }).catch(() => {});
        break;

      case 'ms-kmsi':
        // "Stay signed in?" Yes, so later logins refresh silently.
        await page.click('#idSIButton9');
        break;

      case 'ms-proofs': {
        // The list flashes up briefly before the Duo hand-off; only pick from
        // it once it has stayed on screen.
        if (state !== last) {
          acted = false;
          break;
        }
        const proof = pickProof(s.proofs, method);
        await page.click(`[data-value="${proof}"]`, { timeout: 5000 }).catch(() => {});
        break;
      }

      case 'ms-number':
        once(state, `Open Microsoft Authenticator and enter ${s.msNumber} to approve the sign-in.`);
        acted = false;
        break;

      case 'ms-otc-error':
        io.say(`Microsoft: ${s.msError}`);
        if (++tries.code >= MAX_TRIES) throw new Error('Too many wrong codes.');
      // falls through
      case 'ms-otc': {
        if (state === last && state === 'ms-otc') {
          acted = false;
          break;
        }
        const code = (await io.ask('Verification code: ')).trim();
        if (!code) throw new Error('No code given.');
        await page.fill('input[name=otc]', code);
        await page.click('#idSubmit_SAOTCC_Continue, input[type=submit]');
        break;
      }

      case 'duo-trust':
        // "Is this your device?" Yes, so Duo doesn't ask again on this machine.
        await page.click('#trust-browser-button').catch(() => clickText(page, /yes, this is my device|trust/i));
        break;

      case 'duo-wait':
        if (method !== 'push' && !switched) {
          // Duo sends a push by itself; switch to the method that was asked for.
          switched = await clickText(page, /other options/i);
          if (!switched) throw new Error(`Duo didn't offer other options; approve the push instead (--mfa push).`);
          break;
        }
        once(state, method === 'call' ? 'Duo is calling your phone. Answer and follow the instructions.' : 'Duo Push sent. Approve it in Duo Mobile on your phone…');
        acted = false;
        break;

      case 'duo-code':
        once(state, `Duo Push sent. Enter ${s.duoCode || duoVerificationCode(s.text)} in Duo Mobile to approve.`);
        acted = false;
        break;

      case 'duo-methods': {
        if (state === last) {
          acted = false;
          break;
        }
        if (!(await clickText(page, DUO_METHOD_TEXT[method]))) {
          throw new Error(`Duo doesn't offer "${method}" for this account. Try --mfa push.`);
        }
        switched = true;
        if (method === 'sms') io.say('Duo is texting a passcode to your phone.');
        break;
      }

      case 'duo-passcode': {
        const wrong = /incorrect|invalid|expired/i.test(s.text);
        if (state === last && !wrong) {
          acted = false;
          break;
        }
        if (wrong) {
          io.say('Duo did not accept that passcode.');
          if (++tries.code >= MAX_TRIES) throw new Error('Too many wrong passcodes.');
        }
        const code = (await io.ask('Duo passcode: ')).trim();
        if (!code) throw new Error('No passcode given.');
        await page.fill('#passcode-input, input[name=passcode-input]', code);
        await clickText(page, /verify|log in|submit/i);
        break;
      }

      case 'duo-failed': {
        const reason = s.text.match(/[^\n]*(timed out|denied|not approved|couldn.t|went wrong)[^\n]*/i)?.[0] ?? 'Duo verification failed.';
        io.say(`Duo: ${reason.trim()}`);
        const answer = (await io.ask(`[r]etry ${method}, use a [p]asscode instead, or [c]ancel? `)).trim().toLowerCase();
        if (answer.startsWith('p')) {
          method = 'passcode';
          if (!(await clickText(page, /other options/i))) throw new Error('Duo did not offer a passcode option.');
        } else if (answer.startsWith('r')) {
          if (!(await clickText(page, /try again|send me a push|resend/i))) await page.reload({ waitUntil: 'domcontentloaded' });
        } else {
          throw new Error('Sign-in cancelled.');
        }
        break;
      }

      default:
        acted = false;
    }

    last = state;
    await page.waitForTimeout(acted ? 1500 : 1000).catch(() => {});
  }
}
