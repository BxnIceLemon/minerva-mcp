#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ElicitResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import * as minerva from './minerva.js';
import * as minervaWrite from './minerva-write.js';
import * as gradescope from './gradescope.js';
import { loadSession } from './session.js';
import { agentLogin, pendingLogin, withSessionRefresh } from './login-manager.js';
import { checkForUpdate, applyUpdate } from './update.js';
import {
  listAccounts,
  accountInfo,
  accountExists,
  currentAccount,
  selectAccount,
  selectedAccount,
  withAccount,
  AccountChoiceError,
} from './accounts.js';

const server = new McpServer({ name: 'minerva-leeds', version: '0.1.0' });

const courseId = z
  .string()
  .describe('Course primary id like "_123456_1" (from minerva_list_courses), or the course code');

const accountParam = z
  .string()
  .optional()
  .describe('Saved account to use (see minerva_list_accounts). Only needed when several accounts are saved and the user has not chosen one yet.');

function accountLabel(name) {
  const a = accountInfo(name);
  return a.displayName && a.displayName !== name ? `${name} (${a.displayName})` : name;
}

const NEW_ACCOUNT = '+new';

// Asks the user, through the MCP client's own prompt (elicitation), which saved
// account to use. Returns the account, NEW_ACCOUNT, or null when the client
// can't ask or the user dismissed it.
async function askUser(accounts, { purpose, allowNew = false }) {
  if (!server.server.getClientCapabilities()?.elicitation) return null;
  const options = [...accounts, ...(allowNew ? [NEW_ACCOUNT] : [])];
  try {
    const r = await server.server.request(
      {
        method: 'elicitation/create',
        params: {
          message:
            `Several University accounts are saved: ${accounts.map(accountLabel).join(', ')}. Which one should ${purpose}?` +
            (allowNew ? ` Choose "${NEW_ACCOUNT}" to sign in with another account.` : ''),
          requestedSchema: {
            type: 'object',
            properties: { account: { type: 'string', title: 'Account', enum: options } },
            required: ['account'],
          },
        },
      },
      ElicitResultSchema,
    );
    const pick = r.action === 'accept' ? r.content?.account : null;
    return options.includes(pick) ? pick : null;
  } catch {
    return null;
  }
}

function choiceNeeded(accounts, { allowNew = false } = {}) {
  return new Error(
    `Several accounts are saved: ${accounts.map(accountLabel).join(', ')}. Ask the user which account to use, then call this tool again with ` +
      `account set to it${allowNew ? ' (or newAccount: true to add another account)' : ''}. ` +
      'To use it for the rest of the session, call minerva_select_account.',
  );
}

// The account a tool call works on: `account` if given, else the chosen or
// only saved account. With several accounts, the user is asked, and their
// answer is kept for the rest of the session. null when none is saved yet.
async function resolveAccount(account, purpose) {
  if (account) {
    if (!accountExists(account)) throw new Error(`No saved account "${account}". Saved: ${listAccounts().join(', ') || 'none'}`);
    return account;
  }
  try {
    return currentAccount();
  } catch (e) {
    if (!(e instanceof AccountChoiceError)) throw e;
    const pick = await askUser(e.accounts, { purpose });
    if (!pick) throw choiceNeeded(e.accounts);
    selectAccount(pick);
    return pick;
  }
}

// The update check starts with the server. Its result is added once, to the
// first tool call that comes after it is ready, so the agent can tell the user.
const updateCheck = checkForUpdate();
let updateReady = false;
let updateShown = false;
updateCheck.then(() => (updateReady = true));

function describeUpdate(u) {
  return (
    `minerva-mcp update available: this copy (${u.current.commit}, ${u.current.date}) is ${u.behindBy} commit(s) behind ` +
    `the latest version on GitHub (${u.latest.commit}, ${u.latest.date}).\n` +
    'After you handle the request below, tell the user that an update is available, explain in plain words what the new ' +
    'version adds compared with theirs (use the titles and details of the changes listed here), and ask whether they want ' +
    'to update. Only if they say yes: call minerva_update with dryRun: true, show them the plan, then call it with ' +
    'confirm: true. Never update without their yes. They must restart the MCP client afterwards.' +
    (u.note ? `\nNote: ${u.note}` : '') +
    `\n${JSON.stringify({ current: u.current, latest: u.latest, changes: u.changes, compareUrl: u.compareUrl }, null, 2)}`
  );
}

