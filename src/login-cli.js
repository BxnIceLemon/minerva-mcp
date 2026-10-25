// Shared terminal front end for `npm run login` and `npm run login:gradescope`.
import { login, LABELS } from './auth.js';
import { SESSION_FILE, GS_SESSION_FILE } from './config.js';

export async function runLoginCli(service, { silent = !process.argv.includes('--no-silent') } = {}) {
  const label = LABELS[service];
  console.log(`Signing in to ${label}…`);
  try {
    const r = await login(service, {
      silent,
      onOpen: (b) =>
        console.log(
          `Opened ${b.name}${b.source === 'system default' ? ' (your default browser)' : ''}. ` +
            `Sign in there; the window closes by itself when you're done.${b.note ? `\nNote: ${b.note}.` : ''}`,
        ),
    });
    if (!r.signedIn) {
      console.error(r.reason ?? 'Sign-in was not completed.');
      return 1;
    }
    const file = service === 'minerva' ? SESSION_FILE : GS_SESSION_FILE;
    console.log(`${r.mode === 'silent' ? 'Refreshed silently' : 'Signed in'}${r.userName ? ` as ${r.userName}` : ''}. Session saved to ${file}`);
    if (r.expiresAt) console.log(`Valid until about ${new Date(r.expiresAt).toLocaleString()}.`);
    return 0;
  } catch (e) {
    console.error(e.message);
    return 1;
  }
}
