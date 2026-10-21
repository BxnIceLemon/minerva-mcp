// Parser tests on hand-written fixtures shaped like Gradescope's pages.
// All names, ids and scores here are made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCourses, parseAssignments, shapeSubmission, shapeHistory, isoDate } from '../src/gradescope/parse.js';

const ACCOUNT = `
<div class="courseList">
  <div class="courseList--term">Fall 2026</div>
  <div class="courseList--coursesForTerm">
    <a class="courseBox" href="/courses/111">
      <h3 class="courseBox--shortname">202627_1_TEST1001</h3>
      <div class="courseBox--name">Test Module One</div>
      <div class="courseBox--assignments">3 assignments</div>
    </a>
  </div>
  <div class="courseList--term">Fall 2025</div>
  <div class="courseList--coursesForTerm">
    <a class="courseBox" href="/courses/222">
      <h3 class="courseBox--shortname">202526_2_TEST1001</h3>
      <div class="courseBox--name">Test Module One (old)</div>
    </a>
  </div>
</div>`;

const COURSE = `
<table id="assignments-student-table"><tbody>
<tr>
  <th class="table--primaryLink"><button data-assignment-id="901" data-submission-format="code"
    data-ready-for-submission="true" data-post-url="/courses/111/assignments/901/submissions"
    data-leaderboard-enabled="true">Lab 1</button></th>
  <td class="submissionStatus"><div class="submissionStatus--text">No Submission</div></td>
  <td><span class="submissionTimeChart--timeRemaining">2 days left</span>
    <time class="submissionTimeChart--releaseDate" datetime="2026-10-01 09:00:00 +0100"></time>
    <time class="submissionTimeChart--dueDate" datetime="2026-10-21 23:59:00 +0100"></time>
    <time class="submissionTimeChart--dueDate" datetime="2026-10-23 23:59:00 +0100"></time></td>
</tr>
<tr>
  <th class="table--primaryLink"><a href="/courses/111/assignments/902/submissions/5550">Quiz 1</a></th>
  <td class="submissionStatus"><div class="submissionStatus--score">8.0 / 10.0</div><div>1 Day Late</div></td>
  <td><time class="submissionTimeChart--dueDate" datetime="2026-09-30 14:00:00 +0100"></time></td>
</tr>
<tr>
  <th class="table--primaryLink"><a href="/courses/111/assignments/903/submissions/new">Survey</a></th>
  <td class="submissionStatus"><div class="submissionStatus--text">No Submission</div></td>
  <td></td>
</tr>
</tbody></table>`;

test('isoDate converts Gradescope timestamps', () => {
  assert.equal(isoDate('2026-10-21 23:59:00 +0100'), '2026-10-21T22:59:00.000Z');
  assert.equal(isoDate(undefined), undefined);
});

test('parseCourses keeps terms in page order', () => {
  const courses = parseCourses(ACCOUNT);
  assert.equal(courses.length, 2);
  assert.deepEqual(
    courses.map((c) => [c.id, c.term]),
    [
      ['111', 'Fall 2026'],
      ['222', 'Fall 2025'],
    ],
  );
});

test('parseAssignments reads open, graded and online rows', () => {
  const [open, graded, online] = parseAssignments(COURSE, '111');

  assert.equal(open.assignmentId, '901');
  assert.equal(open.submissionId, undefined);
  assert.equal(open.status, 'No Submission');
  assert.equal(open.canSubmit, true);
  assert.deepEqual(open.submission, {
    format: 'code',
    postUrl: '/courses/111/assignments/901/submissions',
    leaderboard: true,
  });
  assert.equal(open.due, '2026-10-21T22:59:00.000Z');
  assert.equal(open.lateDue, '2026-10-23T22:59:00.000Z');

  assert.equal(graded.assignmentId, '902');
  assert.equal(graded.submissionId, '5550');
  assert.equal(graded.status, 'Graded');
  assert.equal(graded.score, 8);
  assert.equal(graded.maxScore, 10);
  assert.equal(graded.late, '1 Day Late');
  assert.equal(graded.submission, undefined);

  assert.equal(online.assignmentId, '903');
  assert.deepEqual(online.submission, { format: 'online' });
  assert.equal(online.canSubmit, true);
});

