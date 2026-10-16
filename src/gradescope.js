// Gradescope has no public student API, so this reads the same HTML pages
// you see in the browser. Every request is a GET to www.gradescope.com.
import * as cheerio from 'cheerio';
import { GS_BASE_URL, GS_HOST, GS_SESSION_FILE } from './config.js';
import { loadSession } from './session.js';
import { SessionError } from './client.js';

const EXPIRED = 'Gradescope session expired. Run `npm run login:gradescope` in the minerva-mcp folder.';

async function page(path) {
  const s = loadSession(GS_SESSION_FILE);
  if (!s) throw new SessionError('Not signed in to Gradescope. Run `npm run login:gradescope` first.');
  const u = new URL(path, GS_BASE_URL);
  if (u.protocol !== 'https:' || u.host !== GS_HOST) {
    throw new Error(`Refusing to send the Gradescope session to ${u.host}`);
  }
  const r = await fetch(u, {
    headers: { Cookie: s.cookies.map((c) => `${c.name}=${c.value}`).join('; '), Accept: 'text/html' },
    redirect: 'manual',
  });
  if (r.status >= 300 && r.status < 400) {
    const to = new URL(r.headers.get('location'), u);
    if (to.pathname === '/login' || to.pathname === '/') throw new SessionError(EXPIRED);
    throw new Error(`Gradescope redirected ${u.pathname} to ${to.pathname}`);
  }
  if (r.status === 401) throw new SessionError(EXPIRED);
  if (!r.ok) throw new Error(`Gradescope HTTP ${r.status} for ${u.pathname}`);
  return cheerio.load(await r.text());
}

// "2026-10-21 23:59:00 +0100" -> ISO 8601
function isoDate(s) {
  const m = s?.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2})$/);
  return m ? new Date(`${m[1]}T${m[2]}${m[3]}:${m[4]}`).toISOString() : s || undefined;
}

function clean(t) {
  return t?.replace(/\s+/g, ' ').trim() || undefined;
}

export async function listCourses({ search } = {}) {
  const $ = await page('/account');
  const courses = [];
  $('.courseList--term').each((_, term) => {
    const termName = clean($(term).text());
    $(term).next('.courseList--coursesForTerm').find('a.courseBox').each((_, a) => {
      courses.push({
        id: $(a).attr('href').split('/').pop(),
        code: clean($(a).find('.courseBox--shortname').text()),
        name: clean($(a).find('.courseBox--name').text()),
        term: termName,
        assignments: clean($(a).find('.courseBox--assignments').text()),
      });
    });
  });
  if (!search) return courses;
  const q = search.toLowerCase();
  return courses.filter((c) => `${c.code} ${c.name}`.toLowerCase().includes(q));
}

// Accept a Gradescope course number ("1404490") or a module code ("COMP3620");
// account pages list the newest term first, so the first match is current.
async function courseNumber(id) {
  const s = String(id).trim();
  if (/^\d+$/.test(s)) return s;
  const match = (await listCourses()).find((c) => c.code?.toUpperCase().endsWith(s.toUpperCase()));
  if (!match) throw new Error(`No Gradescope course matches "${s}"`);
  return match.id;
}

export async function listAssignments({ courseId }) {
  const course = await courseNumber(courseId);
  const $ = await page(`/courses/${course}`);
  const rows = [];
  $('#assignments-student-table tbody tr').each((_, tr) => {
    const row = $(tr);
    const head = row.find('th.table--primaryLink');
    const link = head.find('a').attr('href');
    const button = head.find('[data-assignment-id]');
    const parts = link?.match(/assignments\/(\d+)(?:\/submissions\/(\d+))?/);
    const status = row.find('td.submissionStatus');
    const score = clean(status.find('.submissionStatus--score').text());
    const [got, max] = score?.split('/').map((x) => Number(x.trim())) ?? [];
    const dues = row.find('time.submissionTimeChart--dueDate');
    rows.push({
      assignmentId: parts?.[1] ?? button.attr('data-assignment-id'),
      submissionId: parts?.[2],
      title: clean(head.text()),
      status: score ? 'Graded' : clean(status.find('.submissionStatus--text').text()) ?? clean(status.text()),
      score: Number.isFinite(got) ? got : undefined,
      maxScore: Number.isFinite(max) ? max : undefined,
      late: clean(status.children('div').not('.submissionStatus--score, .submissionStatus--bullet, .submissionStatus--text').text()),
      released: isoDate(row.find('time.submissionTimeChart--releaseDate').attr('datetime')),
      due: isoDate(dues.eq(0).attr('datetime')),
      lateDue: dues.length > 1 ? isoDate(dues.eq(1).attr('datetime')) : undefined,
      timeLeft: clean(row.find('.submissionTimeChart--timeRemaining').text()),
      canSubmit: button.length ? button.attr('data-ready-for-submission') === 'true' : undefined,
      url: `${GS_BASE_URL}${link ?? `/courses/${course}`}`,
    });
  });
  return { courseId: course, assignments: rows };
}

