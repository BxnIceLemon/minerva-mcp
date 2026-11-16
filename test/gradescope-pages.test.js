// "Select pages" for PDF submissions, with made-up page data. No account needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shapePageSelection, parsePageList, planPageSelection } from '../src/gradescope/parse.js';

// Two parts under question 1, a standalone question 2, and a 5-page PDF.
// Question 1.1 already has page 1; the pages arrive out of order.
function props(over = {}) {
  return {
    assignment: { id: 7, title: 'Homework 1' },
    assignmentSubmission: { id: 99 },
    cannotReselectPages: false,
    questions: [
      { id: 10, full_index: '1', title: 'Search', weight: '10.0', parent_id: null, children: [11, 12], assignable: false },
      { id: 11, full_index: '1.1', title: 'Test design', weight: '6.0', parent_id: 10, children: false, assignable: true },
      { id: 12, full_index: '1.2', title: 'Results table', weight: '4.0', parent_id: 10, children: false, assignable: true },
      { id: 20, full_index: '2', title: 'Admin notes', weight: '0.0', parent_id: null, children: false, assignable: true },
    ],
    questionSubmissions: [
      { question_id: 11, data: { pages: [1] } },
      { question_id: 12, data: {} },
      { question_id: 20, data: {} },
    ],
    pdfAttachment: {
      filename: 'report.pdf',
      page_count: 5,
      status_string: 'complete',
      pages: [3, 1, 5, 2, 4].map((n) => ({ id: 500 + n, number: n, url: `https://example.com/p${n}.jpg` })),
    },
    urls: { update_pages_path: '/courses/1/assignments/7/submissions/99/update_pages' },
    ...over,
  };
}

test('shows each question with its current pages, and what is left', () => {
  const s = shapePageSelection(props(), 'https://example.com/select');
  assert.equal(s.canChange, true);
  assert.equal(s.pdf.pageCount, 5);
  assert.deepEqual(s.questions.map((q) => [q.number, q.assignable, q.pages]), [
    ['1', false, undefined],
    ['1.1', true, [1]],
    ['1.2', true, []],
    ['2', true, []],
  ]);
  assert.deepEqual(s.unassignedQuestions, ['1.2', '2']);
  assert.deepEqual(s.unusedPages, [2, 3, 4, 5]);
});

test('reads page lists as numbers, lists or ranges', () => {
  assert.deepEqual(parsePageList('1-3, 5'), [1, 2, 3, 5]);
  assert.deepEqual(parsePageList([4, 2]), [4, 2]);
  assert.deepEqual(parsePageList(7), [7]);
  assert.deepEqual(parsePageList(''), []);
  assert.throws(() => parsePageList('3-1'), /runs backwards/);
  assert.throws(() => parsePageList('two'), /not a page number/);
});

test('plans the change and builds the request Gradescope expects', () => {
  const plan = planPageSelection(props(), { '1.2': '2-3', 'admin': [5] });
  assert.deepEqual(plan.changes.map((c) => [c.question, c.from, c.to]), [
    ['1.2', [], [2, 3]],
    ['2', [], [5]],
  ]);
  // 1.1 keeps page 1 because it wasn't mentioned.
  assert.deepEqual(plan.final.map((f) => [f.question, f.pages]), [['1.1', [1]], ['1.2', [2, 3]], ['2', [5]]]);
  assert.deepEqual(plan.unassignedQuestions, []);
  assert.deepEqual(plan.unusedPages, [4]);

  // Every assignable question is sent, keyed by id, with page ids in page order.
  assert.deepEqual(JSON.parse(plan.request.pages_for_question), { 11: [501], 12: [502, 503], 20: [505] });
  // The page list goes back as Gradescope sent it.
  assert.deepEqual(JSON.parse(plan.request.pages), props().pdfAttachment.pages);
});

test('replace clears questions that are not listed; [] clears one question', () => {
  const replaced = planPageSelection(props(), { '1.2': [2] }, { replace: true });
  assert.deepEqual(replaced.final.map((f) => [f.question, f.pages]), [['1.1', []], ['1.2', [2]], ['2', []]]);
  const cleared = planPageSelection(props(), { '1.1': [] });
  assert.deepEqual(cleared.changes, [{ question: '1.1', title: 'Test design', from: [1], to: [] }]);
});

test('sorts and de-duplicates pages, and reports no change when nothing differs', () => {
  assert.deepEqual(planPageSelection(props(), { '1.2': [3, 2, 3] }).final[1].pages, [2, 3]);
  assert.deepEqual(planPageSelection(props(), { '1.1': [1] }).changes, []);
});

test('refuses what the web page would not allow', () => {
  assert.throws(() => planPageSelection(props(), { 1: [2] }), /Question 1 has parts; give pages to 1.1, 1.2/);
  assert.throws(() => planPageSelection(props(), { '1.1': [6] }), /Page 6 doesn't exist; the PDF has pages 1-5/);
  assert.throws(() => planPageSelection(props(), { '1.1': [0] }), /Page 0 doesn't exist/);
  assert.throws(() => planPageSelection(props(), { 9: [1] }), /No question matches "9"/);
  assert.throws(() => planPageSelection(props(), { t: [1] }), /matches several questions/);
  assert.throws(() => planPageSelection(props(), { '1.1': [2], 'Test design': [3] }), /given more than once/);
  assert.throws(() => planPageSelection(props(), {}), /Say which pages go with which question/);
  assert.throws(() => planPageSelection(props({ cannotReselectPages: true }), { '1.1': [2] }), /no longer lets you change/);
  assert.throws(
    () => planPageSelection(props({ pdfAttachment: { page_count: 0, pages: [] } }), { '1.1': [1] }),
    /no PDF pages to assign/,
  );
});
