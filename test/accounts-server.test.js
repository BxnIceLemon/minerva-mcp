// The MCP server with two saved (made-up) accounts: it must not guess which
// one to use. The accounts have no sessions, so no request leaves the machine.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'minerva-accounts-mcp-'));
for (const a of ['ab12cd', 'ef34gh']) fs.mkdirSync(path.join(home, 'accounts', a), { recursive: true });
after(() => fs.rmSync(home, { recursive: true, force: true }));

async function connect(answer) {
  const client = new Client({ name: 'test', version: '0' }, answer ? { capabilities: { elicitation: {} } } : {});
  const asked = [];
  if (answer) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      asked.push(req.params);
      return answer === 'decline' ? { action: 'decline' } : { action: 'accept', content: { account: answer } };
    });
  }
  const env = { ...process.env, MINERVA_MCP_HOME: home, MINERVA_NO_UPDATE_CHECK: '1', MINERVA_NO_AUTO_LOGIN: '1' };
  delete env.MINERVA_ACCOUNT;
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['src/server.js'], env }));
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { isError: Boolean(r.isError), text: r.content[0].text };
  };
  return { client, call, asked };
}

test('without a way to prompt, tools ask the agent to ask the user', async () => {
  const { client, call } = await connect();
  try {
    const r = await call('minerva_list_courses');
    assert.ok(r.isError);
    assert.match(r.text, /Several accounts are saved: ab12cd, ef34gh/);
    assert.match(r.text, /Ask the user which account to use/);

    const login = await call('minerva_login');
    assert.ok(login.isError);
    assert.match(login.text, /newAccount: true/);

    const status = JSON.parse((await call('minerva_status')).text);
    assert.deepEqual(status.accounts.map((a) => a.account), ['ab12cd', 'ef34gh']);

    const listed = JSON.parse((await call('minerva_list_accounts')).text);
    assert.equal(listed.selected, null);
    assert.equal(listed.accounts.length, 2);

    // An explicit account is used, for that call only.
    const explicit = await call('minerva_list_courses', { account: 'ab12cd' });
    assert.match(explicit.text, /Not signed in to Minerva/);
    assert.match((await call('gradescope_list_courses', { account: 'ef34gh' })).text, /Not signed in to Gradescope/);
    assert.match((await call('minerva_list_courses')).text, /Several accounts are saved/);
    assert.match((await call('minerva_list_courses', { account: '../etc' })).text, /No saved account/);

    // Choosing one keeps it for the session.
    const sel = JSON.parse((await call('minerva_select_account', { account: 'ef34gh' })).text);
    assert.equal(sel.account, 'ef34gh');
    assert.equal(sel.selected, true);
    assert.match((await call('minerva_list_courses')).text, /Not signed in to Minerva/);
    assert.equal(JSON.parse((await call('minerva_status')).text).account, 'ef34gh');
  } finally {
    await client.close();
  }
});

test('with a client that can prompt, the user is asked once and the answer is kept', async () => {
  const { client, call, asked } = await connect('ef34gh');
  try {
    assert.match((await call('minerva_list_courses')).text, /Not signed in to Minerva/);
    assert.equal(asked.length, 1);
    assert.deepEqual(asked[0].requestedSchema.properties.account.enum, ['ab12cd', 'ef34gh']);
    assert.match(asked[0].message, /Which one should/);

    assert.match((await call('gradescope_list_courses')).text, /Not signed in to Gradescope/);
    assert.equal(asked.length, 1);
    assert.equal(JSON.parse((await call('minerva_list_accounts')).text).selected, 'ef34gh');
  } finally {
    await client.close();
  }
});

test('if the user dismisses the prompt, nothing runs', async () => {
  const { client, call, asked } = await connect('decline');
  try {
    const r = await call('minerva_list_courses');
    assert.ok(r.isError);
    assert.match(r.text, /Ask the user which account to use/);
    assert.equal(asked.length, 1);
  } finally {
    await client.close();
  }
});
