// The update check against a fake GitHub API, the update itself on throwaway
// git repositories, and the notice the MCP server adds to its first answer.
// Nothing here talks to GitHub.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { checkForUpdate, applyUpdate } from '../src/update.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minerva-update-test-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const sha = (c) => c.repeat(40);
const commit = (s, date, message) => ({ sha: s, commit: { message, committer: { date } } });
const local = { commit: sha('a'), date: '2030-01-01T00:00:00Z', branch: 'main', localChanges: false, version: '0.1.0' };

function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const key = Object.keys(routes).find((k) => url.includes(k));
    const body = key ? routes[key] : undefined;
    if (body === undefined) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return { fetchImpl, calls };
}

test('reports no update when this copy is the latest commit', async () => {
  const { fetchImpl } = fakeFetch({ '/commits/main': commit(sha('a'), local.date, 'Latest') });
  const r = await checkForUpdate({ fetchImpl, local });
  assert.equal(r.updateAvailable, false);
  assert.equal(r.behindBy, 0);
});

test('lists what main adds, newest first, with each change\'s details', async () => {
  const { fetchImpl } = fakeFetch({
    '/commits/main': commit(sha('c'), '2030-01-03T00:00:00Z', 'Add C (#3)'),
    '/compare/': {
      status: 'ahead',
      ahead_by: 2,
      behind_by: 0,
      commits: [
        commit(sha('b'), '2030-01-02T00:00:00Z', 'Add B (#2)\n\n## What changed\n\nB does things.'),
        commit(sha('c'), '2030-01-03T00:00:00Z', 'Add C (#3)'),
      ],
    },
  });
  const r = await checkForUpdate({ fetchImpl, local });
  assert.equal(r.updateAvailable, true);
  assert.equal(r.behindBy, 2);
  assert.deepEqual(r.changes.map((c) => c.title), ['Add C (#3)', 'Add B (#2)']);
  assert.match(r.changes[1].details, /B does things/);
  assert.equal(r.current.commit, 'aaaaaaa');
  assert.equal(r.latest.commit, 'ccccccc');
  assert.equal(r.approximate, undefined);
});

test('falls back to commits by date when the histories share nothing', async () => {
  const { fetchImpl, calls } = fakeFetch({
    '/commits/main': commit(sha('c'), '2030-01-03T00:00:00Z', 'Add C'),
    '/commits?sha=main&since=': [commit(sha('c'), '2030-01-03T00:00:00Z', 'Add C'), commit(sha('b'), '2030-01-02T00:00:00Z', 'Add B')],
  });
  const r = await checkForUpdate({ fetchImpl, local: { ...local, branch: 'old-feature' } });
  assert.equal(r.updateAvailable, true);
  assert.equal(r.approximate, true);
  assert.deepEqual(r.changes.map((c) => c.title), ['Add C', 'Add B']);
  assert.ok(calls.some((u) => u.includes('since=2030-01-01T00%3A00%3A00Z')));
});

test('never throws, and can be turned off', async () => {
  const r = await checkForUpdate({ fetchImpl: async () => { throw new Error('offline'); }, local });
  assert.equal(r.checked, false);
  assert.match(r.reason, /offline/);
  process.env.MINERVA_NO_UPDATE_CHECK = '1';
  try {
    assert.equal((await checkForUpdate({ fetchImpl: async () => assert.fail('should not fetch'), local })).checked, false);
  } finally {
    delete process.env.MINERVA_NO_UPDATE_CHECK;
  }
});

// --- applyUpdate on real throwaway repositories

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { env: gitEnv, encoding: 'utf8' }).trim();

function setup(name) {
  const origin = path.join(tmp, `${name}-origin.git`);
  const work = path.join(tmp, `${name}-seed`);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { env: gitEnv });
  execFileSync('git', ['init', '-q', '-b', 'main', work], { env: gitEnv });
  fs.writeFileSync(path.join(work, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0', private: true }));
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'v1');
  git(work, 'remote', 'add', 'origin', origin);
  git(work, 'push', '-q', 'origin', 'main');
  const copy = path.join(tmp, `${name}-copy`);
  execFileSync('git', ['clone', '-q', origin, copy], { env: gitEnv });
  // GitHub moves on.
  fs.writeFileSync(path.join(work, 'new.txt'), 'new feature');
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'v2');
  git(work, 'push', '-q', 'origin', 'main');
  return { copy, latest: git(work, 'rev-parse', 'HEAD') };
}

