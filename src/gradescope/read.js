// Read-only Gradescope features: courses, assignments, grades, submissions,
// autograder results and feedback. Only GET requests.
import { GS_BASE_URL, GS_SESSION_FILE } from '../config.js';
import { loadSession } from '../session.js';
import { html, json } from './http.js';
import { parseCourses, parseAssignments, reactProps, shapeSubmission, shapeHistory, shapeGroup } from './parse.js';

export function status() {
  const s = loadSession(GS_SESSION_FILE);
  if (!s) return { signedIn: false, fix: 'Call the gradescope_login tool, or run `gradescope login` (`npm run login:gradescope`).' };
  return { signedIn: true, savedAt: s.savedAt, rememberMeExpires: s.expiresAt };
}

export async function listCourses({ search } = {}) {
  const courses = parseCourses(await html('/account'));
  if (!search) return courses;
  const q = search.toLowerCase();
  return courses.filter((c) => `${c.code} ${c.name}`.toLowerCase().includes(q));
}

// Accept a Gradescope course number ("1234567") or a module code ("COMP3620");
// account pages list the newest term first, so the first match is current.
export async function courseNumber(id) {
  const s = String(id).trim();
  if (/^\d+$/.test(s)) return s;
  const match = (await listCourses()).find((c) => c.code?.toUpperCase().endsWith(s.toUpperCase()));
  if (!match) throw new Error(`No Gradescope course matches "${s}"`);
  return match.id;
}

export async function listAssignments({ courseId }) {
  const course = await courseNumber(courseId);
  return { courseId: course, assignments: parseAssignments(await html(`/courses/${course}`), course) };
}

// Accept an assignment id or a case-insensitive piece of its title.
export async function findAssignment(courseId, assignment) {
  const { courseId: course, assignments } = await listAssignments({ courseId });
  const key = String(assignment).trim();
  const exact = assignments.find((a) => a.assignmentId === key);
  if (exact) return { course, assignment: exact };
  const matches = assignments.filter((a) => a.title?.toLowerCase().includes(key.toLowerCase()));
  if (matches.length === 1) return { course, assignment: matches[0] };
  if (!matches.length) throw new Error(`No assignment in course ${course} matches "${key}"`);
  throw new Error(`"${key}" matches several assignments: ${matches.map((a) => `${a.assignmentId} (${a.title})`).join(', ')}`);
}

// The submission viewer's data. Code and PDF submissions serve it as JSON;
// online (quiz) submissions only embed it in the HTML page.
export async function submissionProps(course, assignmentId, submissionId) {
  const base = `/courses/${course}/assignments/${assignmentId}/submissions/${submissionId}`;
  try {
    return await json(`${base}.json?content=react`);
  } catch (e) {
    if (!/HTTP 404/.test(e.message)) throw e;
    const p = reactProps(await html(base));
    if (!p) throw new Error('Could not read the submission page (Gradescope layout may have changed)');
    return p;
  }
}

export async function resolveSubmission({ courseId, assignmentId, submissionId }) {
  const { course, assignment } = await findAssignment(courseId, assignmentId);
  const sub = submissionId ? String(submissionId) : assignment.submissionId;
  if (!sub) throw new Error(`No submission yet for "${assignment.title}"`);
  return { course, assignment, sub };
}

export async function getSubmission(args) {
  const { course, assignment, sub } = await resolveSubmission(args);
  const p = await submissionProps(course, assignment.assignmentId, sub);
  return shapeSubmission(p, `${GS_BASE_URL}/courses/${course}/assignments/${assignment.assignmentId}/submissions/${sub}`);
}

export async function submissionHistory(course, assignmentId, sub) {
  const base = `/courses/${course}/assignments/${assignmentId}/submissions/${sub}`;
  // The viewer loads history on demand with only_keys[]=past_submissions.
  let p;
  try {
    p = await json(`${base}.json?content=react&only_keys[]=past_submissions`);
  } catch {
    p = await submissionProps(course, assignmentId, sub);
  }
  return shapeHistory(p);
}

export async function listSubmissions(args) {
  const { course, assignment, sub } = await resolveSubmission(args);
  const history = await submissionHistory(course, assignment.assignmentId, sub);
  return {
    assignment: assignment.title,
    submissions: history.map(({ activatePath, ...s }) => s),
  };
}

/** Who owns your submission, and whether the group can still be changed. */
export async function listGroupMembers(args) {
  const { course, assignment, sub } = await resolveSubmission(args);
  const p = await submissionProps(course, assignment.assignmentId, sub);
  return { submissionId: String(sub), ...shapeGroup(p) };
}

/** Autograder output only. */
export async function getResults(args) {
  const s = await getSubmission(args);
  return {
    assignment: s.assignment,
    submissionId: s.submissionId,
    status: s.status,
    score: s.score,
    totalPoints: s.totalPoints,
    autograder: s.autograder ?? null,
    url: s.url,
  };
}

/** Grader feedback only: rubric items, comments, annotations and regrade threads. */
export async function getComments(args) {
  const s = await getSubmission(args);
  return {
    assignment: s.assignment,
    submissionId: s.submissionId,
    score: s.score,
    totalPoints: s.totalPoints,
    regradeRequestsOpen: s.regradeRequestsOpen,
    questions: s.questions
      .filter((q) => q.rubricApplied.length || q.comments.length || q.annotations.length || q.regradeRequests.length)
      .map(({ number, question, score, maxScore, rubricApplied, comments, annotations, regradeRequests }) => ({
        number,
        question,
        score,
        maxScore,
        rubricApplied,
        comments,
        annotations,
        regradeRequests,
      })),
    url: s.url,
  };
}

// The autograder is done when the submission leaves its processing states.
const RUNNING = new Set(['unprocessed', 'processing', 'queued', 'running', 'pending', 'started']);

/**
 * Polls a submission until the autograder finishes or `timeout` seconds pass.
 * Online (quiz) submissions stay "unprocessed" forever, so they return at once.
 */
export async function waitForResults({ timeout = 600, interval = 5, onTick, ...args }) {
  const { course, assignment, sub } = await resolveSubmission(args);
  const url = `${GS_BASE_URL}/courses/${course}/assignments/${assignment.assignmentId}/submissions/${sub}`;
  const deadline = Date.now() + timeout * 1000;
  for (;;) {
    const p = await submissionProps(course, assignment.assignmentId, sub);
    const s = shapeSubmission(p, url);
    const running = s.format === 'code' && RUNNING.has(String(s.status));
    if (!running) return { ...s, finished: true };
    if (Date.now() >= deadline) return { ...s, finished: false };
    onTick?.(s);
    await new Promise((r) => setTimeout(r, interval * 1000));
  }
}

export async function grades({ courseId }) {
  const { courseId: course, assignments } = await listAssignments({ courseId });
  const graded = assignments.filter((a) => a.score !== undefined);
  const earned = graded.reduce((n, a) => n + a.score, 0);
  const possible = graded.reduce((n, a) => n + (a.maxScore ?? 0), 0);
  return {
    courseId: course,
    graded: graded.length,
    total: assignments.length,
    earned,
    possible,
    percent: possible ? Math.round((earned / possible) * 1000) / 10 : undefined,
    assignments: assignments.map(({ assignmentId, title, status, score, maxScore, late, due }) => ({
      assignmentId,
      title,
      status,
      score,
      maxScore,
      late,
      due,
    })),
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
      if (open) items.push({ course: c.name, courseId: c.id, ...a, submission: undefined });
    }
  }
  items.sort((x, y) => String(x.due ?? '').localeCompare(String(y.due ?? '')));
  return { terms, coursesChecked: current.length, items };
}
