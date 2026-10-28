// Every action that changes anything on Gradescope lives here: uploading a
// submission, making an earlier submission active, adding or removing group
// members, and creating or updating a regrade request. Each one validates
// everything first and supports dryRun, which returns the plan without sending.
import fs from 'node:fs';
import path from 'node:path';
import { GS_BASE_URL } from '../config.js';
import { request, csrfToken } from './http.js';
import { findAssignment, resolveSubmission, submissionProps, submissionHistory } from './read.js';
import { shapeSubmission, shapeGroup, planActivate, planAddMembers, planRemoveMember } from './parse.js';
import { expandZip } from './zip.js';

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

export function checkFiles(format, files, { unzip = true } = {}) {
  if (!files?.length) throw new Error('No files given');
  const list = files.map((f) => {
    const full = path.resolve(f);
    if (!fs.existsSync(full)) throw new Error(`File not found: ${f}`);
    const st = fs.statSync(full);
    if (!st.isFile()) throw new Error(`Not a file: ${f} (zip a folder first; it is unpacked before upload)`);
    if (st.size > MAX_FILE_BYTES) throw new Error(`${f} is larger than Gradescope's 100 MB limit`);
    return { path: full, name: path.basename(full), bytes: st.size };
  });
  if (format === 'fixed_length' || format === 'variable_length') {
    if (list.length !== 1 || !/\.pdf$/i.test(list[0].name)) throw new Error('This assignment takes exactly one PDF file');
  } else if (format === 'typed_document') {
    if (list.length !== 1) throw new Error('This assignment takes exactly one file');
  }
  if (format !== 'code' || !unzip) return list;

  // Like the web uploader: a .zip is unpacked and its files are uploaded one
  // by one, keeping their paths inside the archive.
  const out = [];
  for (const f of list) {
    if (/\.zip$/i.test(f.name)) {
      for (const e of expandZip(fs.readFileSync(f.path), f.name)) out.push({ ...e, from: f.name });
    } else {
      out.push(f);
    }
  }
  const seen = new Map();
  for (const f of out) {
    if (f.bytes > MAX_FILE_BYTES) throw new Error(`${f.name} is larger than Gradescope's 100 MB limit`);
    const prev = seen.get(f.name);
    if (prev) throw new Error(`Two files would both upload as "${f.name}" (${prev.from ?? prev.path} and ${f.from ?? f.path})`);
    seen.set(f.name, f);
  }
  return out;
}

function submissionIdFrom(url) {
  return url?.match(/submissions\/(\d+)/)?.[1];
}

/**
 * Uploads files as a new submission (or a resubmission, which replaces the
 * active one). Supports code, PDF and typed-document assignments. Online
 * quizzes can only be answered in the browser.
 */
