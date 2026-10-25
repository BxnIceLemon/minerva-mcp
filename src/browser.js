// Finds the system default browser and opens login pages in it. Sessions live
// in a dedicated profile under ~/.minerva-mcp, never in your everyday browser
// profile: Chromium browsers refuse automation of the default profile, and
// reading another profile's cookies would mean touching its credential store.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright-core';
import { PROFILE_DIR } from './config.js';

export const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

// Chromium-based browsers Playwright can drive, keyed by executable name.
const CHROMIUM = {
  'msedge.exe': ['msedge', 'Microsoft Edge'],
  'chrome.exe': ['chrome', 'Google Chrome'],
  'brave.exe': ['brave', 'Brave'],
  'vivaldi.exe': ['vivaldi', 'Vivaldi'],
  'opera.exe': ['opera', 'Opera'],
  'chromium.exe': ['chromium', 'Chromium'],
  'arc.exe': ['arc', 'Arc'],
  'microsoft edge': ['msedge', 'Microsoft Edge'],
  'google chrome': ['chrome', 'Google Chrome'],
  'brave browser': ['brave', 'Brave'],
  vivaldi: ['vivaldi', 'Vivaldi'],
  chromium: ['chromium', 'Chromium'],
  arc: ['arc', 'Arc'],
  'microsoft-edge': ['msedge', 'Microsoft Edge'],
  'microsoft-edge-stable': ['msedge', 'Microsoft Edge'],
  'google-chrome': ['chrome', 'Google Chrome'],
  'google-chrome-stable': ['chrome', 'Google Chrome'],
  'brave-browser': ['brave', 'Brave'],
  'chromium-browser': ['chromium', 'Chromium'],
};

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
  } catch {
    return '';
  }
}

function describe(executablePath) {
  const key = path.basename(executablePath).toLowerCase();
  const [id, name] = CHROMIUM[key] ?? [key.replace(/\.exe$/, ''), path.basename(executablePath)];
  return { id, name, executablePath, chromium: key in CHROMIUM };
}

function windowsDefault() {
  const choice = run('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice', '/v', 'ProgId']);
  const progId = choice.match(/ProgId\s+REG_SZ\s+(\S+)/)?.[1];
  if (!progId) return null;
  const cmd = run('reg', ['query', `HKCR\\${progId}\\shell\\open\\command`, '/ve']);
  const exe = cmd.match(/REG_SZ\s+"([^"]+\.exe)"/i)?.[1] ?? cmd.match(/REG_SZ\s+(\S+\.exe)/i)?.[1];
  return exe ? describe(exe) : null;
}

function macDefault() {
  const plist = run('defaults', ['read', `${os.homedir()}/Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure`, 'LSHandlers']);
  const block = plist.split(/\},?\s*\{/).find((b) => /LSHandlerURLScheme\s*=\s*https;/.test(b));
  const bundle = block?.match(/LSHandlerRoleAll\s*=\s*"?([\w.-]+)"?;/)?.[1];
  const apps = {
    'com.microsoft.edgemac': 'Microsoft Edge',
    'com.google.chrome': 'Google Chrome',
    'com.brave.browser': 'Brave Browser',
    'com.vivaldi.vivaldi': 'Vivaldi',
    'org.chromium.chromium': 'Chromium',
    'company.thebrowser.browser': 'Arc',
  };
  const app = apps[bundle?.toLowerCase()];
  if (!app) return bundle ? { id: bundle, name: bundle, executablePath: null, chromium: false } : null;
  const exe = `/Applications/${app}.app/Contents/MacOS/${app}`;
  return fs.existsSync(exe) ? describe(exe) : null;
}

function linuxDefault() {
  const desktop = run('xdg-settings', ['get', 'default-web-browser']).trim();
  if (!desktop) return null;
  const bin = desktop.replace(/\.desktop$/, '');
  const exe = run('which', [bin]).trim();
  return exe ? describe(exe) : { id: bin, name: bin, executablePath: null, chromium: false };
}

/** The browser the OS opens links in, or null if it can't be determined. */
export function defaultBrowser() {
  if (process.platform === 'win32') return windowsDefault();
  if (process.platform === 'darwin') return macDefault();
  return linuxDefault();
}

/**
 * Picks the browser for logins: MINERVA_BROWSER (a path or a channel such as
 * msedge/chrome) if set, else the system default when it is Chromium-based,
 * else an installed Edge or Chrome. Firefox and Safari can't be automated.
 */
export function chooseBrowser() {
  const env = process.env.MINERVA_BROWSER;
  if (env && env !== 'default') {
    if (fs.existsSync(env)) return { ...describe(env), source: 'MINERVA_BROWSER' };
    return { id: env, name: env, channel: env, chromium: true, source: 'MINERVA_BROWSER' };
  }
  const def = defaultBrowser();
  if (def?.chromium && def.executablePath && fs.existsSync(def.executablePath)) return { ...def, source: 'system default' };
  const note = def ? `${def.name} can't be automated, so an installed Edge or Chrome is used instead` : undefined;
  return { id: 'msedge', name: 'Microsoft Edge', channel: 'msedge', chromium: true, source: 'fallback', fallbackChannels: ['msedge', 'chrome'], note };
}

// One profile per browser. Edge keeps the original path so existing sign-ins
// (including Microsoft's "Stay signed in") carry over.
function profileFor(browser) {
  return browser.id === 'msedge' ? PROFILE_DIR : `${PROFILE_DIR}-${browser.id}`;
}

export class ProfileBusyError extends Error {}

/** Opens a persistent context in the chosen browser. */
export async function launch({ headless = false } = {}) {
  const browser = chooseBrowser();
  const dir = profileFor(browser);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const attempts = browser.executablePath
    ? [{ executablePath: browser.executablePath }]
    : (browser.fallbackChannels ?? [browser.channel]).map((channel) => ({ channel }));
  const errors = [];
  for (const target of attempts) {
    try {
      const context = await chromium.launchPersistentContext(dir, { ...target, headless, viewport: null });
      return { context, browser };
    } catch (e) {
      const msg = e.message.split('\n')[0];
      if (/ProcessSingleton|user data directory is already in use|profile.*in use/i.test(e.message)) {
        throw new ProfileBusyError('A sign-in window is already open. Finish signing in there, or close it and try again.');
      }
      errors.push(`${target.executablePath ?? target.channel}: ${msg}`);
    }
  }
  throw new Error(`Could not start ${browser.name}.\n${errors.join('\n')}`);
}

// Polls `check` until it returns a value, the timeout passes, or the user
// closes every window.
export async function waitFor(context, check, timeoutMs = LOGIN_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check().catch(() => null);
    if (result) return result;
    if (context.pages().length === 0) return null;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return null;
}

export function plainCookies(cookies) {
  return cookies.map(({ name, value, domain, path, expires }) => ({ name, value, domain, path, expires }));
}
