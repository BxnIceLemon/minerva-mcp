// Pure parsers for Gradescope pages and JSON. No network here, so tests can
// feed them hand-written fixtures.
import * as cheerio from 'cheerio';
import { GS_BASE_URL } from '../config.js';

// "2026-10-21 23:59:00 +0100" -> ISO 8601
export function isoDate(s) {
  const m = s?.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2})$/);
  return m ? new Date(`${m[1]}T${m[2]}${m[3]}:${m[4]}`).toISOString() : s || undefined;
}

function clean(t) {
  return t?.replace(/\s+/g, ' ').trim() || undefined;
}

function num(v) {
  if (v === null || v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function parseCourses(html) {
  const $ = cheerio.load(html);
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
  return courses;
}

export function parseAssignments(html, course) {
  const $ = cheerio.load(html);
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
    // Online assignments link straight to ".../submissions/new" instead of a button.
    const online = /\/submissions\/new$/.test(link ?? '');
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
      canSubmit: button.length ? button.attr('data-ready-for-submission') === 'true' : online || undefined,
      // Only present while the assignment has no submission yet.
      submission: button.length
        ? {
            format: button.attr('data-submission-format'),
            postUrl: button.attr('data-post-url'),
            leaderboard: button.attr('data-leaderboard-enabled') === 'true',
          }
        : online
          ? { format: 'online' }
          : undefined,
      url: `${GS_BASE_URL}${link ?? `/courses/${course}`}`,
    });
  });
  return rows;
}

export function reactProps(html, cls = 'AssignmentSubmissionViewer') {
  const $ = cheerio.load(html);
  const raw = $(`[data-react-class="${cls}"]`).attr('data-react-props');
  return raw ? JSON.parse(raw) : null;
}

// Teacher annotations have no documented shape; take whatever text they carry.
function annotationText(a) {
  for (const k of ['comment', 'content', 'text', 'body']) {
    if (typeof a?.[k] === 'string' && a[k].trim()) return a[k].trim();
  }
  return undefined;
}

