// Lets an agent start a sign-in and come back for the result. The login runs
// in the background: a silent refresh usually finishes within seconds; if the
// user has to sign in, the default browser shows the University page and the
// agent is told to ask the user to complete it.
import { login, LABELS } from './auth.js';

const jobs = new Map();
// Minerva and Gradescope share one browser profile, which only one browser
// process can open at a time, so logins run one after another.
let queue = Promise.resolve();

function start(service) {
  const job = { service, startedAt: new Date().toISOString(), done: false, windowOpen: false };
  job.promise = (queue = queue
    .catch(() => {})
    .then(() =>
      login(service, {
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
    .finally(() => (job.done = true)));
  jobs.set(service, job);
  return job;
}

/** A pending login for `service`, if one is running. */
export function pendingLogin(service) {
  const job = jobs.get(service);
  if (!job || job.done) return undefined;
  return { startedAt: job.startedAt, windowOpen: job.windowOpen, browser: job.browser };
}

/**
 * Starts (or joins) a login and waits up to `waitSeconds` for it to finish.
 * Never opens a second window while one is already waiting for the user.
 */
export async function agentLogin(service, { waitSeconds = 60 } = {}) {
  const label = LABELS[service];
  let job = jobs.get(service);
  if (!job || job.done) job = start(service);

  await Promise.race([job.promise, new Promise((r) => setTimeout(r, waitSeconds * 1000))]);

  if (!job.done) {
    return {
      signedIn: false,
      waitingForUser: job.windowOpen,
      message: job.windowOpen
        ? `A ${label} sign-in page is open in ${job.browser}. Tell the user and ask them to sign in there with their University account (and MFA). ` +
          'The window closes by itself when they are done. Then call this tool again to confirm.'
        : `Still trying to refresh the ${label} session silently. Call this tool again in a few seconds.`,
    };
  }

  jobs.delete(service);
  if (job.error) throw new Error(job.error);
  const r = job.result;
  if (r.signedIn) {
    return {
      signedIn: true,
      how: r.mode === 'silent' ? 'Refreshed silently; the user did not have to do anything.' : 'The user signed in.',
      userName: r.userName,
      expiresAt: r.expiresAt,
      browser: r.browser?.name,
    };
  }
  return { signedIn: false, message: `${r.reason ?? 'Sign-in was not completed.'} Ask the user whether to try again.` };
}
