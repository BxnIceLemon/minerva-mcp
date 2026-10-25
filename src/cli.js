#!/usr/bin/env node
// Gradescope command-line client. Reads work like the MCP tools; `submit` and
// `regrade` show what they will do and ask before sending anything.
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import * as gs from './gradescope.js';
import { SessionError } from './client.js';
import { login } from './auth.js';
import { runLoginCli } from './login-cli.js';

const HELP = `Usage: gradescope <command> [options]

Account
  login                                   Sign in to Gradescope in a browser window
  status                                  Show whether you are signed in

Browse
  courses [--search TEXT]                 List your courses
  assignments <course>                    Assignments with status, score and due dates
  upcoming [--days N]                     Work due this term in the next N days (default 14)
  grades <course>                         Scores for every assignment in a course

Submissions
  show <course> <assignment>              Full detail of your submission
  results <course> <assignment> [--wait]  Autograder test results (--wait polls until done)
  comments <course> <assignment>          Rubric items, grader comments and regrade threads
  history <course> <assignment>           All your submissions to an assignment

Actions (ask for confirmation)
  submit <course> <assignment> <file...>  Upload files (code, PDF or document assignments)
      [--leaderboard NAME] [--wait] [--dry-run] [--yes]
  regrade <course> <assignment> <question> -m TEXT
      Ask for question <question> (e.g. 2.1) to be regraded [--dry-run] [--yes]

Options
  --submission ID   Use a specific submission instead of your active one
  --timeout SECS    How long --wait polls (default 600)
  --json            Print raw JSON
  -h, --help        Show this help

<course> is a course number or module code (COMP3620). <assignment> is an
assignment id or a unique part of its title ("Perceptron").`;

const options = {
  search: { type: 'string' },
  days: { type: 'string' },
  submission: { type: 'string' },
  leaderboard: { type: 'string' },
  message: { type: 'string', short: 'm' },
  timeout: { type: 'string' },
  wait: { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  yes: { type: 'boolean', short: 'y' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};

class UsageError extends Error {}

function need(args, n, usage) {
  if (args.length < n) throw new UsageError(`Usage: gradescope ${usage}`);
}

function fmtDate(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function fmtScore(score, max) {
  if (score === undefined || score === null) return '-';
  return max !== undefined && max !== null ? `${score}/${max}` : String(score);
}

function table(rows, cols) {
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)));
  const line = (r) => cols.map((c, i) => String(r[c] ?? '').padEnd(widths[i])).join('  ').trimEnd();
  return [line(Object.fromEntries(cols.map((c) => [c, c.toUpperCase()]))), ...rows.map(line)].join('\n');
}

