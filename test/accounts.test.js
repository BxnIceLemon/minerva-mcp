// Saved accounts: folders, migration, choosing, and adding a new account.
// Uses a temporary MINERVA_MCP_HOME with made-up sessions; no account needed.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'minerva-accounts-test-'));
process.env.MINERVA_MCP_HOME = home;
delete process.env.MINERVA_ACCOUNT;
const acc = await import('../src/accounts.js');
const { loadSession, saveSession } = await import('../src/session.js');

const write = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));
};

beforeEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(home);
  acc.selectAccount(null);
});

test.after(() => fs.rmSync(home, { recursive: true, force: true }));

test('moves a pre-accounts session into a folder named after its user', () => {
  write(path.join(home, 'session.json'), { userName: 'ab12cd', cookies: [] });
  write(path.join(home, 'gradescope-session.json'), { cookies: [] });
  write(path.join(home, 'browser-profile', 'Default', 'Cookies'), 'x');
  write(path.join(home, 'browser-profile-chrome', 'Default', 'Cookies'), 'y');

  assert.deepEqual(acc.listAccounts(), ['ab12cd']);
  const dir = path.join(home, 'accounts', 'ab12cd');
  for (const f of ['session.json', 'gradescope-session.json', 'browser-profile/Default/Cookies', 'browser-profile-chrome/Default/Cookies']) {
    assert.ok(fs.existsSync(path.join(dir, f)), f);
  }
  assert.ok(!fs.existsSync(path.join(home, 'session.json')));
  assert.deepEqual(acc.listAccounts(), ['ab12cd']); // idempotent
});

test('a Gradescope-only legacy session becomes the "default" account', () => {
  write(path.join(home, 'gradescope-session.json'), { cookies: [] });
  assert.deepEqual(acc.listAccounts(), ['default']);
});

test('uses the only account, and asks when there are several', () => {
  assert.equal(acc.currentAccount(), null);
  assert.equal(loadSession(), null);

  write(path.join(home, 'accounts', 'ab12cd', 'session.json'), { userName: 'ab12cd' });
  assert.equal(acc.currentAccount(), 'ab12cd');
  assert.equal(loadSession().userName, 'ab12cd');

  write(path.join(home, 'accounts', 'ef34gh', 'session.json'), { userName: 'ef34gh' });
  assert.throws(() => acc.currentAccount(), (e) => e instanceof acc.AccountChoiceError && e.accounts.join() === 'ab12cd,ef34gh');
  assert.throws(() => loadSession(), acc.AccountChoiceError);

  acc.selectAccount('ef34gh');
  assert.equal(loadSession().userName, 'ef34gh');
  assert.equal(acc.withAccount('ab12cd', () => loadSession().userName), 'ab12cd');
  assert.equal(acc.withAccount(undefined, () => acc.currentAccount()), 'ef34gh');
  assert.throws(() => acc.selectAccount('nobody'), /No saved account "nobody"/);
});

test('keeps each account\'s sessions and browser profile apart', async () => {
  fs.mkdirSync(path.join(home, 'accounts', 'ab12cd'), { recursive: true });
  fs.mkdirSync(path.join(home, 'accounts', 'ef34gh'), { recursive: true });
  await acc.withAccount('ab12cd', async () => {
    saveSession({ userName: 'ab12cd' });
    saveSession({ who: 'gs-ab' }, acc.sessionFile('gradescope'));
  });
  await acc.withAccount('ef34gh', async () => saveSession({ userName: 'ef34gh' }));

  assert.equal(acc.withAccount('ef34gh', () => loadSession(acc.sessionFile('gradescope'))), null);
  assert.equal(acc.withAccount('ab12cd', () => loadSession(acc.sessionFile('gradescope'))).who, 'gs-ab');
  assert.notEqual(acc.profileDir('msedge', 'ab12cd'), acc.profileDir('msedge', 'ef34gh'));
  assert.ok(acc.profileDir('chrome', 'ab12cd').endsWith(path.join('ab12cd', 'browser-profile-chrome')));
  const info = acc.accountInfo('ab12cd');
  assert.equal(info.minerva.signedIn, true);
  assert.equal(info.gradescope.signedIn, true);
  assert.equal(acc.accountInfo('ef34gh').gradescope.signedIn, false);
});

test('a new account is named after the Minerva user, replacing an earlier sign-in of the same user', () => {
  const p1 = acc.startNewAccount();
  assert.deepEqual(acc.listAccounts(), []); // still pending
  acc.withAccount(p1, () => saveSession({ userName: 'ab12cd', n: 1 }));
  assert.equal(acc.finishNewAccount(p1, 'ab12cd'), 'ab12cd');
  assert.deepEqual(acc.listAccounts(), ['ab12cd']);

  write(path.join(home, 'accounts', 'ab12cd', 'gradescope-session.json'), { keep: true });
  const p2 = acc.startNewAccount();
  acc.withAccount(p2, () => saveSession({ userName: 'ab12cd', n: 2 }));
  acc.finishNewAccount(p2, 'ab12cd');
  assert.equal(acc.withAccount('ab12cd', () => loadSession()).n, 2);
  assert.ok(fs.existsSync(path.join(home, 'accounts', 'ab12cd', 'gradescope-session.json')));
  assert.equal(fs.readdirSync(path.join(home, 'accounts')).length, 1);

  const p3 = acc.startNewAccount();
  acc.discardNewAccount(p3);
  assert.equal(fs.readdirSync(path.join(home, 'accounts')).length, 1);
});

test('rejects account names that could escape the accounts folder', () => {
  for (const bad of ['../x', '..', '.hidden', 'a/b', '', 'a\\b']) assert.equal(acc.isValidName(bad), false, bad);
  assert.equal(acc.isValidName('ab12cd'), true);
  fs.mkdirSync(path.join(home, 'accounts', '.new-abc'), { recursive: true });
  assert.deepEqual(acc.listAccounts(), []);
  assert.throws(() => acc.finishNewAccount(acc.startNewAccount(), '../evil'), /Can't name an account/);
});
