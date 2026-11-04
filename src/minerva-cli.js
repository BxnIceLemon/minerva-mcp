#!/usr/bin/env node
// Minerva command-line client for submitting to Ultra assignments. Like the
// gradescope command, a submission shows what it will send and asks first.
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import * as mv from './minerva.js';
import * as mvWrite from './minerva-write.js';
import { SessionError } from './client.js';
import { loadSession } from './session.js';
import { login } from './auth.js';
import { runLoginCli } from './login-cli.js';

const HELP = `Usage: minerva <command> [options]

Account
  login                                   Sign in to Minerva in a browser window
  status                                  Show whether you are signed in

Browse
  upcoming [--days N]                     Gradebook items due in the next N days (default 14)
  submissions <course> <assignment>       Settings of an assignment and your attempts on it

Actions (ask for confirmation)
  submit <course> <assignment> [file...] [-m TEXT] [--dry-run] [--yes]
      Submit files (and optional text) to an Ultra assignment as a new attempt

Options
  --json            Print raw JSON
  -h, --help        Show this help

<course> is a course id (_123456_1) or module code (COMP3620). <assignment> is a
unique part of its title ("CW2"), or its content or column id.`;

const options = {
  days: { type: 'string' },
  message: { type: 'string', short: 'm' },
  'dry-run': { type: 'boolean' },
  yes: { type: 'boolean', short: 'y' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};

class UsageError extends Error {}

function need(args, n, usage) {
  if (args.length < n) throw new UsageError(`Usage: minerva ${usage}`);
}

function fmtDate(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

const fmtBytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`);

async function confirm(question, yes) {
  if (yes) return true;
  if (!process.stdin.isTTY) throw new UsageError('Refusing to continue without a terminal to confirm in; pass --yes');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question} [y/N] `);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

const commands = {
  async login() {
    if ((await runLoginCli('minerva', { silent: true })) !== 0) throw new Error('Login was not completed');
  },

  async status(_, o) {
    const s = loadSession();
    if (o.json) return s ? { signedIn: true, userName: s.userName, expiresAt: s.expiresAt } : { signedIn: false };
    console.log(s ? `Signed in as ${s.userName ?? 'unknown'}; session valid until about ${fmtDate(s.expiresAt)}` : 'Not signed in. Run: minerva login');
  },

  async upcoming(_, o) {
    const r = await mv.upcomingDeadlines({ days: o.days ? Number(o.days) : 14 });
    if (o.json) return r;
    if (!r.items.length) return console.log('Nothing due.');
    for (const i of r.items) console.log(`${fmtDate(i.due)}  ${i.item}  (${i.course})${i.status ? `  [${i.status}]` : ''}`);
  },

  async submissions(args, o) {
    need(args, 2, 'submissions <course> <assignment>');
    const r = await mvWrite.listSubmissions({ courseId: args[0], assignment: args[1] });
    if (o.json) return r;
    console.log(`${r.title}  due ${fmtDate(r.due)}`);
    console.log(`Attempts allowed: ${r.attemptsAllowed > 0 ? r.attemptsAllowed : 'unlimited'}; files ${r.allowFiles ? 'allowed' : 'not allowed'}, text ${r.allowText ? 'allowed' : 'not allowed'}`);
    if (!r.attempts.length) return console.log('No attempts yet.');
    for (const a of r.attempts) {
      const files = a.files?.length ? `  ${a.files.join(', ')}` : '';
      console.log(`  ${a.attemptId}  ${a.status}  ${fmtDate(a.submittedAt ?? a.started)}${a.grade ? `  grade ${a.grade}` : ''}${files}`);
    }
  },

  async submit(args, o) {
    need(args, 2, 'submit <course> <assignment> [file...] [-m TEXT]');
    const [courseId, assignment, ...files] = args;
    const req = { courseId, assignment, files, text: o.message };
    const plan = await mvWrite.submit({ ...req, dryRun: true });
    if (o.json && o['dry-run']) return plan;
    if (!o.json) {
      console.log(`Submit to "${plan.assignment}" (due ${fmtDate(plan.due)})${plan.late ? ' — LATE' : ''}`);
      console.log(`Attempt ${plan.attempt} of ${plan.attemptsAllowed}${plan.continuesDraft ? `, continuing draft ${plan.continuesDraft}` : ''}`);
      for (const f of plan.files) console.log(`  ${f.name}  ${fmtBytes(f.bytes)}`);
      if (plan.text) console.log(`  text: ${plan.text.length > 80 ? `${plan.text.slice(0, 80)}…` : plan.text}`);
    }
    if (o['dry-run']) return;
    if (!(await confirm('Submit this? Course staff will see it.', o.yes))) return console.log('Cancelled.');
    const r = await mvWrite.submit(req);
    if (o.json) return r;
    console.log(`Submitted attempt ${r.attemptId} at ${fmtDate(r.submittedAt)}${r.receiptId ? ` (receipt ${r.receiptId})` : ''}`);
  },
};

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options, allowPositionals: true });
  } catch (e) {
    console.error(e.message);
    return 2;
  }
  const [cmd, ...rest] = parsed.positionals;
  if (parsed.values.help || !cmd || cmd === 'help') {
    console.log(HELP);
    return 0;
  }
  const fn = commands[cmd];
  if (!fn) {
    console.error(`Unknown command "${cmd}". Run minerva --help.`);
    return 2;
  }
  const runOnce = async () => {
    const out = await fn(rest, parsed.values);
    if (parsed.values.json && out !== undefined) console.log(JSON.stringify(out, null, 2));
    return 0;
  };
  try {
    try {
      return await runOnce();
    } catch (e) {
      if (!(e instanceof SessionError) || cmd === 'login' || !(await recoverSession())) throw e;
      return await runOnce();
    }
  } catch (e) {
    console.error(e instanceof SessionError ? `${e.message.replace(/Call the minerva_login tool, or run `npm run login` in the minerva-mcp folder\./, 'Run: minerva login')}` : e.message);
    return e instanceof UsageError ? 2 : 1;
  }
}

// On an expired session: refresh silently, and if that isn't enough and we're
// in a terminal, offer to open the sign-in page. Returns true to retry.
async function recoverSession() {
  if (process.env.MINERVA_NO_AUTO_LOGIN === '1') return false;
  process.stderr.write('Minerva session expired; refreshing…\n');
  const quiet = await login('minerva', { interactive: false }).catch(() => ({ signedIn: false }));
  if (quiet.signedIn) return true;
  if (!process.stdin.isTTY) return false;
  if (!(await confirm('Open the Minerva sign-in page in your browser?', false))) return false;
  return (await runLoginCli('minerva', { silent: false })) === 0;
}

process.exitCode = await main(process.argv.slice(2));
