// The temporary file holding the full result of the latest Gradescope query.
// Uses its own TMPDIR, so the real file is never touched.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'minerva-output-test-')));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
process.env.TMPDIR = tmp;
const { lastOutputFile, saveLastOutput } = await import('../src/output-file.js');

test('writes one file per query, replaces it each time, and only the user can read it', () => {
  const file = saveLastOutput({ tool: 'a', result: 'x'.repeat(200000) });
  assert.equal(file, path.join(tmp, 'minerva-mcp', 'gradescope-last-output.json'));
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).result.length, 200000);
  saveLastOutput({ tool: 'b', result: 1 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { tool: 'b', result: 1 });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['gradescope-last-output.json']); // no leftover temp files
});

test('the MCP server saves every Gradescope answer there, errors included, and nothing else', async () => {
  const home = fs.mkdtempSync(path.join(tmp, 'home-'));
  fs.mkdirSync(path.join(home, 'accounts', 'ab12cd'), { recursive: true });
  const env = { ...process.env, MINERVA_MCP_HOME: home, TMPDIR: tmp, MINERVA_NO_UPDATE_CHECK: '1', MINERVA_NO_AUTO_LOGIN: '1' };
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['src/server.js'], env }));
  const file = lastOutputFile();
  fs.rmSync(file, { force: true });
  try {
    const status = await client.callTool({ name: 'gradescope_status', arguments: {} });
    assert.match(status.content.at(-1).text, /Full output saved to .*gradescope-last-output\.json/);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(saved.tool, 'gradescope_status');
    assert.equal(saved.result.signedIn, false);
    // The answer itself still parses on its own.
    assert.equal(JSON.parse(status.content[0].text).signedIn, false);

    const courses = await client.callTool({ name: 'gradescope_list_courses', arguments: { search: 'COMP' } });
    assert.ok(courses.isError);
    const err = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(err.tool, 'gradescope_list_courses');
    assert.equal(err.account, 'ab12cd');
    assert.deepEqual(err.arguments, { search: 'COMP' });
    assert.match(err.error, /Not signed in to Gradescope/);
    assert.equal(err.result, undefined);

    // Minerva tools leave it alone.
    const m = await client.callTool({ name: 'minerva_status', arguments: {} });
    assert.ok(!m.content.some((c) => /Full output saved/.test(c.text)));
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).tool, 'gradescope_list_courses');
  } finally {
    await client.close();
  }
});
