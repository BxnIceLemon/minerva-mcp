// Submitting to Minerva (Ultra) assignments. Every non-GET request to Minerva
// lives in this file. Like the Gradescope writes, submit validates everything
// first and supports dryRun, which returns the plan without sending.
//
// Blackboard's public REST API can't attach files to attempts in Ultra courses,
// so this follows the requests the Ultra web page itself sends:
//   1. POST /learn/api/v1/files                                  upload each file
//   2. POST /learn/api/v1/courses/{c}/gradebook/columns/{col}/attempts   start an attempt
//   3. PATCH /learn/api/v1/courses/{c}/gradebook/attempts/{id}   submit it (NEEDS_GRADING)
import fs from 'node:fs';
import path from 'node:path';
import { BASE_URL } from './config.js';
import { get, getAll, resolve, session, headers, SessionError } from './client.js';
import { course } from './minerva.js';

const V1 = '/learn/api/public/v1';
const V2 = '/learn/api/public/v2';
const API = '/learn/api/v1';
const ASSESSMENT = 'resource/x-bb-assessment';
const TEST_LINK = 'resource/x-bb-asmt-test-link';

async function send(method, pathOrUrl, { json, form, query } = {}) {
  const s = session();
  if (!s.xsrf) throw new SessionError('The saved Minerva session has no XSRF token. Sign in again with the minerva_login tool or `npm run login`.');
  const u = resolve(pathOrUrl);
  for (const [k, v] of Object.entries(query ?? {})) u.searchParams.set(k, String(v));
  const h = headers(s);
  if (json !== undefined) h['Content-Type'] = 'application/json';
  const r = await fetch(u, {
    method,
    headers: h,
    body: json !== undefined ? JSON.stringify(json) : form,
    redirect: 'manual',
  });
  if (r.status === 401 || (r.status >= 300 && r.status < 400)) {
    throw new SessionError('Minerva session expired. Call the minerva_login tool, or run `npm run login` in the minerva-mcp folder.');
  }
  const text = await r.text();
  if (!r.ok) {
    let msg = text;
    try {
      const j = JSON.parse(text);
      msg = j.message ?? j.errorMessage ?? text;
    } catch {}
    throw new Error(`Minerva refused ${method} ${u.pathname} (HTTP ${r.status}): ${String(msg).replace(/\s+/g, ' ')}`.slice(0, 500));
  }
  return text ? JSON.parse(text) : null;
}

const norm = (status) => String(status ?? '').toUpperCase().replace(/([a-z])([A-Z])/g, '$1_$2');
const isDraft = (a) => norm(a.status) === 'IN_PROGRESS';

async function primaryCourseId(courseId) {
  const c = await get(`${V1}/courses/${await course(courseId)}`);
  return c.id;
}

/**
 * Finds a gradebook item in a course by column id, content id, or a unique
 * part of its name ("CW2").
 */
export async function findColumn(courseId, key) {
  const cid = await primaryCourseId(courseId);
  const cols = await getAll(`${V2}/courses/${cid}/gradebook/columns`);
  const k = String(key ?? '').trim();
  if (!k) throw new Error('Name the assignment (its title, or a content or column id)');
  let col = cols.find((c) => c.id === k || c.contentId === k);
  if (!col) {
    const matches = cols.filter((c) => c.name?.toLowerCase().includes(k.toLowerCase()));
    if (matches.length > 1) {
      const exact = matches.filter((c) => c.name.toLowerCase() === k.toLowerCase());
      if (exact.length !== 1) throw new Error(`"${k}" matches several items: ${matches.map((c) => c.name).join('; ')}`);
      col = exact[0];
    } else {
      col = matches[0];
    }
  }
  if (!col) throw new Error(`No gradebook item in this course matches "${k}"`);
  return { courseId: cid, column: col };
}

function shapeAttempt(a) {
  return {
    attemptId: a.id,
    status: norm(a.status),
    submitted: !isDraft(a),
    started: a.creationDate ?? a.created,
    submittedAt: isDraft(a) ? undefined : (a.attemptDate ?? a.modifiedDate),
    grade: a.displayGrade?.text ?? a.displayGrade?.score,
    receiptId: a.attemptReceipt?.receiptId,
    receiptBytes: a.attemptReceipt?.submissionTotalSize,
    files: a.studentSubmissionFiles?.map((f) => f.name ?? f.file?.fileName),
  };
}