test('fast-forwards a copy on main', async () => {
  const { copy, latest } = setup('plain');
  const plan = await applyUpdate({ root: copy, dryRun: true });
  assert.equal(plan.dryRun, true);
  assert.equal(git(copy, 'rev-parse', 'HEAD') === latest, false);
  const r = await applyUpdate({ root: copy });
  assert.equal(r.updated, true);
  assert.equal(git(copy, 'rev-parse', 'HEAD'), latest);
  assert.ok(fs.existsSync(path.join(copy, 'new.txt')));
});

test('moves a copy on an old branch to main and keeps a diverged local main as a backup', async () => {
  const { copy, latest } = setup('diverged');
  git(copy, 'switch', '-q', '-c', 'old-feature');
  fs.writeFileSync(path.join(copy, 'feature.txt'), 'x');
  git(copy, 'add', '.');
  git(copy, 'commit', '-q', '-m', 'feature');
  git(copy, 'switch', '-q', 'main');
  fs.writeFileSync(path.join(copy, 'local.txt'), 'only here');
  git(copy, 'add', '.');
  git(copy, 'commit', '-q', '-m', 'local main commit');
  const oldMain = git(copy, 'rev-parse', 'HEAD');
  git(copy, 'switch', '-q', 'old-feature');

  const r = await applyUpdate({ root: copy });
  assert.equal(r.previousBranchKept, 'old-feature');
  assert.match(r.oldMainKeptAs, /^main-before-update-/);
  assert.equal(git(copy, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.equal(git(copy, 'rev-parse', 'HEAD'), latest);
  assert.equal(git(copy, 'rev-parse', r.oldMainKeptAs), oldMain);
  assert.ok(git(copy, 'branch', '--list', 'old-feature'));
});

test('refuses to update over local changes', async () => {
  const { copy } = setup('dirty');
  fs.writeFileSync(path.join(copy, 'package.json'), '{"changed":true}');
  await assert.rejects(applyUpdate({ root: copy }), /local changes/);
});

// --- the MCP server's first answer

test('the first tool call carries the update notice, later ones don\'t', async () => {
  const api = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/repos/BxnIceLemon/minerva-mcp/commits/main')) {
      return res.end(JSON.stringify(commit(sha('f'), '2030-02-01T00:00:00Z', 'Add F (#9)')));
    }
    if (req.url.includes('/compare/')) {
      return res.end(JSON.stringify({ status: 'ahead', ahead_by: 1, behind_by: 0, commits: [commit(sha('f'), '2030-02-01T00:00:00Z', 'Add F (#9)\n\nF is new.')] }));
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  const home = fs.mkdtempSync(path.join(tmp, 'home-'));
  const env = { ...process.env, MINERVA_MCP_HOME: home, MINERVA_UPDATE_API: `http://127.0.0.1:${api.address().port}` };
  delete env.MINERVA_NO_UPDATE_CHECK;
  const client = new Client({ name: 'test', version: '0' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ['src/server.js'], env }));
    const first = await client.callTool({ name: 'minerva_status', arguments: {} });
    assert.equal(first.content.length, 2);
    assert.match(first.content[0].text, /minerva-mcp update available/);
    assert.match(first.content[0].text, /ask whether they want to update/);
    assert.match(first.content[0].text, /Add F \(#9\)/);
    assert.match(first.content[1].text, /signedIn/);

    const second = await client.callTool({ name: 'minerva_status', arguments: {} });
    assert.equal(second.content.length, 1);

    const check = JSON.parse((await client.callTool({ name: 'minerva_check_update', arguments: {} })).content[0].text);
    assert.equal(check.updateAvailable, true);
  } finally {
    await client.close();
    api.close();
  }
});
