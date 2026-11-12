// Lets an agent start a sign-in and come back for the result. The login runs
// in the background: a silent refresh usually finishes within seconds; if the
// user has to sign in, the default browser shows the University page and the
// agent is told to ask the user to complete it. Each sign-in is for one saved
// account, or for a new account (newAccount).
import { loginAccount, LABELS } from './auth.js';
import { hasBrowserProfile } from './accounts.js';
import { SessionError } from './client.js';

const jobs = new Map();
// A finished sign-in waits this long for the agent to come back for its result.
const RESULT_TTL_MS = 10 * 60 * 1000;
let runLogin = loginAccount;

/** Tests only: replace the sign-in function. */
export function setLoginForTests(fn) {
  runLogin = fn ?? loginAccount;
}
// A browser profile can only be opened by one browser process at a time, so
// logins run one after another.
let queue = Promise.resolve();

const keyOf = (service, account) => `${service}:${account ?? '+new'}`;

function start(service, account) {
  const job = { service, account, startedAt: new Date().toISOString(), done: false, windowOpen: false };
  job.promise = (queue = queue
    .catch(() => {})
    .then(() =>
      runLogin(service, {
        account: account ?? undefined,
        newAccount: !account,
        onOpen: (b) => {
          job.windowOpen = true;
          job.browser = b.name;
        },
      }),
    )
    .then(
      (r) => (job.result = r),
      (e) => (job.error = e.message),
    )
    .finally(() => {
      job.done = true;
      job.finishedAt = Date.now();
    }));
  jobs.set(keyOf(service, account), job);
  return job;
}

// Silent refreshes, one per service and account at a time. A failed one isn't
// tried again for a while, so a run of tool calls doesn't keep launching a
// hidden browser.
const refreshes = new Map();
const failedAt = new Map();
const REFRESH_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * Tries to renew an expired session for an existing account in a hidden
 * window, without any user action. Resolves to true when it worked. Skipped
 * (false) with no profile to refresh from, while a sign-in for that account
 * is waiting for the user, after a recent failure, or with
 * MINERVA_NO_AUTO_LOGIN=1.
 */
export function silentRefresh(service, account) {
  if (process.env.MINERVA_NO_AUTO_LOGIN === '1' || !account || !hasBrowserProfile(account)) return Promise.resolve(false);
  const key = keyOf(service, account);
  if (Date.now() - (failedAt.get(key) ?? -Infinity) < REFRESH_COOLDOWN_MS) return Promise.resolve(false);
  if (pendingLogin(service, account)) return Promise.resolve(false);
  let p = refreshes.get(key);
  if (!p) {
    p = queue = queue
      .catch(() => {})
      .then(() => runLogin(service, { account, interactive: false }))
      .then(
        (r) => Boolean(r?.signedIn),
        () => false,
      )
      .then((ok) => {
        if (ok) failedAt.delete(key);
        else failedAt.set(key, Date.now());
        refreshes.delete(key);
        return ok;
      });
    refreshes.set(key, p);
  }
  return p;
}

/** A pending login for `service` and `account` (null: a new account), if one is running. */
export function pendingLogin(service, account) {
  const job = jobs.get(keyOf(service, account));
  if (!job || job.done) return undefined;
  return { startedAt: job.startedAt, windowOpen: job.windowOpen, browser: job.browser };
}

/**
 * Starts (or joins) a login for `account`, or for a new account when account
 * is null, and waits up to `waitSeconds` for it to finish. Never opens a second
 * window while one is already waiting for the user.
 */
export async function agentLogin(service, { account = null, waitSeconds = 45 } = {}) {
  const label = LABELS[service];
  const key = keyOf(service, account);
  // A sign-in that already finished is reported, not started again: calling
  // back "to confirm" must not open a second window.
  let job = jobs.get(key);
  if (!job || (job.done && Date.now() - job.finishedAt > RESULT_TTL_MS)) job = start(service, account);

  await Promise.race([job.promise, new Promise((r) => setTimeout(r, waitSeconds * 1000))]);

  const forWhom = account ? ` for account ${account}` : ' for a new account';
  if (!job.done) {
    return {
      signedIn: false,
      account,
      waitingForUser: job.windowOpen,
      message: job.windowOpen
        ? `A ${label} sign-in page${forWhom} is open in ${job.browser}. Tell the user and ask them to sign in there with ` +
          `${account ? 'that' : 'the new'} University account (and MFA). The window closes by itself when they are done. ` +
          `Then call this tool again${account ? ` with account "${account}"` : ' with newAccount: true'} to confirm.`
        : `Still trying to refresh the ${label} session${forWhom} silently. Call this tool again in a few seconds.`,
    };
  }

  jobs.delete(key);
  if (job.error) throw new Error(job.error);
  const r = job.result;
  if (r.signedIn) {
    return {
      signedIn: true,
      account: r.account,
      newAccount: r.newAccount || undefined,
      how: r.mode === 'silent' ? 'Refreshed silently; the user did not have to do anything.' : 'The user signed in.',
      userName: r.userName,
      expiresAt: r.expiresAt,
      browser: r.browser?.name,
    };
  }
  return { signedIn: false, account, message: `${r.reason ?? 'Sign-in was not completed.'} Ask the user whether to try again.` };
}

// When a call finds its session expired, renew it silently (the account's own
// browser profile usually still has Microsoft's "Stay signed in") and, for
// tools that only read, run the call again. Tools that change something are
// not re-run on their own: the agent is told to call again. Only when the
// silent refresh can't work does the agent see the error and call *_login.
export async function withSessionRefresh(run, account, { rerun }) {
  try {
    return await run();
  } catch (e) {
    if (!(e instanceof SessionError) || !account) throw e;
    if (!(await silentRefresh(e.service, account))) throw e;
    if (rerun) return run();
    const label = e.service === 'gradescope' ? 'Gradescope' : 'Minerva';
    throw new Error(`The ${label} session for ${account} had expired and was renewed silently; nothing was sent. Call this tool again to continue.`);
  }
}