async function updateNotice() {
  if (updateShown) return null;
  // Wait briefly on the first call; if GitHub is slow, a later call shows it.
  const u = await Promise.race([updateCheck, new Promise((r) => setTimeout(() => r(undefined), 3000))]);
  if (u === undefined && !updateReady) return null;
  updateShown = true;
  return u?.updateAvailable ? describeUpdate(u) : null;
}

/**
 * Registers a tool. Unless `accounts: false`, it takes an optional `account`
 * and runs as that account (see resolveAccount); fn gets (args, account).
 */
function tool(name, description, inputSchema, fn, annotations, { accounts = true } = {}) {
  // Tools registered with readOnlyHint: false change something; the rest are
  // safe to run again (downloads included).
  const rerun = annotations?.readOnlyHint !== false;
  server.registerTool(
    name,
    {
      description,
      inputSchema: accounts ? { ...inputSchema, account: accountParam } : inputSchema,
      annotations: annotations ?? { readOnlyHint: name !== 'minerva_download_attachment', openWorldHint: true },
    },
    async (args) => {
      let response;
      try {
        let result;
        if (accounts) {
          const { account, ...rest } = args ?? {};
          const acct = await resolveAccount(account, `be used for ${name}`);
          result = await withSessionRefresh(() => withAccount(acct, () => fn(rest, acct)), acct, { rerun });
        } else {
          result = await fn(args ?? {});
        }
        response = { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        response = { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
      }
      const notice = name === 'minerva_check_update' || name === 'minerva_update' ? null : await updateNotice();
      if (notice) response.content.unshift({ type: 'text', text: notice });
      return response;
    },
  );
}

tool(
  'minerva_list_accounts',
  'List the saved University accounts (each has its own Minerva and Gradescope sign-in) and which one is chosen for this session. ' +
    'Use when the user asks which accounts are saved, or before asking them which account to use.',
  {},
  () => ({ selected: selectedAccount(), accounts: listAccounts().map(accountInfo) }),
  { readOnlyHint: true, openWorldHint: false },
  { accounts: false },
);

tool(
  'minerva_select_account',
  'Choose which saved account the Minerva and Gradescope tools use for the rest of this session. ' +
    'Call it after the user has said which account they mean; never pick one for them.',
  { account: z.string().describe('A saved account name from minerva_list_accounts') },
  ({ account }) => {
    selectAccount(account);
    return accountInfo(account);
  },
  { readOnlyHint: true, openWorldHint: false },
  { accounts: false },
);

// Status tools report on every account instead of asking which one.
function statusOf(service, account, fn) {
  if (account && !accountExists(account)) throw new Error(`No saved account "${account}". Saved: ${listAccounts().join(', ') || 'none'}`);
  let name = account;
  if (!name) {
    try {
      name = currentAccount();
    } catch (e) {
      if (!(e instanceof AccountChoiceError)) throw e;
      return {
        accounts: e.accounts.map((a) => ({ account: a, ...accountInfo(a)[service], loginInProgress: pendingLogin(service, a) })),
        note: 'Several accounts are saved and none is chosen. Ask the user which one they mean before using the other tools.',
      };
    }
  }
  if (!name) return { signedIn: false, fix: `Call the ${service}_login tool to sign in.` };
  return withAccount(name, () => ({ account: name, ...fn(), loginInProgress: pendingLogin(service, name) }));
}

tool(
  'minerva_status',
  'Check whether a Minerva login session is saved and when it expires. With several saved accounts and none chosen, it lists them all.',
  { account: accountParam },
  ({ account }) =>
    statusOf('minerva', account, () => {
      const s = loadSession();
      if (!s) return { signedIn: false, fix: 'Call the minerva_login tool, or run `npm run login` in the minerva-mcp folder.' };
      return { signedIn: true, userName: s.userName, savedAt: s.savedAt, expiresAt: s.expiresAt };
    }),
  undefined,
  { accounts: false },
);

const waitSeconds = z
  .number()
  .int()
  .min(0)
  .max(240)
  .optional()
  .describe('How long to wait for the sign-in to finish before returning (default 45, which fits the 60 s default tool timeout of Codex)');

for (const [service, label] of [
  ['minerva', 'Minerva'],
  ['gradescope', 'Gradescope'],
]) {
  tool(
    `${service}_login`,
    `Sign in to ${label} or refresh an expired session. Call this whenever a ${label} tool says the session expired or you are not signed in. ` +
      'Each saved account has its own sign-in; with several, pass account (the user is asked when you leave it out). ' +
      'It first refreshes silently (a few seconds, no window). If the user has to sign in, it opens the University sign-in page in their default browser: ' +
      'tell the user a browser window opened and ask them to sign in there. If the result says waitingForUser, call again after the user says they are done. ' +
      'On a machine with no display it returns the terminal command the user should run to sign in there. ' +
      'Never ask the user for their password; they type it in the browser or their own terminal.',
    {
      waitSeconds,
      account: accountParam,
      ...(service === 'minerva'
        ? { newAccount: z.boolean().optional().describe('Sign in someone else and save them as another account') }
        : {}),
    },
    async ({ waitSeconds: w, account, newAccount }) => {
      if (newAccount) return agentLogin(service, { account: null, waitSeconds: w });
      if (account && !accountExists(account)) {
        throw new Error(`No saved account "${account}". Saved: ${listAccounts().join(', ') || 'none'}.${service === 'minerva' ? ' Use newAccount: true to add one.' : ''}`);
      }
      let name = account;
      if (!name) {
        try {
          name = currentAccount();
        } catch (e) {
          if (!(e instanceof AccountChoiceError)) throw e;
          const allowNew = service === 'minerva';
          const pick = await askUser(e.accounts, { purpose: `sign in to ${label}`, allowNew });
          if (!pick) throw choiceNeeded(e.accounts, { allowNew });
          if (pick === NEW_ACCOUNT) return agentLogin(service, { account: null, waitSeconds: w });
          selectAccount(pick);
          name = pick;
        }
      }
      if (!name && service === 'gradescope') {
        throw new Error('No account is saved yet. Sign in to Minerva first (minerva_login); that names the account. Then sign in to Gradescope.');
      }
      return agentLogin(service, { account: name, waitSeconds: w });
    },
    { readOnlyHint: true, openWorldHint: true },
    { accounts: false },
  );
}

tool('minerva_whoami', 'Show the signed-in Minerva user.', {}, () => minerva.whoami());

tool(
  'minerva_list_courses',
  'List the modules/courses you are enrolled in on Minerva, most recently accessed first. Use when the user asks about their courses or modules, or you need a course id for another Minerva tool.',
  {
    search: z.string().optional().describe('Filter by text in the course code or name, e.g. "COMP2011"'),
    includeUnavailable: z.boolean().optional().describe('Include hidden or past courses (default false)'),
  },
  minerva.listCourses,
);

tool(
  'minerva_list_announcements',
  'List recent announcements for a course, newest first.',
  { courseId, limit: z.number().int().min(1).max(100).optional() },
  minerva.listAnnouncements,
);

tool(
  'minerva_list_contents',
  'List items in a course outline. Omit contentId for the top level; pass a folder/learning module id to list its children. Use when the user asks what is in a course, or to find an assignment or other item in it.',
  { courseId, contentId: z.string().optional().describe('Folder id like "_987654_1"') },
  minerva.listContents,
);

tool(
  'minerva_get_content',
  'Get one content item with its full text and the list of its files, including files embedded in the page (ids like "embedded-0"). Use when the user asks for the details of an assignment or other item: its brief, instructions and attached files.',
  { courseId, contentId: z.string() },
  minerva.getContent,
);

tool(
  'minerva_download_attachment',
  'Download a file from a content item (an attachment id, or an "embedded-N" id from minerva_get_content) into the local Downloads/minerva folder and return its path.',
  { courseId, contentId: z.string(), attachmentId: z.string() },
  minerva.downloadAttachment,
);

tool(
  'minerva_my_grades',
  'Show the gradebook for a course: each assessment with due date, your submission status, grade and feedback. Use when the user asks about a course\'s assignments, their grades or feedback.',
  { courseId },
  minerva.myGrades,
);

tool(
  'minerva_upcoming_deadlines',
  'Scan all current courses for gradebook items due in the next N days (default 14), with your submission status.',
  {
    days: z.number().int().min(1).max(180).optional(),
    includePast: z.number().int().min(0).max(60).optional().describe('Also include items due in the past N days'),
  },
  minerva.upcomingDeadlines,
);

tool(
  'minerva_calendar',
  'List Minerva calendar items (course events, due dates, personal events) between two dates. Default: next 4 weeks.',
  {
    since: z.string().optional().describe('ISO date, default now'),
    until: z.string().optional().describe('ISO date, default since + 28 days'),
  },
  minerva.calendar,
);

const mvAssignment = z
  .string()
  .describe('A unique part of the assignment title (e.g. "CW2"), or its content or gradebook column id');

tool(
  'minerva_list_submissions',
  'Show a Minerva assignment\'s submission settings (due date, attempts allowed, file/text allowed) and every attempt you have made, newest first, with status, receipt and files. Use when the user asks for an assignment\'s details (due date, attempts left, what can be submitted) or what they have already submitted, and before submitting.',
  { courseId, assignment: mvAssignment },
  minervaWrite.listSubmissions,
);

tool(
  'minerva_api_get',
  'Read-only escape hatch: GET any Blackboard Learn public REST endpoint under /learn/api/public/.',
  {
    path: z.string().describe('e.g. /learn/api/public/v1/courses/_123_1/contents'),
    params: z.record(z.string(), z.string()).optional().describe('Query parameters'),
  },
  minerva.rawGet,
);

const gsCourse = z
  .string()
  .describe('Gradescope course number like "1234567" (from gradescope_list_courses), or a module code like "COMP3620"');

tool(
  'gradescope_status',
  'Check whether a Gradescope login is saved. With several saved accounts and none chosen, it lists them all.',
  { account: accountParam },
  ({ account }) => statusOf('gradescope', account, () => gradescope.status()),
  undefined,
  { accounts: false },
);

tool(
  'gradescope_list_courses',
  'List your Gradescope courses by term, newest first. Use when the user asks about their Gradescope courses, or you need a course number for another Gradescope tool.',
  { search: z.string().optional().describe('Filter by module code or name') },
  gradescope.listCourses,
);

tool(
  'gradescope_list_assignments',
  'List assignments in a Gradescope course with submission status, score, release, due and late-due dates. Use when the user asks about a course\'s Gradescope assignments or the details of one.',
  { courseId: gsCourse },
  gradescope.listAssignments,
);

const gsAssignment = z
  .string()
  .describe('Assignment id (from gradescope_list_assignments) or a unique part of its title, e.g. "Perceptron"');
const gsSubmission = z.string().optional().describe('Omit to use your active submission');

tool(
  'gradescope_get_submission',
  'Show your submission in full: total score, per-question scores, rubric items, grader comments, annotations, regrade threads and autograder test results. Use when the user asks for the details of a Gradescope assignment they have submitted.',
  { courseId: gsCourse, assignmentId: gsAssignment, submissionId: gsSubmission },
  gradescope.getSubmission,
);

tool(
  'gradescope_get_results',
  'Show the autograder results of a code submission: each test with its score, status and output. Set waitSeconds to poll until a just-uploaded submission finishes running.',
  {
    courseId: gsCourse,
    assignmentId: gsAssignment,
    submissionId: gsSubmission,
    waitSeconds: z.number().int().min(0).max(300).optional().describe('Poll up to this many seconds while the autograder runs'),
  },
  ({ waitSeconds, ...args }) => (waitSeconds ? gradescope.waitForResults({ ...args, timeout: waitSeconds }) : gradescope.getResults(args)),
);

tool(
  'gradescope_get_comments',
  'Show grader feedback on a submission: applied rubric items, comments, annotations, and any regrade requests with the staff replies.',
  { courseId: gsCourse, assignmentId: gsAssignment, submissionId: gsSubmission },
  gradescope.getComments,
);

tool(
  'gradescope_list_submissions',
  'List all your submissions to an assignment, newest first, marking the active one and which earlier ones can be activated.',
  { courseId: gsCourse, assignmentId: gsAssignment },
  gradescope.listSubmissions,
);

tool(
  'gradescope_list_group_members',
  'Show who is in your group submission, the group size limit, and whether members can still be changed.',
  { courseId: gsCourse, assignmentId: gsAssignment, submissionId: gsSubmission },
  gradescope.listGroupMembers,
);

tool(
  'gradescope_grades',
  'Scores for every assignment in a Gradescope course, with the course total so far.',
  { courseId: gsCourse },
  gradescope.grades,
);

tool(
  'gradescope_upcoming',
  'List Gradescope assignments in the current term due in the next N days (default 14), with whether you have submitted.',
  { days: z.number().int().min(1).max(180).optional() },
  gradescope.upcoming,
);

// Write tools. Each call needs confirm: true, and dryRun shows the plan first.
const confirm = z
  .boolean()
  .optional()
  .describe('Must be true to actually send. Only set it after showing the user the dryRun plan and getting their explicit yes.');
const guarded = (fn) => (args) => {
  const { confirm: ok, dryRun, ...rest } = args;
  if (!dryRun && ok !== true) {
    throw new Error('Not sent. Call again with dryRun: true, show the plan to the user, and only then call with confirm: true.');
  }
  return fn({ ...rest, dryRun: Boolean(dryRun) });
};

tool(
  'minerva_check_update',
  'Check whether a newer version of minerva-mcp is on GitHub, and list what it adds. Use when the user asks about updates or what is new.',
  {},
  async () => {
    const u = await checkForUpdate();
    return u.updateAvailable ? { ...u, next: 'Explain the changes to the user and ask whether to update; only then call minerva_update.' } : u;
  },
  { readOnlyHint: true, openWorldHint: true },
  { accounts: false },
);

tool(
  'minerva_update',
  'Update this copy of minerva-mcp to the latest version from GitHub (git fetch, switch to main and fast-forward, npm install). ' +
    'Only use after the user has said yes to updating. Always call with dryRun: true first, show the plan, then call with confirm: true. ' +
    'The user must restart the MCP client afterwards.',
  {
    dryRun: z.boolean().optional().describe('Show the plan without changing anything'),
    confirm,
  },
  guarded(applyUpdate),
  { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  { accounts: false },
);

tool(
  'minerva_submit',
  'Submit files (and optional text) to a Minerva Ultra assignment as a new attempt. Course staff see it at once, and it may count as your graded attempt. Use when the user asks to submit an assignment on Minerva. If the item links to Gradescope, use gradescope_submit instead. Always call with dryRun: true first, show the plan, and wait for the user to confirm.',
  {
    courseId,
    assignment: mvAssignment,
    files: z.array(z.string()).optional().describe('Absolute paths of the files to upload'),
    text: z.string().optional().describe('Text to put in the submission box'),
    dryRun: z.boolean().optional().describe('Validate and return the plan without sending'),
    confirm,
  },
  guarded(minervaWrite.submit),
  { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
);

tool(
  'gradescope_submit',
  'Upload files as your submission to a Gradescope assignment (code, PDF or document). This replaces your active submission and course staff can see it. Use when the user asks to submit an assignment on Gradescope, including one linked from Minerva. Always call with dryRun: true first, show the plan, and wait for the user to confirm.',
  {
    courseId: gsCourse,
    assignmentId: gsAssignment,
    files: z.array(z.string()).min(1).describe('Absolute paths of the files to upload'),
    leaderboardName: z.string().optional().describe('Required when the assignment has a leaderboard'),
    unzip: z
      .boolean()
      .optional()
      .describe('Code uploads only: unpack .zip files and upload their contents, as the website does (default true)'),
    dryRun: z.boolean().optional().describe('Validate and return the plan without uploading'),
    confirm,
  },
  guarded(gradescope.submit),
  { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
);

tool(
  'gradescope_request_regrade',
  'Send a regrade request on one question to the course staff, or update your pending one. The staff will read it. Only use when the user explicitly asks and has approved the exact wording. Always call with dryRun: true first.',
  {
    courseId: gsCourse,
    assignmentId: gsAssignment,
    submissionId: gsSubmission,
    question: z.string().describe('Question number like "2.1", or a unique part of its title'),
    comment: z.string().min(1).describe("The request text, in the user's own words"),
    dryRun: z.boolean().optional().describe('Validate and return the plan without sending'),
    confirm,
  },
  guarded(gradescope.requestRegrade),
  { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
);

tool(
  'gradescope_activate_submission',
  'Make one of your earlier submissions the active (graded) one, replacing the current active submission. Only use when the user explicitly asks. Always call with dryRun: true first, show which submission becomes active, and wait for the user to confirm.',
  {
    courseId: gsCourse,
    assignmentId: gsAssignment,
    submissionId: z.string().describe('The earlier submission to activate (from gradescope_list_submissions)'),
    dryRun: z.boolean().optional().describe('Validate and return the plan without sending'),
    confirm,
  },
  guarded(gradescope.activateSubmission),
  { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
);

tool(
  'gradescope_add_group_members',
  'Add classmates to your group submission by name, email or id. They will be able to see and change the submission. Only use when the user explicitly names who to add. Always call with dryRun: true first.',
  {
    courseId: gsCourse,
    assignmentId: gsAssignment,
    submissionId: gsSubmission,
    members: z.array(z.string()).min(1).describe('Names, emails or ids of the people to add'),
    dryRun: z.boolean().optional().describe('Validate and return the plan without sending'),
    confirm,
  },
  guarded(gradescope.addGroupMembers),
  { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
);

tool(
  'gradescope_remove_group_member',
  'Remove one member from your group submission, or leave the group with member "me" (you then lose access to that submission). Only use when the user explicitly asks. Always call with dryRun: true first.',
  {
    courseId: gsCourse,
    assignmentId: gsAssignment,
    submissionId: gsSubmission,
    member: z.string().describe('Name or id of the group member to remove, or "me" to leave'),
    dryRun: z.boolean().optional().describe('Validate and return the plan without sending'),
    confirm,
  },
  guarded(gradescope.removeGroupMember),
  { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
);

await server.connect(new StdioServerTransport());
