// Shared terminal front end for `npm run login`, `npm run login:gradescope`
// and `gradescope login`.
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { loginAccount, LABELS } from './auth.js';
import { hasDisplay } from './browser.js';
import { MFA_METHODS } from './sso.js';
import { sessionFile, currentAccount, accountExists, accountInfo, listAccounts, AccountChoiceError } from './accounts.js';

export const LOGIN_OPTIONS = {
  terminal: { type: 'boolean' },
  user: { type: 'string' },
  mfa: { type: 'string' },
  'no-silent': { type: 'boolean' },
  account: { type: 'string' },
  'new-account': { type: 'boolean' },
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

function describeAccount(name) {
  const a = accountInfo(name);
  const who = a.displayName && a.displayName !== name ? `  ${a.displayName}` : '';
  const signedIn = [a.minerva.signedIn && 'Minerva', a.gradescope.signedIn && 'Gradescope'].filter(Boolean).join(', ');
  return `${name}${who}${signedIn ? `  (${signedIn})` : ''}`;
}

/**
 * Picks the account a command works on, from --account, --new-account (login
 * only), MINERVA_ACCOUNT, or the only saved account. With several accounts it
 * asks in the terminal, and refuses without one. Returns { account, newAccount }.
 */
export async function chooseAccountCli(values = {}, { login = false } = {}) {
  if (values['new-account']) {
    if (!login) throw new Error('--new-account only works with login');
    return { newAccount: true };
  }
  if (values.account) {
    if (!accountExists(values.account)) {
      throw new Error(
        `No saved account "${values.account}". Saved: ${listAccounts().join(', ') || 'none'}.${login ? ' To add one, use --new-account.' : ''}`,
      );
    }
    return { account: values.account };
  }
  let choices;
  try {
    const a = currentAccount();
    if (a) return { account: a };
    return login ? { newAccount: true } : { account: null };
  } catch (e) {
    if (!(e instanceof AccountChoiceError)) throw e;
    choices = e.accounts;
  }
  if (!process.stdin.isTTY) {
    throw new Error(`Several accounts are saved: ${choices.join(', ')}. Choose one with --account NAME or MINERVA_ACCOUNT.`);
  }
  console.error('Saved accounts:');
  choices.forEach((c, i) => console.error(`  ${i + 1}) ${describeAccount(c)}`));
  if (login) console.error('  n) a new account');
  for (;;) {
    const answer = (await ask(`Which account? [1-${choices.length}${login ? ', n' : ''}] `)).trim();
    if (login && /^n(ew)?$/i.test(answer)) return { newAccount: true };
    const pick = choices[Number(answer) - 1] ?? choices.find((c) => c === answer);
    if (pick) return { account: pick };
  }
}

export async function runLoginCli(service, opts) {
  const label = LABELS[service];
  try {
    let o = opts;
    if (!o) {
      const values = parseArgs({ args: process.argv.slice(2), options: LOGIN_OPTIONS }).values;
      o = { ...loginOptions(values), ...(await chooseAccountCli(values, { login: true })) };
    } else if (o.account === undefined && !o.newAccount) {
      o = { ...o, ...(await chooseAccountCli({}, { login: true })) };
    }
    const { silent = true, terminal = false, username, mfa, account, newAccount } = o;
    if (terminal && !process.stdin.isTTY) throw new Error('Terminal sign-in needs an interactive terminal.');
    console.log(newAccount ? `Signing in to ${label} as a new account…` : `Signing in to ${label}${account ? ` (account ${account})` : ''}…`);
    const r = await loginAccount(service, {
      account: account ?? undefined,
      newAccount,
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
    const how = r.mode === 'silent' ? 'Refreshed silently' : 'Signed in';
    console.log(`${how}${r.userName ? ` as ${r.userName}` : ''} (account ${r.account}). Session saved to ${sessionFile(service, r.account)}`);
    if (r.expiresAt) console.log(`Valid until about ${new Date(r.expiresAt).toLocaleString()}.`);
    return 0;
  } catch (e) {
    console.error(e.message);
    return 1;
  }
}
