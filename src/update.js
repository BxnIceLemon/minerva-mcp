// Checks whether this copy of minerva-mcp is behind the main branch on GitHub,
// and updates it on request. The check is one unauthenticated request to
// api.github.com with the commit id this copy runs; no cookies or account data
// are sent. MINERVA_NO_UPDATE_CHECK=1 turns it off.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
export const REPO = 'BxnIceLemon/minerva-mcp';
export const BRANCH = 'main';
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = process.env.MINERVA_UPDATE_API || 'https://api.github.com';
const MAX_CHANGES = 30;
const MAX_DETAIL = 1500;

async function git(args, cwd = ROOT) {
  const { stdout } = await run('git', ['-C', cwd, ...args], { timeout: 60000, maxBuffer: 10 * 1024 * 1024 });
  return stdout.trim();
}

function packageVersion(root = ROOT) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  } catch {
    return undefined;
  }
}

/** The commit this copy runs, or null when it isn't a git checkout. */
export async function localVersion(root = ROOT) {
  try {
    const [commit, date, branch, dirty] = await Promise.all([
      git(['rev-parse', 'HEAD'], root),
      git(['log', '-1', '--format=%cI'], root),
      git(['rev-parse', '--abbrev-ref', 'HEAD'], root),
      git(['status', '--porcelain', '--untracked-files=no'], root),
    ]);
    return { commit, date, branch, localChanges: dirty !== '', version: packageVersion(root) };
  } catch {
    return null;
  }
}

async function github(pathname, fetchImpl) {
  const r = await fetchImpl(`${API}${pathname}`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'minerva-mcp-update-check' },
    signal: AbortSignal.timeout(8000),
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub answered HTTP ${r.status}`);
  return r.json();
}

function shapeChange(c) {
  const [title, ...rest] = String(c.commit?.message ?? '').split('\n');
  const details = rest.join('\n').trim();
  return {
    commit: c.sha?.slice(0, 7),
    date: c.commit?.committer?.date,
    title,
    details: details ? (details.length > MAX_DETAIL ? `${details.slice(0, MAX_DETAIL)}…` : details) : undefined,
  };
}

/**
 * Compares this copy with the main branch on GitHub. Resolves to
 * { updateAvailable, current, latest, behindBy, changes, compareUrl }, or
 * { checked: false, reason } when it can't tell. Never throws.
 */
export async function checkForUpdate({ fetchImpl = fetch, local } = {}) {
  if (process.env.MINERVA_NO_UPDATE_CHECK === '1') return { checked: false, reason: 'Turned off with MINERVA_NO_UPDATE_CHECK=1' };
  try {
    const current = local ?? (await localVersion());
    if (!current) return { checked: false, reason: 'This copy is not a git checkout, so its version is unknown' };
    const head = await github(`/repos/${REPO}/commits/${BRANCH}`, fetchImpl);
    if (!head?.sha) return { checked: false, reason: 'Could not read the latest version from GitHub' };
    const latest = { commit: head.sha, date: head.commit?.committer?.date, title: head.commit?.message?.split('\n')[0] };
    const out = (changes, extra = {}) => ({
      checked: true,
      updateAvailable: changes.length > 0,
      current: { ...current, commit: current.commit.slice(0, 7) },
      latest: { ...latest, commit: latest.commit.slice(0, 7) },
      behindBy: changes.length,
      changes: changes.slice(-MAX_CHANGES).reverse().map(shapeChange),
      compareUrl: `https://github.com/${REPO}/compare/${current.commit.slice(0, 7)}...${BRANCH}`,
      ...extra,
    });
    if (head.sha === current.commit) return out([]);

    const cmp = await github(`/repos/${REPO}/compare/${current.commit}...${BRANCH}`, fetchImpl);
    if (cmp && cmp.status) {
      return out(cmp.commits ?? [], cmp.behind_by ? { localOnlyCommits: cmp.behind_by } : {});
    }
    // No shared history (an old or rewritten branch): list what main gained
    // since this copy's commit date instead.
    const since = await github(`/repos/${REPO}/commits?sha=${BRANCH}&since=${encodeURIComponent(current.date)}&per_page=${MAX_CHANGES}`, fetchImpl);
    const newer = (Array.isArray(since) ? since : []).filter((c) => c.sha !== current.commit).reverse();
    return out(newer, {
      approximate: true,
      note: "This copy's history isn't on GitHub's main branch, so changes are listed by date and may include some it already has.",
    });
  } catch (e) {
    return { checked: false, reason: `Update check failed: ${e.message}` };
  }
}

/**
 * Updates this copy to the latest main branch: fetch, switch to main (an
 * earlier branch is kept), fast-forward, and install dependencies. A local
 * main with commits GitHub doesn't have is renamed to a backup branch first.
 * Refuses when tracked files have local changes.
 */
export async function applyUpdate({ dryRun = false, root = ROOT } = {}) {
  const current = await localVersion(root);
  if (!current) throw new Error(`${root} is not a git checkout; update it by downloading the latest version from https://github.com/${REPO}`);
  if (current.localChanges) throw new Error(`${root} has local changes to tracked files. Commit or stash them, then update.`);
  const steps = [
    `git fetch origin ${BRANCH}`,
    current.branch === BRANCH ? `git merge --ff-only origin/${BRANCH}` : `git switch ${BRANCH} (from ${current.branch}, which is kept) and fast-forward it`,
    `if local ${BRANCH} has commits GitHub doesn't, it is first renamed to a backup branch (${BRANCH}-before-update-…)`,
    'npm install',
  ];
  if (dryRun) return { dryRun: true, folder: root, from: current, steps, then: 'Restart the MCP client so it starts the new version.' };

  await git(['fetch', 'origin', BRANCH], root);
  let keptAs;
  const hasMain = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${BRANCH}`], root).then(() => true, () => false);
  if (hasMain) {
    const mergeBase = await git(['merge-base', BRANCH, `origin/${BRANCH}`], root).catch(() => '');
    const localMain = await git(['rev-parse', BRANCH], root);
    if (mergeBase !== localMain) {
      // Local main has commits GitHub doesn't: keep them on a backup branch.
      keptAs = `${BRANCH}-before-update-${new Date().toISOString().slice(0, 10)}-${localMain.slice(0, 7)}`;
      if (current.branch === BRANCH) await git(['switch', '--detach'], root);
      await git(['branch', '-m', BRANCH, keptAs], root);
    }
  }
  if (hasMain && !keptAs) {
    if (current.branch !== BRANCH) await git(['switch', BRANCH], root);
    await git(['merge', '--ff-only', `origin/${BRANCH}`], root);
  } else {
    await git(['switch', '-c', BRANCH, '--track', `origin/${BRANCH}`], root);
  }
  await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund'], { cwd: root, timeout: 300000 });
  const after = await localVersion(root);
  return {
    updated: true,
    folder: root,
    from: { ...current, commit: current.commit.slice(0, 7) },
    to: { ...after, commit: after.commit.slice(0, 7) },
    previousBranchKept: current.branch !== BRANCH ? current.branch : undefined,
    oldMainKeptAs: keptAs,
    then: 'Restart the MCP client (or reload its MCP servers) so it starts the new version.',
  };
}
