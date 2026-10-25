#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as minerva from './minerva.js';
import * as gradescope from './gradescope.js';
import { loadSession } from './session.js';
import { agentLogin, pendingLogin } from './login-manager.js';

const server = new McpServer({ name: 'minerva-leeds', version: '0.1.0' });

const courseId = z
  .string()
  .describe('Course primary id like "_123456_1" (from minerva_list_courses), or the course code');

function tool(name, description, inputSchema, fn, annotations) {
  server.registerTool(
    name,
    {
      description,
      inputSchema,
      annotations: annotations ?? { readOnlyHint: name !== 'minerva_download_attachment', openWorldHint: true },
    },
    async (args) => {
      try {
        const result = await fn(args ?? {});
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
      }
    },
  );
}

tool(
  'minerva_status',
  'Check whether a Minerva login session is saved and when it expires.',
  {},
  async () => {
    const s = loadSession();
    const pending = pendingLogin('minerva');
    if (!s) return { signedIn: false, loginInProgress: pending, fix: 'Call the minerva_login tool, or run `npm run login` in the minerva-mcp folder.' };
    return { signedIn: true, userName: s.userName, savedAt: s.savedAt, expiresAt: s.expiresAt, loginInProgress: pending };
  },
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
      'It first refreshes silently (a few seconds, no window). If the user has to sign in, it opens the University sign-in page in their default browser: ' +
      'tell the user a browser window opened and ask them to sign in there. If the result says waitingForUser, call again after the user says they are done. ' +
      'Never ask the user for their password; they type it in the browser.',
    { waitSeconds },
    ({ waitSeconds: w }) => agentLogin(service, { waitSeconds: w }),
    { readOnlyHint: true, openWorldHint: true },
  );
}

tool('minerva_whoami', 'Show the signed-in Minerva user.', {}, () => minerva.whoami());

tool(
  'minerva_list_courses',
  'List the modules/courses you are enrolled in on Minerva, most recently accessed first.',
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
  'List items in a course outline. Omit contentId for the top level; pass a folder/learning module id to list its children.',
  { courseId, contentId: z.string().optional().describe('Folder id like "_987654_1"') },
  minerva.listContents,
);

tool(
  'minerva_get_content',
  'Get one content item with its full text and the list of attached files.',
  { courseId, contentId: z.string() },
  minerva.getContent,
);

tool(
  'minerva_download_attachment',
  'Download a file attached to a content item into the local Downloads/minerva folder and return its path.',
  { courseId, contentId: z.string(), attachmentId: z.string() },
  minerva.downloadAttachment,
);

tool(
  'minerva_my_grades',
  'Show the gradebook for a course: each assessment with due date, your submission status, grade and feedback.',
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
  'Check whether a Gradescope login is saved.',
  {},
  () => ({ ...gradescope.status(), loginInProgress: pendingLogin('gradescope') }),
);

tool(
  'gradescope_list_courses',
  'List your Gradescope courses by term, newest first.',
  { search: z.string().optional().describe('Filter by module code or name') },
  gradescope.listCourses,
);

tool(
  'gradescope_list_assignments',
  'List assignments in a Gradescope course with submission status, score, release, due and late-due dates.',
  { courseId: gsCourse },
  gradescope.listAssignments,
);

const gsAssignment = z
  .string()
  .describe('Assignment id (from gradescope_list_assignments) or a unique part of its title, e.g. "Perceptron"');
const gsSubmission = z.string().optional().describe('Omit to use your active submission');

tool(
  'gradescope_get_submission',
  'Show your submission in full: total score, per-question scores, rubric items, grader comments, annotations, regrade threads and autograder test results.',
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
  'List all your submissions to an assignment, newest first, marking the active one.',
  { courseId: gsCourse, assignmentId: gsAssignment },
  gradescope.listSubmissions,
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

// Write tools exist only when the user opts in with GRADESCOPE_ALLOW_WRITE=1.
// Even then each call needs confirm: true, and dryRun shows the plan first.
if (process.env.GRADESCOPE_ALLOW_WRITE === '1') {
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
    'gradescope_submit',
    'Upload files as your submission to a Gradescope assignment (code, PDF or document). This replaces your active submission and course staff can see it. Only use when the user explicitly asks to submit. Always call with dryRun: true first, show the plan, and wait for the user to confirm.',
    {
      courseId: gsCourse,
      assignmentId: gsAssignment,
      files: z.array(z.string()).min(1).describe('Absolute paths of the files to upload'),
      leaderboardName: z.string().optional().describe('Required when the assignment has a leaderboard'),
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
}

await server.connect(new StdioServerTransport());