const PROPS = {
  assignment: { title: 'Lab 1', submission_format: 'code', total_points: '10.0', regrade_requests_open: true, submission_allowed: true },
  assignment_submission: { id: 5551, status: 'processed', score: '7.0', created_at: '2026-10-20T10:00:00Z' },
  grades_visible: true,
  questions: [
    { id: 2, type: 'FreeResponseQuestion', title: 'b', numbered_title: '1.10: b', full_index: '1.10', weight: '5.0' },
    { id: 9, type: 'QuestionGroup', title: 'group', full_index: '1', weight: '10.0' },
    { id: 1, type: 'FreeResponseQuestion', title: 'a', numbered_title: '1.2: a', full_index: '1.2', weight: '5.0' },
  ],
  question_submissions: [
    { id: 11, question_id: 1, score: '5.0', evaluations: [{ comments: 'Nice' }], annotations: [{ content: 'see line 3' }] },
    { id: 12, question_id: 2, score: '2.0', evaluations: [], annotations: [] },
  ],
  rubric_items: [
    { question_id: 2, description: 'Missing base case', weight: '-3.0', present: true },
    { question_id: 2, description: 'Correct', weight: '5.0', present: false },
  ],
  regrade_requests: [
    { id: 77, question_submission_id: 12, completed: true, student_comment: 'Please recheck', staff_comment: 'Agreed, +1', created_at: '2026-10-21T09:00:00Z' },
  ],
  autograder_results: {
    score: 7,
    tests: [
      { name: 'loads data', number: '1', score: 3, max_score: 3, status: 'passed' },
      { name: 'trains', number: '2', score: 4, max_score: 7, status: 'failed', output: 'expected 1, got 0' },
    ],
    stdout: 'secret',
    stdout_shown_to_students: false,
  },
  past_submissions: [
    { id: 5550, created_at: '2026-10-19T10:00:00Z', active: false, score: '5.0', show_path: '/courses/111/assignments/901/submissions/5550' },
    { id: 5551, created_at: '2026-10-20T10:00:00Z', active: true, score: '7.0', show_path: '/courses/111/assignments/901/submissions/5551' },
  ],
};

test('shapeSubmission orders leaf questions and attaches feedback', () => {
  const s = shapeSubmission(PROPS, 'https://example.invalid/sub');
  assert.equal(s.score, 7);
  assert.equal(s.totalPoints, 10);
  assert.equal(s.canResubmit, true);
  assert.deepEqual(
    s.questions.map((q) => q.number),
    ['1.2', '1.10'],
  );
  const [a, b] = s.questions;
  assert.equal(a.questionSubmissionId, 11);
  assert.deepEqual(a.comments, ['Nice']);
  assert.deepEqual(a.annotations, ['see line 3']);
  assert.deepEqual(b.rubricApplied, ['Missing base case (-3.0)']);
  assert.deepEqual(b.regradeRequests, [
    { id: 77, status: 'completed', yourRequest: 'Please recheck', staffReply: 'Agreed, +1', createdAt: '2026-10-21T09:00:00Z', updatedAt: undefined },
  ]);
});

test('shapeSubmission hides stdout the course keeps from students', () => {
  const ag = shapeSubmission(PROPS, '').autograder;
  assert.equal(ag.stdout, undefined);
  assert.equal(ag.tests[1].status, 'failed');
  assert.equal(ag.tests[1].output, 'expected 1, got 0');
});

test('shapeHistory lists newest first', () => {
  const h = shapeHistory(PROPS);
  assert.deepEqual(
    h.map((x) => [x.submissionId, x.active]),
    [
      [5551, true],
      [5550, false],
    ],
  );
});
