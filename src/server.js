#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as minerva from './minerva.js';
import * as gradescope from './gradescope.js';
import { loadSession } from './session.js';

const server = new McpServer({ name: 'minerva-leeds', version: '0.1.0' });

const courseId = z
  .string()
  .describe('Course primary id like "_123456_1" (from minerva_list_courses), or the course code');

function tool(name, description, inputSchema, fn) {
  server.registerTool(
    name,
    { description, inputSchema, annotations: { readOnlyHint: name !== 'minerva_download_attachment', openWorldHint: true } },
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
  'Check whether a Minerva login session is saved and when it expires. Call this first if other tools report an expired session.',
  {},
  async () => {
    const s = loadSession();
    if (!s) return { signedIn: false, fix: 'Run `npm run login` in the minerva-mcp folder.' };
    return { signedIn: true, userName: s.userName, savedAt: s.savedAt, expiresAt: s.expiresAt };
  },
);

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
  .describe('Gradescope course number like "1404490" (from gradescope_list_courses), or a module code like "COMP3620"');

tool(
  'gradescope_status',
  'Check whether a Gradescope login is saved. Call this first if Gradescope tools report an expired session.',
  {},
  gradescope.status,
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

tool(
  'gradescope_get_submission',
  'Show your graded submission: total score, per-question scores, applied rubric items, grader comments and autograder test results.',
  {
    courseId: gsCourse,
    assignmentId: z.string(),
    submissionId: z.string().optional().describe('Omit to use your latest submission'),
  },
  gradescope.getSubmission,
);

tool(
  'gradescope_upcoming',
  'List Gradescope assignments in the current term due in the next N days (default 14), with whether you have submitted.',
  { days: z.number().int().min(1).max(180).optional() },
  gradescope.upcoming,
);

await server.connect(new StdioServerTransport());