export async function submit({ courseId, assignmentId, files, leaderboardName, unzip = true, dryRun = false }) {
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
  const list = checkFiles(format, files, { unzip });

  const plan = {
    course,
    assignmentId: assignment.assignmentId,
    assignment: assignment.title,
    format,
    due: assignment.due,
    replacesSubmission: assignment.submissionId ?? null,
    files: list.map(({ name, bytes, from }) => ({ name, bytes, from })),
    unzipped: list.some((f) => f.from) ? [...new Set(list.filter((f) => f.from).map((f) => f.from))] : undefined,
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
    for (const f of list) {
      const blob = f.data ? new Blob([f.data], { type: 'application/octet-stream' }) : await fs.openAsBlob(f.path);
      form.append('submission[files][]', blob, f.name);
    }
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

async function failure(res, what) {
  const detail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
  if (res.status === 403) return new Error(`Gradescope refused to ${what} (not allowed for this assignment)`);
  return new Error(`Could not ${what} (HTTP ${res.status})${detail ? `: ${detail}` : ''}`);
}

const XHR = (token) => ({ 'X-CSRF-Token': token, 'X-Requested-With': 'XMLHttpRequest' });

/**
 * Makes one of your earlier submissions the active (graded) one, like the
 * "Activate" button in the submission history.
 */
export async function activateSubmission({ courseId, assignmentId, submissionId, dryRun = false }) {
  if (!submissionId) throw new Error('Give the id of the submission to make active (see the submission history)');
  const { course, assignment, sub } = await resolveSubmission({ courseId, assignmentId });
  const history = await submissionHistory(course, assignment.assignmentId, sub);
  const target = planActivate(history, submissionId);
  const current = history.find((s) => s.active);

  const plan = {
    assignment: assignment.title,
    activate: { submissionId: String(target.submissionId), submittedAt: target.submittedAt, score: target.score },
    replaces: current ? { submissionId: String(current.submissionId), submittedAt: current.submittedAt, score: current.score } : null,
  };
  if (dryRun) return { dryRun: true, ...plan };

  const token = await csrfToken(`/courses/${course}/assignments/${assignment.assignmentId}/submissions/${sub}`);
  const res = await request('POST', target.activatePath, {
    body: new URLSearchParams({ authenticity_token: token }),
    headers: { 'X-CSRF-Token': token },
  });
  if (!(res.ok || (res.status >= 300 && res.status < 400))) throw await failure(res, 'activate the submission');

  const after = await submissionHistory(course, assignment.assignmentId, target.submissionId);
  const active = after.find((s) => s.active);
  if (String(active?.submissionId) !== String(target.submissionId)) {
    throw new Error('Gradescope accepted the request, but the submission is not shown as active. Check it in the browser.');
  }
  return { activated: true, ...plan, url: target.url };
}

async function groupContext({ courseId, assignmentId, submissionId }) {
  const { course, assignment, sub } = await resolveSubmission({ courseId, assignmentId, submissionId });
  const subPath = `/courses/${course}/assignments/${assignment.assignmentId}/submissions/${sub}`;
  const p = await submissionProps(course, assignment.assignmentId, sub);
  return { subPath, p, group: shapeGroup(p) };
}

/** Adds classmates (by name, email or id) to your group submission. */
export async function addGroupMembers({ courseId, assignmentId, submissionId, members, dryRun = false }) {
  if (!members?.length) throw new Error('Name at least one person to add');
  const { subPath, p, group } = await groupContext({ courseId, assignmentId, submissionId });
  const adding = planAddMembers(group, p.course_members ?? [], members);
  const plan = {
    assignment: group.assignment,
    groupSize: group.groupSize,
    currentMembers: group.members.map((m) => m.name ?? m.userId),
    adding: adding.map((m) => m.name ?? m.userId),
  };
  if (dryRun) return { dryRun: true, ...plan };

  const token = await csrfToken(subPath);
  const body = new URLSearchParams();
  for (const m of adding) body.append('user_ids[]', String(m.userId));
  const res = await request('POST', p.paths?.many_ownerships_path ?? `${subPath}/ownerships/many`, {
    body,
    accept: 'application/json',
    headers: XHR(token),
  });
  if (!res.ok) throw await failure(res, 'add group members');
  return { added: true, ...plan };
}

/**
 * Removes one member from your group submission. Removing "me" leaves the
 * group: you lose access to that submission.
 */
export async function removeGroupMember({ courseId, assignmentId, submissionId, member, dryRun = false }) {
  if (!member) throw new Error('Name the group member to remove, or "me" to leave the group');
  const { subPath, p, group } = await groupContext({ courseId, assignmentId, submissionId });
  const target = planRemoveMember(group, member);
  const plan = {
    assignment: group.assignment,
    removing: target.name ?? target.userId,
    leavingGroup: target.you,
    remainingMembers: group.members.filter((m) => m !== target).map((m) => m.name ?? m.userId),
  };
  if (dryRun) return { dryRun: true, ...plan };

  const token = await csrfToken(subPath);
  const res = await request('DELETE', `${p.paths?.ownerships_path ?? `${subPath}/ownerships`}/${target.ownershipId}`, {
    accept: 'application/json',
    headers: XHR(token),
  });
  if (!res.ok) throw await failure(res, 'remove the group member');
  return { removed: true, ...plan };
}
