// Checks for Minerva submissions, with made-up assignment data. No account needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planSubmission, checkFiles } from '../src/minerva-write.js';

const NOW = Date.parse('2030-01-10T12:00:00Z');

const info = (over = {}) => ({
  courseId: '_100_1',
  columnId: '_200_1',
  contentId: '_300_1',
  title: 'Coursework 1',
  type: 'resource/x-bb-asmt-test-link',
  subtype: 'Assignment',
  hasQuestions: false,
  due: '2030-01-12T23:59:00.000Z',
  attemptsAllowed: -1,
  allowFiles: true,
  allowText: true,
  lateDisallowed: false,
  group: false,
  passwordRequired: false,
  secureBrowser: false,
  attempts: [],
  url: 'https://minerva.leeds.ac.uk/ultra/courses/_100_1/outline',
  ...over,
});

const file = { name: 'work.zip', bytes: 1234 };

test('plans a first attempt with files', () => {
  const p = planSubmission(info(), { files: [file], now: NOW });
  assert.equal(p.attempt, 1);
  assert.equal(p.attemptsAllowed, 'unlimited');
  assert.equal(p.late, false);
  assert.equal(p.continuesDraft, null);
  assert.deepEqual(p.files, [{ name: 'work.zip', bytes: 1234 }]);
});

test('counts earlier attempts and continues an open draft', () => {
  const attempts = [
    { attemptId: '_1_1', submitted: true },
    { attemptId: '_2_1', submitted: false },
  ];
  const p = planSubmission(info({ attemptsAllowed: 3, attempts }), { files: [file], now: NOW });
  assert.equal(p.attempt, 2);
  assert.equal(p.attemptsAllowed, 3);
  assert.equal(p.continuesDraft, '_2_1');
});

test('refuses when no attempts are left', () => {
  const attempts = [{ attemptId: '_1_1', submitted: true }];
  assert.throws(() => planSubmission(info({ attemptsAllowed: 1, attempts }), { files: [file], now: NOW }), /No attempts left/);
});

test('marks late submissions and refuses them when late attempts are blocked', () => {
  const late = { due: '2030-01-01T00:00:00Z' };
  assert.equal(planSubmission(info(late), { files: [file], now: NOW }).late, true);
  assert.throws(() => planSubmission(info({ ...late, lateDisallowed: true }), { files: [file], now: NOW }), /no longer accepts/);
});

test('refuses things it cannot submit', () => {
  assert.throws(() => planSubmission(info({ type: 'resource/x-bb-blti-link' }), { files: [file] }), /external tool/);
  assert.throws(() => planSubmission(info({ hasQuestions: true }), { files: [file] }), /questions/);
  assert.throws(() => planSubmission(info({ subtype: 'Test' }), { files: [file] }), /take it in the browser/);
  assert.throws(() => planSubmission(info({ group: true }), { files: [file] }), /group/);
  assert.throws(() => planSubmission(info({ passwordRequired: true }), { files: [file] }), /password/);
  assert.throws(() => planSubmission(info(), { files: [] }), /Nothing to submit/);
  assert.throws(() => planSubmission(info(), { files: [], text: '   ' }), /Nothing to submit/);
  assert.throws(() => planSubmission(info({ allowFiles: false }), { files: [file] }), /file uploads/);
  assert.throws(() => planSubmission(info({ allowText: false }), { text: 'hi' }), /text submission/);
});

test('accepts text alone', () => {
  const p = planSubmission(info(), { text: '  my answer  ', now: NOW });
  assert.equal(p.text, 'my answer');
  assert.deepEqual(p.files, []);
});

test('checkFiles rejects missing, empty, oversized, folders and duplicate names', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minerva-plan-'));
  try {
    const a = path.join(dir, 'a.txt');
    fs.writeFileSync(a, 'hello');
    fs.mkdirSync(path.join(dir, 'sub'));
    const dup = path.join(dir, 'sub', 'a.txt');
    fs.writeFileSync(dup, 'again');
    const empty = path.join(dir, 'empty.txt');
    fs.writeFileSync(empty, '');

    assert.deepEqual(checkFiles([a]).map((f) => [f.name, f.bytes]), [['a.txt', 5]]);
    assert.throws(() => checkFiles([path.join(dir, 'nope.txt')]), /File not found/);
    assert.throws(() => checkFiles([path.join(dir, 'sub')]), /Not a file/);
    assert.throws(() => checkFiles([empty]), /is empty/);
    assert.throws(() => checkFiles([a], 3), /upload limit/);
    assert.throws(() => checkFiles([a, dup]), /both named "a.txt"/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
