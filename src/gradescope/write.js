// The only two actions that change anything on Gradescope: uploading a
// submission and creating or updating a regrade request. Both validate
// everything first and support dryRun, which returns the plan without sending.
import fs from 'node:fs';
import path from 'node:path';
import { GS_BASE_URL } from '../config.js';
import { request, csrfToken } from './http.js';
import { findAssignment, resolveSubmission, submissionProps } from './read.js';
import { shapeSubmission } from './parse.js';

const MAX_FILE_BYTES = 100 * 1024 * 1024; // Gradescope's upload limit per file

async function submissionTarget(courseId, assignmentId) {
  const { course, assignment } = await findAssignment(courseId, assignmentId);
  if (assignment.submission) {
    return {
      course,
      assignment,
      format: assignment.submission.format,
      postUrl: assignment.submission.postUrl,
      leaderboard: assignment.submission.leaderboard,
      allowed: assignment.canSubmit !== false,
    };
  }
  // Already submitted: the submission page knows how to resubmit.
  const p = await submissionProps(course, assignment.assignmentId, assignment.submissionId);
  return {
    course,
    assignment,
    format: p.assignment?.submission_format,
    postUrl: p.paths?.resubmit_path,
    leaderboard: Boolean(p.assignment?.leaderboard_enabled),
    allowed: Boolean(p.assignment?.submission_allowed),
  };
}

function checkFiles(format, files) {
  if (!files?.length) throw new Error('No files given');
  const list = files.map((f) => {
    const full = path.resolve(f);
    if (!fs.existsSync(full)) throw new Error(`File not found: ${f}`);
    const st = fs.statSync(full);
    if (!st.isFile()) throw new Error(`Not a file: ${f} (zip a folder first; Gradescope unzips code uploads)`);
    if (st.size > MAX_FILE_BYTES) throw new Error(`${f} is larger than Gradescope's 100 MB limit`);
    return { path: full, name: path.basename(full), bytes: st.size };
  });
  if (format === 'fixed_length' || format === 'variable_length') {
    if (list.length !== 1 || !/\.pdf$/i.test(list[0].name)) throw new Error('This assignment takes exactly one PDF file');
  } else if (format === 'typed_document') {
    if (list.length !== 1) throw new Error('This assignment takes exactly one file');
  }
  return list;
}

function submissionIdFrom(url) {
  return url?.match(/submissions\/(\d+)/)?.[1];
}

/**
 * Uploads files as a new submission (or a resubmission, which replaces the
 * active one). Supports code, PDF and typed-document assignments. Online
 * quizzes can only be answered in the browser.
 */
export async function submit({ courseId, assignmentId, files, leaderboardName, dryRun = false }) {
  const t = await submissionTarget(courseId, assignmentId);
  const { course, assignment, format } = t;
  if (format === 'online') {
    throw new Error(`"${assignment.title}" is an online assignment; answer it in the browser: ${assignment.url}`);
  }
  if (!['code', 'fixed_length', 'variable_length', 'typed_document'].includes(format)) {
    throw new Error(`Unsupported submission format "${format}" for "${assignment.title}"`);
  }
  if (!t.allowed) throw new Error(`Gradescope is not accepting submissions for "${assignment.title}" right now`);
  if (!t.postUrl) throw new Error('Could not find where to upload this submission');
  if (format === 'code' && t.leaderboard && !leaderboardName) {
    throw new Error('This assignment has a leaderboard; give a leaderboard name');
  }
  const list = checkFiles(format, files);

  const plan = {
    course,
    assignmentId: assignment.assignmentId,
    assignment: assignment.title,
    format,
    due: assignment.due,
    replacesSubmission: assignment.submissionId ?? null,
    files: list.map(({ name, bytes }) => ({ name, bytes })),
    leaderboardName: format === 'code' ? leaderboardName : undefined,
    postUrl: `${GS_BASE_URL}${t.postUrl}`,
  };
  if (dryRun) return { dryRun: true, ...plan };

  const token = await csrfToken(`/courses/${course}`);
  const form = new FormData();
  form.append('utf8', '✓');
  form.append('authenticity_token', token);
  if (format === 'code') {
    form.append('submission[method]', 'upload');
    if (leaderboardName) form.append('submission[leaderboard_name]', leaderboardName);
    for (const f of list) form.append('submission[files][]', await fs.openAsBlob(f.path), f.name);
  } else {
    const field = format === 'typed_document' ? 'file' : 'pdf_attachment';
    form.append(field, await fs.openAsBlob(list[0].path), list[0].name);
  }

  const res = await request('POST', t.postUrl, {
    body: form,
    accept: format === 'code' ? 'application/json' : 'text/html',
    headers: { 'X-CSRF-Token': token, 'X-Requested-With': 'XMLHttpRequest' },
  });

  let target;
  if (res.status >= 300 && res.status < 400) {
    target = res.headers.get('location');
  } else if (res.ok && (res.headers.get('content-type') ?? '').includes('json')) {
    target = (await res.json()).url;
  } else if (res.ok) {
    target = res.url;
  }
  const submissionId = submissionIdFrom(target);
  if (!submissionId) {
    const detail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
    throw new Error(`Upload was not accepted (HTTP ${res.status})${detail ? `: ${detail}` : ''}`);
  }
  const url = new URL(target, GS_BASE_URL).toString();
  return {
    submitted: true,
    ...plan,
    submissionId,
    url,
    // Variable-length PDFs need pages assigned to questions in the browser.
    needsPageSelection: /select_pages/.test(url) || format === 'variable_length',
  };
}

