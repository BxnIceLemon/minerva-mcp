// Offline tests: no Minerva or Gradescope account needed. They start the real
// server over stdio with an empty session folder and check the guards.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'minerva-mcp-test-'));
const client = new Client({ name: 'test', version: '0' });

before(async () => {
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ['src/server.js'],
      env: { ...process.env, MINERVA_MCP_HOME: home },
    }),
  );
});

after(async () => {
  await client.close();
  fs.rmSync(home, { recursive: true, force: true });
});

async function call(name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  return { isError: Boolean(r.isError), text: r.content[0].text };
}

const WRITE_TOOLS = [
  'minerva_submit',
  'gradescope_submit',
  'gradescope_request_regrade',
  'gradescope_activate_submission',
  'gradescope_add_group_members',
  'gradescope_remove_group_member',
];

test('registers every read and write tool by default', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  assert.equal(names.filter((n) => n.startsWith('minerva_')).length, 14);
  assert.equal(names.filter((n) => n.startsWith('gradescope_')).length, 16);
  for (const n of ['minerva_login', 'minerva_list_submissions', 'gradescope_login', ...WRITE_TOOLS]) {
    assert.ok(names.includes(n), n);
  }
  // Only the write tools are marked as changing anything.
  for (const t of tools) {
    assert.equal(t.annotations?.readOnlyHint === false && t.name !== 'minerva_download_attachment', WRITE_TOOLS.includes(t.name), t.name);
  }
  assert.equal(tools.find((t) => t.name === 'minerva_submit').annotations.destructiveHint, true);
  assert.equal(tools.find((t) => t.name === 'gradescope_submit').annotations.destructiveHint, true);
});

test('write tools refuse to send without confirm: true', async () => {
  const cases = [
    ['minerva_submit', { courseId: 'COMP1', assignment: 'CW1', files: ['x.zip'] }],
    ['gradescope_submit', { courseId: '1', assignmentId: '2', files: ['x.py'] }],
    ['gradescope_activate_submission', { courseId: '1', assignmentId: '2', submissionId: '3' }],
    ['gradescope_request_regrade', { courseId: '1', assignmentId: '2', question: '1.1', comment: 'x' }],
    ['gradescope_add_group_members', { courseId: '1', assignmentId: '2', members: ['a'] }],
    ['gradescope_remove_group_member', { courseId: '1', assignmentId: '2', member: 'me' }],
  ];
  for (const [name, args] of cases) {
    for (const extra of [{}, { confirm: false }]) {
      const r = await call(name, { ...args, ...extra });
      assert.ok(r.isError, name);
      assert.match(r.text, /Not sent/, name);
    }
  }
});

test('reports not signed in when no session is saved', async () => {
  assert.equal(JSON.parse((await call('minerva_status')).text).signedIn, false);
  assert.equal(JSON.parse((await call('gradescope_status')).text).signedIn, false);
});

test('tools fail with a login hint instead of crashing', async () => {
  const m = await call('minerva_list_courses');
  assert.ok(m.isError);
  assert.match(m.text, /minerva_login tool/);
  assert.match(m.text, /npm run login/);
  const g = await call('gradescope_list_courses');
  assert.ok(g.isError);
  assert.match(g.text, /gradescope_login tool/);
  assert.match(g.text, /npm run login:gradescope/);
});

test('raw API tool refuses other hosts and non-public paths', async () => {
  fs.writeFileSync(
    path.join(home, 'session.json'),
    JSON.stringify({ cookies: [{ name: 'x', value: 'y', domain: 'minerva.leeds.ac.uk', path: '/' }], userId: '_1_1' }),
  );
  const evil = await call('minerva_api_get', { path: 'https://evil.example.com/learn/api/public/v1/users/me' });
  assert.ok(evil.isError);
  assert.match(evil.text, /Refusing to send the Minerva session/);
  const internal = await call('minerva_api_get', { path: '/webapps/blackboard/execute' });
  assert.ok(internal.isError);
  assert.match(internal.text, /Only \/learn\/api\/public\//);
});
