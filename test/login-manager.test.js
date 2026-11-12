// The agent sign-in flow with a fake sign-in: no browser opens.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'minerva-login-manager-'));
process.env.MINERVA_MCP_HOME = home;
after(() => fs.rmSync(home, { recursive: true, force: true }));
const { agentLogin, pendingLogin, setLoginForTests } = await import('../src/login-manager.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('calling back after a sign-in finished reports it instead of starting another', async () => {
  const started = [];
  setLoginForTests(async (service, opts) => {
    started.push({ service, ...opts });
    opts.onOpen?.({ name: 'Fake Browser' });
    await sleep(100);
    return { signedIn: true, mode: 'interactive', account: 'ab12cd', userName: 'ab12cd', newAccount: true };
  });
  try {
    // The agent's first call returns while the user is still signing in.
    const waiting = await agentLogin('minerva', { account: null, waitSeconds: 0.02 });
    assert.equal(waiting.signedIn, false);
    assert.equal(waiting.waitingForUser, true);
    assert.ok(pendingLogin('minerva', null));

    await sleep(200); // the user finishes before the agent calls back

    const done = await agentLogin('minerva', { account: null, waitSeconds: 1 });
    assert.equal(done.signedIn, true);
    assert.equal(done.account, 'ab12cd');
    assert.equal(started.length, 1, 'no second sign-in window');
    assert.equal(started[0].newAccount, true);

    // Once reported, a new call is a new sign-in.
    await agentLogin('minerva', { account: null, waitSeconds: 1 });
    assert.equal(started.length, 2);
  } finally {
    setLoginForTests(null);
  }
});

test('sign-ins for different accounts are tracked separately', async () => {
  const started = [];
  setLoginForTests(async (service, opts) => {
    started.push(opts.account ?? 'new');
    await sleep(20);
    return { signedIn: true, mode: 'silent', account: opts.account };
  });
  try {
    const [a, b] = await Promise.all([
      agentLogin('minerva', { account: 'ab12cd', waitSeconds: 1 }),
      agentLogin('minerva', { account: 'ef34gh', waitSeconds: 1 }),
    ]);
    assert.equal(a.account, 'ab12cd');
    assert.equal(b.account, 'ef34gh');
    assert.deepEqual(started.sort(), ['ab12cd', 'ef34gh']);
  } finally {
    setLoginForTests(null);
  }
});