function shapeRegrade(r) {
  return {
    id: r.id,
    status: r.completed ? 'completed' : 'pending',
    yourRequest: r.student_comment || undefined,
    staffReply: r.staff_comment || undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function shapeAutograder(ag) {
  if (!ag) return undefined;
  return {
    score: ag.score,
    executionTime: ag.execution_time,
    output: ag.output || undefined,
    stdout: ag.stdout_shown_to_students === false ? undefined : ag.stdout || undefined,
    errorCode: ag.error_code || undefined,
    tests: (ag.tests ?? []).map((t) => ({
      name: t.name,
      number: t.number,
      score: t.score,
      maxScore: t.max_score,
      status: t.status,
      output: t.output || undefined,
    })),
    leaderboard: ag.leaderboard ?? undefined,
  };
}

/** Turns the submission viewer's props into a compact result. */
export function shapeSubmission(p, url) {
  const subs = new Map((p.question_submissions ?? []).map((q) => [q.question_id, q]));
  const rubric = new Map();
  for (const r of p.rubric_items ?? []) {
    if (!rubric.has(r.question_id)) rubric.set(r.question_id, []);
    rubric.get(r.question_id).push(r);
  }
  const regrades = new Map();
  for (const r of p.regrade_requests ?? []) {
    if (!regrades.has(r.question_submission_id)) regrades.set(r.question_submission_id, []);
    regrades.get(r.question_submission_id).push(shapeRegrade(r));
  }
  // Only leaf questions carry scores; groups are just headings. Sort by the
  // question number ("1.2" before "1.10") rather than the page's internal order.
  const questions = (p.questions ?? [])
    .filter((q) => q.type !== 'QuestionGroup')
    .sort((a, b) => String(a.full_index).localeCompare(String(b.full_index), undefined, { numeric: true }))
    .map((q) => {
      const s = subs.get(q.id);
      return {
        number: q.full_index != null ? String(q.full_index) : undefined,
        question: q.numbered_title ?? q.title,
        questionId: q.id,
        questionSubmissionId: s?.id,
        maxScore: num(q.weight),
        score: num(s?.score),
        rubricApplied: (rubric.get(q.id) ?? []).filter((r) => r.present).map((r) => `${r.description} (${r.weight})`),
        comments: (s?.evaluations ?? []).map((e) => e.comments).filter(Boolean),
        annotations: (s?.annotations ?? []).map(annotationText).filter(Boolean),
        regradeRequests: s ? regrades.get(s.id) ?? [] : [],
      };
    });

  const a = p.assignment ?? {};
  const sub = p.assignment_submission ?? {};
  return {
    assignment: a.title,
    format: a.submission_format,
    totalPoints: num(a.total_points),
    due: a.due_date,
    gradesVisible: p.grades_visible,
    submissionId: sub.id,
    status: sub.status,
    submittedAt: sub.created_at,
    score: num(sub.score),
    lateness: sub.lateness_in_words || undefined,
    canResubmit: Boolean(a.submission_allowed),
    regradeRequestsOpen: Boolean(a.regrade_requests_open),
    questions,
    autograder: shapeAutograder(p.autograder_results),
    url,
  };
}

/** Earlier submissions to the same assignment, newest first. */
export function shapeHistory(p) {
  return (p.past_submissions ?? [])
    .map((s) => ({
      submissionId: s.id,
      submittedAt: s.created_at,
      active: Boolean(s.active),
      canActivate: Boolean(s.can_activate),
      activatePath: s.activate_path || undefined,
      score: num(s.score),
      url: s.show_path ? `${GS_BASE_URL}${s.show_path}` : undefined,
    }))
    .sort((x, y) => String(y.submittedAt).localeCompare(String(x.submittedAt)));
}

/** The people who own a submission, with names from the course roster. */
export function shapeGroup(p) {
  const roster = new Map((p.course_members ?? []).map((m) => [m.id, m]));
  const me = p.current_user?.id;
  const a = p.assignment ?? {};
  return {
    assignment: a.title,
    groupSize: a.group_size ?? null,
    canUpdate: Boolean(a.group_members_updatable),
    members: (p.ownerships ?? [])
      .filter((o) => o.active !== false)
      .map((o) => ({
        userId: o.user_id,
        name: roster.get(o.user_id)?.name,
        ownershipId: o.id,
        uploader: Boolean(o.uploader),
        you: o.user_id === me,
      })),
  };
}

/**
 * Matches what the user typed ("Ada", "ada@leeds.ac.uk", "12345") against the
 * course roster. Each query must match exactly one person.
 */
export function matchMembers(roster, queries) {
  return queries.map((query) => {
    const q = String(query).trim().toLowerCase();
    const byId = roster.filter((m) => String(m.id) === q);
    const byEmail = roster.filter((m) => m.email?.toLowerCase() === q);
    const byName = roster.filter((m) => m.name?.toLowerCase() === q);
    const partial = roster.filter((m) => m.name?.toLowerCase().includes(q) || m.email?.toLowerCase().startsWith(q));
    const hits = [byId, byEmail, byName, partial].find((h) => h.length) ?? [];
    if (hits.length === 1) return hits[0];
    if (!hits.length) throw new Error(`Nobody in this course matches "${query}"`);
    throw new Error(`"${query}" matches ${hits.length} people; use their full name or email`);
  });
}

/** Validates adding people to a group and returns the user ids to send. */
export function planAddMembers(group, roster, queries) {
  if (!group.canUpdate) throw new Error(`Group members can't be changed on "${group.assignment}"`);
  const people = matchMembers(roster, queries);
  const current = new Set(group.members.map((m) => m.userId));
  const adding = [...new Map(people.filter((m) => !current.has(m.id)).map((m) => [m.id, m])).values()];
  if (!adding.length) throw new Error('Everyone named is already in the group');
  if (group.groupSize && group.members.length + adding.length > group.groupSize) {
    throw new Error(`Groups are limited to ${group.groupSize}; this group has ${group.members.length}`);
  }
  return adding.map((m) => ({ userId: m.id, name: m.name }));
}

/** Finds the group member to remove; "me" means yourself. */
export function planRemoveMember(group, query) {
  if (!group.canUpdate) throw new Error(`Group members can't be changed on "${group.assignment}"`);
  const q = String(query).trim().toLowerCase();
  const target =
    q === 'me'
      ? group.members.find((m) => m.you)
      : group.members.find((m) => String(m.userId) === q || m.name?.toLowerCase() === q) ??
        (() => {
          const hits = group.members.filter((m) => m.name?.toLowerCase().includes(q));
          if (hits.length > 1) throw new Error(`"${query}" matches several group members`);
          return hits[0];
        })();
  if (!target) throw new Error(`"${query}" is not in this group`);
  if (group.members.length === 1) throw new Error('A submission must keep at least one member');
  return target;
}

/** Checks that an earlier submission can be made the active one. */
export function planActivate(history, submissionId) {
  const target = history.find((s) => String(s.submissionId) === String(submissionId));
  if (!target) throw new Error(`Submission ${submissionId} is not one of yours for this assignment`);
  if (target.active) throw new Error(`Submission ${submissionId} is already the active one`);
  if (!target.canActivate || !target.activatePath) {
    throw new Error(`Gradescope doesn't allow activating submission ${submissionId} (the assignment may be closed)`);
  }
  return target;
}

// --- Page selection ("Select pages") for variable-length PDF submissions.

function sortedPages(p) {
  return [...(p.pdfAttachment?.pages ?? [])].sort((a, b) => a.number - b.number);
}

function currentPages(p, questionId) {
  const qs = (p.questionSubmissions ?? []).find((q) => q.question_id === questionId);
  return [...(qs?.data?.pages ?? [])].map(Number).sort((a, b) => a - b);
}

/** The questions of a PDF submission and which pages each one has now. */
export function shapePageSelection(p, url) {
  const pageCount = p.pdfAttachment?.page_count ?? sortedPages(p).length;
  const questions = (p.questions ?? []).map((q) => ({
    questionId: q.id,
    number: q.full_index,
    title: q.title,
    points: q.weight != null ? Number(q.weight) : undefined,
    assignable: Boolean(q.assignable),
    pages: q.assignable ? currentPages(p, q.id) : undefined,
  }));
  const used = new Set(questions.flatMap((q) => q.pages ?? []));
  return {
    assignment: p.assignment?.title,
    submissionId: p.assignmentSubmission?.id,
    canChange: !p.cannotReselectPages,
    pdf: { fileName: p.pdfAttachment?.filename, pageCount, status: p.pdfAttachment?.status_string ?? p.pdfAttachment?.status },
    questions,
    unassignedQuestions: questions.filter((q) => q.assignable && !q.pages.length).map((q) => q.number),
    unusedPages: Array.from({ length: pageCount }, (_, i) => i + 1).filter((n) => !used.has(n)),
    url,
  };
}

/** "1-3, 5" or [1, 2, 3] or 4 → [1, 2, 3, 5]. */
export function parsePageList(v) {
  if (Array.isArray(v)) return v.map((x) => Number(x));
  if (typeof v === 'number') return [v];
  const out = [];
  for (const part of String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) {
      const [a, b] = [Number(m[1]), Number(m[2])];
      if (a > b) throw new Error(`Page range "${part}" runs backwards`);
      for (let i = a; i <= b; i++) out.push(i);
    } else if (/^\d+$/.test(part)) {
      out.push(Number(part));
    } else {
      throw new Error(`"${part}" is not a page number or range like 2-4`);
    }
  }
  return out;
}

function matchQuestion(questions, key) {
  const k = String(key).trim();
  const exact = questions.find((q) => q.full_index === k || String(q.id) === k);
  if (exact) return exact;
  const byTitle = questions.filter((q) => q.title?.toLowerCase().includes(k.toLowerCase()));
  if (byTitle.length === 1) return byTitle[0];
  if (!byTitle.length) throw new Error(`No question matches "${k}". Use a number like ${questions.find((q) => q.assignable)?.full_index ?? '1.1'}`);
  throw new Error(`"${k}" matches several questions: ${byTitle.map((q) => q.full_index).join(', ')}`);
}

/**
 * Checks which pages to give which questions and builds Gradescope's request.
 * `assign` maps a question (number like "1.2", id, or a unique part of its
 * title) to page numbers; questions left out keep their pages. With
 * `replace`, questions left out lose their pages.
 */
export function planPageSelection(p, assign, { replace = false } = {}) {
  if (p.cannotReselectPages) throw new Error('Gradescope no longer lets you change the pages of this submission');
  const pages = sortedPages(p);
  if (!pages.length) throw new Error('This submission has no PDF pages to assign (is the PDF still processing?)');
  const entries = Object.entries(assign ?? {});
  if (!entries.length) throw new Error('Say which pages go with which question, e.g. {"1.1": "1-2", "1.2": [3]}');
  const idByNumber = new Map(pages.map((pg) => [pg.number, pg.id]));
  const questions = p.questions ?? [];
  const next = new Map(questions.filter((q) => q.assignable).map((q) => [q.id, replace ? [] : currentPages(p, q.id)]));

  const seen = new Set();
  for (const [key, value] of entries) {
    const q = matchQuestion(questions, key);
    if (!q.assignable) {
      const kids = questions.filter((c) => c.parent_id === q.id).map((c) => c.full_index);
      throw new Error(`Question ${q.full_index} has parts; give pages to ${kids.join(', ') || 'its parts'} instead`);
    }
    if (seen.has(q.id)) throw new Error(`Question ${q.full_index} is given more than once`);
    seen.add(q.id);
    const list = parsePageList(value);
    for (const n of list) {
      if (!Number.isInteger(n) || !idByNumber.has(n)) throw new Error(`Page ${n} doesn't exist; the PDF has pages 1-${pages.length}`);
    }
    next.set(q.id, [...new Set(list)].sort((a, b) => a - b));
  }

  const changes = [];
  const pagesForQuestion = {};
  for (const q of questions.filter((x) => x.assignable)) {
    const to = next.get(q.id);
    const from = currentPages(p, q.id);
    if (from.join() !== to.join()) changes.push({ question: q.full_index, title: q.title, from, to });
    pagesForQuestion[q.id] = to.map((n) => idByNumber.get(n));
  }
  const used = new Set([...next.values()].flat());
  return {
    changes,
    final: questions.filter((q) => q.assignable).map((q) => ({ question: q.full_index, title: q.title, pages: next.get(q.id) })),
    unassignedQuestions: questions.filter((q) => q.assignable && !next.get(q.id).length).map((q) => q.full_index),
    unusedPages: pages.map((pg) => pg.number).filter((n) => !used.has(n)),
    request: { pages_for_question: JSON.stringify(pagesForQuestion), pages: JSON.stringify(p.pdfAttachment.pages) },
  };
}
