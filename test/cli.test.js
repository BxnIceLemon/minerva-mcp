// CLI tests that need no account: help, usage errors and the confirmation guard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'minerva-cli-test-'));

function cli(...args) {
  const r = spawnSync(process.execPath, ['src/cli.js', ...args], {
    encoding: 'utf8',
    env: { ...process.env, MINERVA_MCP_HOME: home, MINERVA_NO_AUTO_LOGIN: '1' },
    input: '',
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test('prints help', () => {
  const r = cli('--help');
  assert.equal(r.code, 0);
  assert.match(r.out, /gradescope <command>/);
  assert.match(r.out, /submit <course> <assignment> <file\.\.\.>/);
});

test('unknown commands and missing arguments are usage errors', () => {
  assert.equal(cli('frobnicate').code, 2);
  const r = cli('results', 'COMP1');
  assert.equal(r.code, 2);
  assert.match(r.err, /Usage: gradescope results/);
  assert.equal(cli('regrade', 'C', 'A', '1.1').code, 2); // no -m
});

test('commands explain how to sign in when there is no session', () => {
  const r = cli('courses');
  assert.equal(r.code, 1);
  assert.match(r.err, /gradescope login/);
  assert.match(cli('status').out, /Not signed in/);
});

test.after(() => fs.rmSync(home, { recursive: true, force: true }));
