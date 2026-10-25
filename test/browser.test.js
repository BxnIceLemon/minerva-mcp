// Browser selection without launching anything.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chooseBrowser, defaultBrowser } from '../src/browser.js';

const saved = process.env.MINERVA_BROWSER;
afterEach(() => {
  if (saved === undefined) delete process.env.MINERVA_BROWSER;
  else process.env.MINERVA_BROWSER = saved;
});

test('MINERVA_BROWSER channel overrides the default browser', () => {
  process.env.MINERVA_BROWSER = 'chrome';
  const b = chooseBrowser();
  assert.equal(b.channel, 'chrome');
  assert.equal(b.source, 'MINERVA_BROWSER');
});

test('without an override, a Chromium default is used, else Edge/Chrome', () => {
  delete process.env.MINERVA_BROWSER;
  const def = defaultBrowser();
  const b = chooseBrowser();
  assert.ok(b.chromium);
  if (b.source === 'system default') {
    assert.equal(b.executablePath, def.executablePath);
  } else {
    assert.equal(b.source, 'fallback');
    assert.deepEqual(b.fallbackChannels, ['msedge', 'chrome']);
  }
});