async function confirm(question, yes) {
  if (yes) return true;
  if (!process.stdin.isTTY) throw new UsageError('Refusing to continue without a terminal to confirm in; pass --yes');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question} [y/N] `);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

function printSubmission(s) {
  console.log(`${s.assignment}`);
  console.log(`Submission ${s.submissionId}, ${fmtDate(s.submittedAt)}${s.lateness ? ` (${s.lateness})` : ''}`);
  console.log(`Score: ${fmtScore(s.score, s.totalPoints)}${s.gradesVisible === false ? ' (grades not released)' : ''}`);
  for (const q of s.questions) {
    console.log(`  ${q.question}  ${fmtScore(q.score, q.maxScore)}`);
    for (const r of q.rubricApplied) console.log(`      rubric: ${r}`);
    for (const c of q.comments) console.log(`      comment: ${c}`);
  }
  if (s.autograder) printAutograder(s.autograder);
  console.log(s.url);
}

function printAutograder(ag) {
  console.log(`Autograder: ${ag.score ?? '-'}`);
  for (const t of ag.tests) {
    const mark = t.status === 'passed' ? '✓' : t.status === 'failed' ? '✗' : '•';
    console.log(`  ${mark} ${t.number ? `${t.number}. ` : ''}${t.name}  ${fmtScore(t.score, t.maxScore)}`);
    if (t.output) console.log(t.output.replace(/^/gm, '      '));
  }
  if (ag.output) console.log(`\n${ag.output}`);
  if (ag.stdout) console.log(`\nstdout:\n${ag.stdout}`);
}

const commands = {
  async login() {
    if ((await runLoginCli('gradescope')) !== 0) throw new Error('Login was not completed');
  },

  async status(_, o) {
    const s = gs.status();
    if (o.json) return s;
    console.log(s.signedIn ? `Signed in (session saved ${fmtDate(s.savedAt)})` : `Not signed in. ${s.fix}`);
  },

  async courses(_, o) {
    const rows = await gs.listCourses({ search: o.search });
    if (o.json) return rows;
    console.log(table(rows.map((c) => ({ id: c.id, code: c.code, term: c.term, name: c.name })), ['id', 'code', 'term', 'name']));
  },

  async assignments(a, o) {
    need(a, 1, 'assignments <course>');
    const r = await gs.listAssignments({ courseId: a[0] });
    if (o.json) return r;
    console.log(
      table(
        r.assignments.map((x) => ({
          id: x.assignmentId,
          status: x.status,
          score: fmtScore(x.score, x.maxScore),
          due: fmtDate(x.due),
          title: x.title,
        })),
        ['id', 'status', 'score', 'due', 'title'],
      ),
    );
  },

  async upcoming(_, o) {
    const r = await gs.upcoming({ days: o.days ? Number(o.days) : undefined });
    if (o.json) return r;
    if (!r.items.length) return console.log('Nothing due.');
    console.log(
      table(
        r.items.map((x) => ({ due: fmtDate(x.due), status: x.status, course: x.course, assignment: x.title })),
        ['due', 'status', 'course', 'assignment'],
      ),
    );
  },

  async grades(a, o) {
    need(a, 1, 'grades <course>');
    const r = await gs.grades({ courseId: a[0] });
    if (o.json) return r;
    console.log(`${r.graded}/${r.total} graded, ${r.earned}/${r.possible}${r.percent !== undefined ? ` (${r.percent}%)` : ''}\n`);
    console.log(
      table(
        r.assignments.map((x) => ({ id: x.assignmentId, score: fmtScore(x.score, x.maxScore), status: x.status, title: x.title })),
        ['id', 'score', 'status', 'title'],
      ),
    );
  },

  async show(a, o) {
    need(a, 2, 'show <course> <assignment>');
    const s = await gs.getSubmission({ courseId: a[0], assignmentId: a[1], submissionId: o.submission });
    if (o.json) return s;
    printSubmission(s);
  },

  async results(a, o) {
    need(a, 2, 'results <course> <assignment> [--wait]');
    const args = { courseId: a[0], assignmentId: a[1], submissionId: o.submission };
    let r;
    if (o.wait) {
      r = await gs.waitForResults({
        ...args,
        timeout: o.timeout ? Number(o.timeout) : undefined,
        onTick: (s) => !o.json && process.stderr.write(`  autograder ${s.status}…\n`),
      });
      if (!r.finished && !o.json) console.log('Still running; try again later.');
    } else {
      r = await gs.getResults(args);
    }
    if (o.json) return r;
    console.log(`${r.assignment}\nSubmission ${r.submissionId}: ${r.status}, score ${fmtScore(r.score, r.totalPoints)}`);
    if (r.autograder) printAutograder(r.autograder);
    else console.log('No autograder results.');
    console.log(r.url);
  },

  async comments(a, o) {
    need(a, 2, 'comments <course> <assignment>');
    const r = await gs.getComments({ courseId: a[0], assignmentId: a[1], submissionId: o.submission });
    if (o.json) return r;
    console.log(`${r.assignment}  ${fmtScore(r.score, r.totalPoints)}  (regrade requests ${r.regradeRequestsOpen ? 'open' : 'closed'})`);
    if (!r.questions.length) console.log('No feedback yet.');
    for (const q of r.questions) {
      console.log(`\n${q.question}  ${fmtScore(q.score, q.maxScore)}`);
      for (const x of q.rubricApplied) console.log(`  rubric: ${x}`);
      for (const x of q.comments) console.log(`  comment: ${x}`);
      for (const x of q.annotations) console.log(`  annotation: ${x}`);
      for (const g of q.regradeRequests) {
        console.log(`  regrade (${g.status}, ${fmtDate(g.createdAt)})`);
        if (g.yourRequest) console.log(`    you: ${g.yourRequest}`);
        if (g.staffReply) console.log(`    staff: ${g.staffReply}`);
      }
    }
    console.log(`\n${r.url}`);
  },

  async history(a, o) {
    need(a, 2, 'history <course> <assignment>');
    const r = await gs.listSubmissions({ courseId: a[0], assignmentId: a[1], submissionId: o.submission });
    if (o.json) return r;
    console.log(r.assignment);
    console.log(
      table(
        r.submissions.map((s) => ({ id: s.submissionId, submitted: fmtDate(s.submittedAt), active: s.active ? 'yes' : '', score: fmtScore(s.score) })),
        ['id', 'submitted', 'active', 'score'],
      ),
    );
  },

  async submit(a, o) {
    need(a, 3, 'submit <course> <assignment> <file...> [--leaderboard NAME] [--wait] [--dry-run] [--yes]');
    const args = { courseId: a[0], assignmentId: a[1], files: a.slice(2), leaderboardName: o.leaderboard };
    const plan = await gs.submit({ ...args, dryRun: true });
    if (o.json && o['dry-run']) return plan;
    if (!o.json) {
      console.log(`Assignment: ${plan.assignment} (${plan.format})`);
      console.log(`Due: ${fmtDate(plan.due)}`);
      console.log(plan.replacesSubmission ? `Replaces your active submission ${plan.replacesSubmission}` : 'First submission');
      for (const f of plan.files) console.log(`  ${f.name}  ${f.bytes} bytes`);
      if (plan.leaderboardName) console.log(`Leaderboard name: ${plan.leaderboardName}`);
    }
    if (o['dry-run']) return;
    if (!(await confirm('Upload this submission to Gradescope?', o.yes))) return console.log('Cancelled.');
    const r = await gs.submit(args);
    if (!o.json) {
      console.log(`Submitted: ${r.url}`);
      if (r.needsPageSelection) console.log('Open the link to assign pages to questions; Gradescope needs that before grading.');
    }
    if (o.wait && r.format === 'code') {
      return commands.results([a[0], a[1]], { ...o, submission: r.submissionId, wait: true });
    }
    if (o.json) return r;
  },

  async regrade(a, o) {
    need(a, 3, 'regrade <course> <assignment> <question> -m TEXT');
    if (!o.message) throw new UsageError('Give the request text with -m "..."');
    const args = { courseId: a[0], assignmentId: a[1], question: a[2], comment: o.message, submissionId: o.submission };
    const plan = await gs.requestRegrade({ ...args, dryRun: true });
    if (o.json && o['dry-run']) return plan;
    if (!o.json) {
      console.log(`${plan.assignment}\n${plan.question}  ${fmtScore(plan.score, plan.maxScore)}`);
      console.log(`Action: ${plan.action}\nMessage: ${plan.comment}`);
    }
    if (o['dry-run']) return;
    if (!(await confirm('Send this regrade request to the course staff?', o.yes))) return console.log('Cancelled.');
    const r = await gs.requestRegrade(args);
    if (o.json) return r;
    console.log(`Regrade request sent: ${r.url}`);
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
    console.error(`Unknown command "${cmd}". Run gradescope --help.`);
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
    console.error(e.message);
    return e instanceof UsageError ? 2 : 1;
  }
}

// On an expired session: refresh silently, and if that isn't enough and we're
// in a terminal, offer to open the sign-in page. Returns true to retry.
async function recoverSession() {
  if (process.env.MINERVA_NO_AUTO_LOGIN === '1') return false;
  process.stderr.write('Gradescope session expired; refreshing…\n');
  const quiet = await login('gradescope', { interactive: false }).catch(() => ({ signedIn: false }));
  if (quiet.signedIn) return true;
  if (!process.stdin.isTTY) return false;
  if (!(await confirm('Open the Gradescope sign-in page in your browser?', false))) return false;
  return (await runLoginCli('gradescope', { silent: false })) === 0;
}

process.exitCode = await main(process.argv.slice(2));
