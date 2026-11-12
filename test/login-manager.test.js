// The agent sign-in flow with a fake sign-in: no browser opens.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'minerva-login-manager-'));
process.env.MINERVA_MCP_HOME = home;
after(() => fs.rmSync(home, { recursive: true, force: true }));
const { agentLogin, pendingLogin, setLoginForTests, silentRefresh, withSessionRefresh } = await import('../src/login-manager.js');
const { SessionError } = await import('../src/client.js');

// Made-up accounts: one with a browser profile to refresh from, one without.
for (const [a, profile] of [['withprofile', true], ['noprofile', false], ['failing', true], ['gsonly', true]]) {
  fs.mkdirSync(path.join(home, 'accounts', a, profile ? 'browser-profile' : ''), { recursive: true });
}

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

test('a silent refresh runs once for parallel calls, never asks the user, and backs off after failing', async () => {
  const calls = [];
  setLoginForTests(async (service, opts) => {
    calls.push({ service, ...opts });
    await sleep(30);
    return { signedIn: opts.account !== 'failing', mode: 'silent', account: opts.account };
  });
  try {
    const [a, b] = await Promise.all([silentRefresh('minerva', 'withprofile'), silentRefresh('minerva', 'withprofile')]);
    assert.equal(a, true);
    assert.equal(b, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].interactive, false, 'never opens a window');
    assert.equal(calls[0].account, 'withprofile');

    assert.equal(await silentRefresh('minerva', 'noprofile'), false);
    assert.equal(await silentRefresh('minerva', null), false);
    assert.equal(calls.length, 1, 'nothing to refresh from');

    assert.equal(await silentRefresh('minerva', 'failing'), false);
    assert.equal(await silentRefresh('minerva', 'failing'), false);
    assert.equal(calls.filter((c) => c.account === 'failing').length, 1, 'backs off after a failure');

    process.env.MINERVA_NO_AUTO_LOGIN = '1';
    try {
      assert.equal(await silentRefresh('gradescope', 'withprofile'), false);
    } finally {
      delete process.env.MINERVA_NO_AUTO_LOGIN;
    }
    assert.equal(calls.length, 2);
  } finally {
    setLoginForTests(null);
  }
});

test('an expired session is renewed and a read is run again; a write is not', async () => {
  const refreshed = [];
  setLoginForTests(async (service, opts) => {
    refreshed.push(service);
    return { signedIn: true, mode: 'silent', account: opts.account };
  });
  try {
    let tries = 0;
    const read = () => {
      tries += 1;
      if (tries === 1) throw new SessionError('Gradescope session expired.', 'gradescope');
      return 'data';
    };
    assert.equal(await withSessionRefresh(read, 'gsonly', { rerun: true }), 'data');
    assert.equal(tries, 2);
    assert.deepEqual(refreshed, ['gradescope']);

    let writes = 0;
    const write = () => {
      writes += 1;
      throw new SessionError('Minerva session expired.');
    };
    await assert.rejects(withSessionRefresh(write, 'withprofile', { rerun: false }), /renewed silently; nothing was sent\. Call this tool again/);
    assert.equal(writes, 1, 'a write is never re-run by itself');

    // Other errors, and calls without an account, pass straight through.
    await assert.rejects(withSessionRefresh(() => { throw new Error('boom'); }, 'withprofile', { rerun: true }), /boom/);
    await assert.rejects(withSessionRefresh(() => { throw new SessionError('Not signed in to Minerva.'); }, null, { rerun: true }), /Not signed in/);
  } finally {
    setLoginForTests(null);
  }
});

test('when the silent refresh fails, the original error reaches the agent', async () => {
  setLoginForTests(async () => ({ signedIn: false, needsUser: true }));
  try {
    fs.mkdirSync(path.join(home, 'accounts', 'needsuser', 'browser-profile'), { recursive: true });
    await assert.rejects(
      withSessionRefresh(() => { throw new SessionError('Minerva session expired. Call the minerva_login tool.'); }, 'needsuser', { rerun: true }),
      /Call the minerva_login tool/,
    );
  } finally {
    setLoginForTests(null);
  }
});