function findQuestion(questions, key) {
  const k = String(key).trim();
  const byNumber = questions.find((q) => q.number === k || String(q.questionId) === k);
  if (byNumber) return byNumber;
  const matches = questions.filter((q) => q.question?.toLowerCase().includes(k.toLowerCase()));
  if (matches.length === 1) return matches[0];
  if (!matches.length) throw new Error(`No question matches "${k}". Use a number like ${questions[0]?.number ?? '1.1'}`);
  throw new Error(`"${k}" matches several questions: ${matches.map((q) => q.number).join(', ')}`);
}

/**
 * Asks the grader to look at one question again. If you already have a
 * pending request on that question, its text is replaced instead.
 */
export async function requestRegrade({ courseId, assignmentId, submissionId, question, comment, dryRun = false }) {
  if (!comment?.trim()) throw new Error('Write a comment explaining the regrade request');
  const { course, assignment, sub } = await resolveSubmission({ courseId, assignmentId, submissionId });
  const subPath = `/courses/${course}/assignments/${assignment.assignmentId}/submissions/${sub}`;
  const p = await submissionProps(course, assignment.assignmentId, sub);
  const s = shapeSubmission(p, `${GS_BASE_URL}${subPath}`);
  if (!s.regradeRequestsOpen) throw new Error(`Regrade requests are closed for "${s.assignment}"`);
  const q = findQuestion(s.questions, question);
  if (!q.questionSubmissionId) throw new Error(`Question ${q.number} has no graded answer to regrade`);
  const base = p.paths?.regrade_requests_path ?? `${subPath}/regrade_requests`;
  const pending = q.regradeRequests.find((r) => r.status === 'pending');

  const plan = {
    assignment: s.assignment,
    submissionId: String(sub),
    question: q.question,
    score: q.score,
    maxScore: q.maxScore,
    action: pending ? 'update pending request' : 'create request',
    comment: comment.trim(),
  };
  if (dryRun) return { dryRun: true, ...plan };

  const token = await csrfToken(subPath);
  const body = new URLSearchParams({
    'regrade_request[student_comment]': comment.trim(),
    'regrade_request[question_submission_id]': String(q.questionSubmissionId),
  });
  const res = await request(pending ? 'PATCH' : 'POST', pending ? `${base}/${pending.id}` : base, {
    body,
    accept: 'application/json',
    headers: { 'X-CSRF-Token': token, 'X-Requested-With': 'XMLHttpRequest' },
  });
  if (res.status === 403) throw new Error('Gradescope refused the regrade request (the window may be closed)');
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
    throw new Error(`Regrade request failed (HTTP ${res.status})${detail ? `: ${detail}` : ''}`);
  }
  const saved = await res.json().catch(() => ({}));
  return { sent: true, ...plan, regradeRequestId: saved.id, url: s.url };
}
