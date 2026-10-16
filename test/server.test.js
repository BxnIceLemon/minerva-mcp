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

test('registers every tool', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  assert.equal(names.length, 16);
  assert.ok(names.filter((n) => n.startsWith('minerva_')).length === 11);
  assert.ok(names.filter((n) => n.startsWith('gradescope_')).length === 5);
});

test('reports not signed in when no session is saved', async () => {
  assert.equal(JSON.parse((await call('minerva_status')).text).signedIn, false);
  assert.equal(JSON.parse((await call('gradescope_status')).text).signedIn, false);
});

test('tools fail with a login hint instead of crashing', async () => {
  const m = await call('minerva_list_courses');
  assert.ok(m.isError);
  assert.match(m.text, /npm run login/);
  const g = await call('gradescope_list_courses');
  assert.ok(g.isError);
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