// Reads what a submission needs to know about an assignment: its settings and
// your attempts so far. GET requests only.
async function assignmentInfo(courseId, key) {
  const { courseId: cid, column } = await findColumn(courseId, key);
  if (!column.contentId) throw new Error(`"${column.name}" is a gradebook column with nothing to submit to`);
  const content = await get(`${API}/courses/${cid}/contents/${column.contentId}`);
  const test = content.contentDetail?.[TEST_LINK]?.test;
  const list = await get(`${API}/courses/${cid}/gradebook/columns/${column.id}/attempts`);
  const attempts = Object.values(list?.lookup ?? {})
    .flat()
    .sort((a, b) => String(a.creationDate).localeCompare(String(b.creationDate)));
  const d = test?.deploymentSettings ?? {};
  return {
    courseId: cid,
    columnId: column.id,
    contentId: column.contentId,
    title: column.name,
    type: content.contentHandler,
    subtype: test?.assessment?.subtype,
    questionCount: test?.assessment?.questionCount ?? 0,
    hasQuestions: Boolean(test?.assessment?.hasAnswerableQuestions || test?.assessment?.questionCount),
    due: column.grading?.due ?? content.genericReadOnlyData?.dueDate,
    pointsPossible: column.score?.possible,
    attemptsAllowed: d.attemptCount ?? column.grading?.attemptsAllowed,
    allowFiles: d.allowFileSubmission !== false,
    allowText: d.allowTextSubmission !== false,
    lateDisallowed: Boolean(d.isLateAttemptCreationDisallowed),
    group: Boolean(content.isGroupContent),
    passwordRequired: Boolean(d.isPasswordRequired),
    secureBrowser: Boolean(d.isSecureBrowserRequiredToTake || d.isWebcamRequired),
    attempts: attempts.map(shapeAttempt),
    url: `${BASE_URL}/ultra/courses/${cid}/outline`,
  };
}

/** Your attempts on a Minerva assignment, with its submission settings. */
export async function listSubmissions({ courseId, assignment }) {
  const { attempts, ...info } = await assignmentInfo(courseId, assignment);
  // The attempt list leaves out files; each attempt lists them with expand=viewUrl.
  const detailed = [];
  for (const a of attempts) {
    const full = await get(`${API}/courses/${info.courseId}/gradebook/attempts/${a.attemptId}`, { expand: 'viewUrl' }).catch(() => null);
    detailed.push(full ? shapeAttempt(full) : a);
  }
  return { ...info, attempts: detailed.reverse() };
}

/**
 * Checks an assignment and the files against what Minerva accepts. Pure: it
 * takes what assignmentInfo read and the checked files, and returns the plan.
 */
export function planSubmission(info, { files = [], text, now = Date.now() } = {}) {
  if (info.type !== TEST_LINK) {
    const where = info.type === 'resource/x-bb-blti-link' ? ' It links to an external tool (such as Gradescope); submit there.' : '';
    throw new Error(`"${info.title}" is not a Minerva assignment (${info.type ?? 'unknown type'}).${where}`);
  }
  if (info.subtype && info.subtype !== 'Assignment') throw new Error(`"${info.title}" is a ${info.subtype.toLowerCase()}; take it in the browser: ${info.url}`);
  if (info.hasQuestions) throw new Error(`"${info.title}" has questions to answer; do it in the browser: ${info.url}`);
  if (info.group) throw new Error(`"${info.title}" is a group assignment; group submissions are not supported yet. Submit in the browser: ${info.url}`);
  if (info.passwordRequired || info.secureBrowser) throw new Error(`"${info.title}" needs a password or a secure browser; submit in the browser: ${info.url}`);
  const hasText = typeof text === 'string' && text.trim() !== '';
  if (!files.length && !hasText) throw new Error('Nothing to submit: give at least one file or some text');
  if (files.length && !info.allowFiles) throw new Error(`"${info.title}" does not accept file uploads`);
  if (hasText && !info.allowText) throw new Error(`"${info.title}" does not accept a text submission`);

  const submitted = info.attempts.filter((a) => a.submitted);
  const limit = Number(info.attemptsAllowed);
  if (limit > 0 && submitted.length >= limit) {
    throw new Error(`No attempts left on "${info.title}" (${submitted.length} of ${limit} used)`);
  }
  const due = info.due ? Date.parse(info.due) : NaN;
  const late = !Number.isNaN(due) && now > due;
  if (late && info.lateDisallowed) throw new Error(`"${info.title}" was due ${info.due} and no longer accepts submissions`);
  const draft = info.attempts.find((a) => !a.submitted);

  return {
    courseId: info.courseId,
    columnId: info.columnId,
    assignment: info.title,
    due: info.due,
    late,
    attempt: submitted.length + 1,
    attemptsAllowed: limit > 0 ? limit : 'unlimited',
    previousAttempts: submitted.length,
    continuesDraft: draft?.attemptId ?? null,
    files: files.map(({ name, bytes }) => ({ name, bytes })),
    text: hasText ? text.trim() : undefined,
    url: info.url,
  };
}