function reactProps($, cls) {
  const raw = $(`[data-react-class="${cls}"]`).attr('data-react-props');
  return raw ? JSON.parse(raw) : null;
}

export async function getSubmission({ courseId, assignmentId, submissionId }) {
  const course = await courseNumber(courseId);
  let sub = submissionId;
  if (!sub) {
    const { assignments } = await listAssignments({ courseId: course });
    sub = assignments.find((a) => a.assignmentId === String(assignmentId))?.submissionId;
    if (!sub) throw new Error('No submission found for this assignment yet');
  }
  const $ = await page(`/courses/${course}/assignments/${assignmentId}/submissions/${sub}`);
  const p = reactProps($, 'AssignmentSubmissionViewer');
  if (!p) throw new Error('Could not read the submission page (Gradescope layout may have changed)');

  const subs = new Map((p.question_submissions ?? []).map((q) => [q.question_id, q]));
  const rubric = new Map();
  for (const r of p.rubric_items ?? []) {
    if (!rubric.has(r.question_id)) rubric.set(r.question_id, []);
    rubric.get(r.question_id).push(r);
  }
  // Only leaf questions carry scores; groups are just headings. Sort by the
  // question number ("1.2" before "1.10") rather than the page's internal order.
  const questions = (p.questions ?? [])
    .filter((q) => q.type !== 'QuestionGroup')
    .sort((a, b) => String(a.full_index).localeCompare(String(b.full_index), undefined, { numeric: true }))
    .map((q) => {
      const s = subs.get(q.id);
      return {
        question: q.numbered_title ?? q.title,
        maxScore: Number(q.weight),
        score: s?.score != null ? Number(s.score) : undefined,
        rubricApplied: (rubric.get(q.id) ?? []).filter((r) => r.present).map((r) => `${r.description} (${r.weight})`),
        comments: (s?.evaluations ?? []).map((e) => e.comments).filter(Boolean),
      };
    });

  const ag = p.autograder_results;
  return {
    assignment: p.assignment?.title,
    totalPoints: Number(p.assignment?.total_points),
    due: p.assignment?.due_date,
    gradesVisible: p.grades_visible,
    submittedAt: p.assignment_submission?.created_at,
    score: p.assignment_submission?.score != null ? Number(p.assignment_submission.score) : undefined,
    lateness: p.assignment_submission?.lateness_in_words || undefined,
    questions,
    autograder: ag
      ? {
          score: ag.score,
          output: ag.output?.slice(0, 4000) || undefined,
          tests: (ag.tests ?? []).map((t) => ({
            name: t.name,
            score: t.score,
            maxScore: t.max_score,
            status: t.status,
            output: t.output?.slice(0, 1000) || undefined,
          })),
        }
      : undefined,
    url: `${GS_BASE_URL}/courses/${course}/assignments/${assignmentId}/submissions/${sub}`,
  };
}

export async function upcoming({ days = 14 } = {}) {
  const now = Date.now();
  const until = now + days * 86400000;
  const courses = await listCourses();
  // Only the newest term: older terms are closed and just add requests.
  const terms = [...new Set(courses.map((c) => c.term))].slice(0, 1);
  const current = courses.filter((c) => terms.includes(c.term));
  const items = [];
  for (const c of current) {
    const { assignments } = await listAssignments({ courseId: c.id });
    for (const a of assignments) {
      const due = Date.parse(a.due ?? '');
      const lateDue = Date.parse(a.lateDue ?? '');
      const open = (due >= now && due <= until) || (a.status !== 'Graded' && !a.submissionId && lateDue >= now && lateDue <= until);
      if (open) items.push({ course: c.name, courseId: c.id, ...a });
    }
  }
  items.sort((x, y) => String(x.due ?? '').localeCompare(String(y.due ?? '')));
  return { terms, coursesChecked: current.length, items };
}

export function status() {
  const s = loadSession(GS_SESSION_FILE);
  if (!s) return { signedIn: false, fix: 'Run `npm run login:gradescope` in the minerva-mcp folder.' };
  return { signedIn: true, savedAt: s.savedAt, rememberMeExpires: s.expiresAt };
}
