// The full result of the latest Gradescope query, kept in one temporary file
// that the next query overwrites. MCP clients may cut a long tool answer
// short; the agent can read this file to see all of it. Only the current user
// can read it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function lastOutputFile() {
  return path.join(os.tmpdir(), 'minerva-mcp', 'gradescope-last-output.json');
}

/** Writes `record` as JSON, replacing the previous query's file. Returns its path. */
export function saveLastOutput(record) {
  const file = lastOutputFile();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return file;
}