export function checkFiles(files = [], maxBytes = Infinity) {
  const list = files.map((f) => {
    const full = path.resolve(f);
    if (!fs.existsSync(full)) throw new Error(`File not found: ${f}`);
    const st = fs.statSync(full);
    if (!st.isFile()) throw new Error(`Not a file: ${f}`);
    if (st.size === 0) throw new Error(`${f} is empty`);
    if (st.size > maxBytes) throw new Error(`${f} is larger than Minerva's ${Math.floor(maxBytes / 1048576)} MB upload limit`);
    return { path: full, name: path.basename(full), bytes: st.size };
  });
  const seen = new Set();
  for (const f of list) {
    if (seen.has(f.name)) throw new Error(`Two files are both named "${f.name}"`);
    seen.add(f.name);
  }
  return list;
}

async function uploadLimit() {
  const s = await get(`${V1}/uploads/settings`).catch(() => null);
  return Number(s?.maxUploadSizeInBytes) || Infinity;
}

/**
 * Submits files (and optional text) to a Minerva Ultra assignment. Each
 * submission is a new attempt; staff see it as soon as it is sent.
 */
export async function submit({ courseId, assignment, files = [], text, dryRun = false }) {
  const info = await assignmentInfo(courseId, assignment);
  const list = checkFiles(files, await uploadLimit());
  const plan = planSubmission(info, { files: list, text });
  if (dryRun) return { dryRun: true, ...plan };

  const cid = info.courseId;
  const uploaded = [];
  for (const f of list) {
    const form = new FormData();
    form.append('file', await fs.openAsBlob(f.path), encodeURIComponent(f.name));
    form.append('webLocation', '');
    form.append('fileLocation', '');
    const r = await send('POST', `${API}/files`, { form, query: { expand: 'mimeType,isMedia' } });
    if (!r?.fileLocation) throw new Error(`Upload of ${f.name} returned no file reference`);
    uploaded.push(r);
  }

  let attemptId = plan.continuesDraft;
  if (!attemptId) {
    const started = await send('POST', `${API}/courses/${cid}/gradebook/columns/${info.columnId}/attempts`, {
      json: { scoreProviderHandle: ASSESSMENT, status: 'IN_PROGRESS', toolAttemptDetail: { [ASSESSMENT]: { type: 'Test' } } },
    });
    attemptId = started?.id;
    if (!attemptId) throw new Error('Minerva did not start an attempt');
  }

  // Save the draft first, as the page does: new files go in as { file: upload }
  // and Minerva answers with the attempt's own file records.
  const attemptPath = `${API}/courses/${cid}/gradebook/attempts/${attemptId}`;
  const draft = await send('PATCH', attemptPath, {
    query: { expand: 'viewUrl' },
    json: {
      studentSubmission: { rawText: plan.text ?? '' },
      studentSubmissionFiles: uploaded.map((file) => ({ file })),
    },
  });
  const saved = draft?.studentSubmissionFiles ?? [];
  if (saved.length !== uploaded.length || draft?.submissionHasFilePartsWithErrors) {
    throw new Error(
      `Minerva saved ${saved.length} of ${uploaded.length} files to the draft, so nothing was submitted. ` +
        `The draft (attempt ${attemptId}) is still open; check it in the browser: ${plan.url}`,
    );
  }

  await send('PATCH', attemptPath, {
    query: { autoSubmitted: false, saveBeforeSubmitAndPost: true },
    json: {
      status: 'NEEDS_GRADING',
      toolAttemptDetail: { [ASSESSMENT]: { type: 'Test', scoreProviderHandle: ASSESSMENT } },
      studentSubmission: { rawText: plan.text ?? '' },
      studentSubmissionFiles: saved,
    },
  });

  const after = await get(attemptPath);
  if (norm(after?.status) !== 'NEEDS_GRADING' && norm(after?.status) !== 'COMPLETED') {
    throw new Error(`Minerva accepted the request, but attempt ${attemptId} shows status ${after?.status}. Check it in the browser: ${plan.url}`);
  }
  const receipt = after.attemptReceipt;
  if (list.length && receipt && !(receipt.submissionTotalSize > 0)) {
    throw new Error(`Attempt ${attemptId} was submitted but its receipt lists no file content. Check it in the browser: ${plan.url}`);
  }
  return {
    submitted: true,
    ...plan,
    attemptId,
    status: norm(after.status),
    submittedAt: receipt?.submissionDate ?? after.attemptDate ?? after.modifiedDate,
    receiptId: receipt?.receiptId,
    receiptBytes: receipt?.submissionTotalSize,
    uploadedFiles: saved.map((f) => f.fileName ?? f.name ?? f.file?.fileName),
  };
}
