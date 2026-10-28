// Gradescope's web uploader unzips a .zip in the browser and uploads every
// file inside it separately, named by its path in the archive. Uploading the
// .zip itself skips that step, so the server keeps it as one opaque file. This
// does the same unpacking before a code upload.
import { unzipSync } from 'fflate';

const MAX_ENTRIES = 5000;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;

// Archive paths become upload filenames, so keep them relative and tidy.
function safeEntryName(name, zipName) {
  const n = name.replace(/\\/g, '/');
  if (n.startsWith('/') || /^[a-zA-Z]:/.test(n) || n.split('/').includes('..')) {
    throw new Error(`${zipName} contains an unsafe path: ${name}`);
  }
  return n;
}

// macOS adds these when zipping in Finder; the browser would upload them too,
// but they are never part of a submission.
function isJunk(name) {
  return name.startsWith('__MACOSX/') || name.split('/').pop() === '.DS_Store';
}

/** Returns the files inside a zip as [{ name, data, bytes }], directories skipped. */
export function expandZip(bytes, zipName = 'archive.zip') {
  let entries;
  try {
    entries = unzipSync(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  } catch (e) {
    throw new Error(`Could not read ${zipName} as a zip file (${e.message}). Encrypted zips are not supported.`);
  }
  const files = [];
  let total = 0;
  for (const [rawName, data] of Object.entries(entries)) {
    if (rawName.endsWith('/') || isJunk(rawName)) continue;
    const name = safeEntryName(rawName, zipName);
    total += data.length;
    if (files.length >= MAX_ENTRIES) throw new Error(`${zipName} has more than ${MAX_ENTRIES} files`);
    if (total > MAX_TOTAL_BYTES) throw new Error(`${zipName} unpacks to more than 200 MB`);
    files.push({ name, data, bytes: data.length });
  }
  if (!files.length) throw new Error(`${zipName} has no files in it`);
  return files;
}
