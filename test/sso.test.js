// Terminal sign-in: page classification and option handling, no browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, duoVerificationCode, normalizeUsername, pickProof } from '../src/sso.js';

const MS = 'login.microsoftonline.com';
const DUO = 'api-0000aaaa.duosecurity.com';
const page = (over) => ({
  host: MS,
  title: '',
  text: '',
  username: false,
  password: false,
  tiles: false,
  external: false,
  kmsi: false,
  proofs: [],
  otc: false,
  msNumber: '',
  msError: '',
  duoPasscode: false,
  duoTrust: false,
  duoCode: '',
  ...over,
});

test('usernames get the University domain unless one is given', () => {
  assert.equal(normalizeUsername(' ab12cd '), 'ab12cd@leeds.ac.uk');
  assert.equal(normalizeUsername('someone@example.org'), 'someone@example.org');
  assert.equal(normalizeUsername(''), '');
});

test('Microsoft sign-in steps', () => {
  assert.equal(classify(page({ username: true })), 'ms-username');
  assert.equal(classify(page({ username: true, msError: 'This username may be incorrect.' })), 'ms-username-error');
  assert.equal(classify(page({ password: true })), 'ms-password');
  assert.equal(classify(page({ password: true, username: true, msError: 'Your password is incorrect.' })), 'ms-password-error');
  assert.equal(classify(page({ tiles: true })), 'ms-tiles');
  assert.equal(classify(page({ kmsi: true })), 'ms-kmsi');
  assert.equal(classify(page({ external: true })), 'ms-external');
  assert.equal(classify(page({ proofs: ['PhoneAppNotification', 'OneWaySMS'] })), 'ms-proofs');
  assert.equal(classify(page({ msNumber: '42' })), 'ms-number');
  assert.equal(classify(page({ otc: true })), 'ms-otc');
  assert.equal(classify(page({})), 'ms-other');
});

test('Duo Universal Prompt steps', () => {
  const duo = (over) => page({ host: DUO, ...over });
  assert.equal(classify(duo({ text: 'Check for a Duo Push\nSent to "iOS"\nOther options' })), 'duo-wait');
  assert.equal(classify(duo({ text: 'Enter code in Duo Mobile', duoCode: '123' })), 'duo-code');
  assert.equal(classify(duo({ text: 'Other options to log in\nDuo Push\nDuo Mobile passcode' })), 'duo-methods');
  assert.equal(classify(duo({ duoPasscode: true, text: 'Enter a passcode' })), 'duo-passcode');
  assert.equal(classify(duo({ duoTrust: true })), 'duo-trust');
  assert.equal(classify(duo({ text: 'Is this your device?' })), 'duo-trust');
  assert.equal(classify(duo({ text: 'Login timed out.\nTry again' })), 'duo-failed');
  assert.equal(classify(page({ host: 'minerva.leeds.ac.uk' })), 'other');
});

test('the code of a verified Duo Push is read from the page text', () => {
  const text = 'Enter code in Duo Mobile\n\nVerify it\'s you by entering this verification code in the Duo Mobile app…\n\n123\n\nSent to "iOS" (••-••••-••0000)\n\nOther options';
  assert.equal(duoVerificationCode(text), '123');
  assert.equal(classify(page({ host: DUO, text })), 'duo-code');
  assert.equal(duoVerificationCode('Check for a Duo Push\nSent to "iOS" (••-••••-••0000)'), '');
});

test('Microsoft proof choice prefers Duo, then the requested method', () => {
  assert.equal(pickProof(['OneWaySMS', 'PhoneAppNotification'], 'push'), 'PhoneAppNotification');
  assert.equal(pickProof(['OneWaySMS', 'PhoneAppNotification'], 'sms'), 'OneWaySMS');
  assert.equal(pickProof(['PhoneAppNotification', 'ExternalAuthMethod_Duo'], 'push'), 'ExternalAuthMethod_Duo');
  assert.equal(pickProof(['Something'], 'call'), 'Something');
});
