// Shared terminal front end for `npm run login`, `npm run login:gradescope`
// and `gradescope login`.
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { login, LABELS } from './auth.js';
import { hasDisplay } from './browser.js';
import { MFA_METHODS } from './sso.js';
import { SESSION_FILE, GS_SESSION_FILE } from './config.js';

export const LOGIN_OPTIONS = {
  terminal: { type: 'boolean' },
  user: { type: 'string' },
  mfa: { type: 'string' },
  'no-silent': { type: 'boolean' },
};

async function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

// Reads a line without echoing it.
function askHidden(question) {
  const { stdin, stderr } = process;
  if (!stdin.isTTY) return ask(question);
  stderr.write(question);
  return new Promise((resolve, reject) => {
    let value = '';
    const done = (fn) => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stderr.write('\n');
      fn();
    };
    const onData = (buf) => {
      for (const ch of buf.toString('utf8')) {
        if (ch === '\r' || ch === '\n') return done(() => resolve(value));
        if (ch === '\u0003') return done(() => reject(new Error('Sign-in cancelled.')));
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

const terminalIo = { ask, askHidden, say: (msg) => console.error(msg) };

/**
 * Options for runLoginCli from command-line flags. Terminal sign-in is used
 * with --terminal, or by itself on a machine with no display.
 */
export function loginOptions(values) {
  const mfa = values.mfa ?? process.env.MINERVA_MFA ?? 'push';
  if (!MFA_METHODS.includes(mfa)) throw new Error(`--mfa must be one of ${MFA_METHODS.join(', ')}`);
  return {
    silent: !values['no-silent'],
    terminal: values.terminal || (!hasDisplay() && process.stdin.isTTY),
    username: values.user ?? process.env.MINERVA_USERNAME,
    mfa,
  };
}

export async function runLoginCli(service, opts) {
  const label = LABELS[service];
  try {
    const { silent = true, terminal = false, username, mfa } =
      opts ?? loginOptions(parseArgs({ args: process.argv.slice(2), options: LOGIN_OPTIONS }).values);
    if (terminal && !process.stdin.isTTY) throw new Error('Terminal sign-in needs an interactive terminal.');
    console.log(`Signing in to ${label}…`);
    const r = await login(service, {
      silent,
      terminal: terminal ? { io: terminalIo, username, mfa } : undefined,
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
