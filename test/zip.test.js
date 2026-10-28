// Code uploads unpack .zip files the way Gradescope's web uploader does.
// Archives are built here with fflate, so there are no binary fixtures.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { expandZip } from '../src/gradescope/zip.js';
import { checkFiles } from '../src/gradescope/write.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minerva-zip-test-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

function writeZip(name, entries) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, zipSync(entries));
  return p;
}

test('expandZip keeps paths and skips folders and macOS junk', () => {
  const bytes = zipSync({
    'src/': new Uint8Array(0),
    'src/main.py': strToU8('print(1)'),
    'src/util/helpers.py': strToU8('x = 2'),
    'README.md': strToU8('# hi'),
    '__MACOSX/src/._main.py': strToU8('junk'),
    'src/.DS_Store': strToU8('junk'),
  });
  const files = expandZip(bytes, 'cw.zip');
  assert.deepEqual(files.map((f) => f.name).sort(), ['README.md', 'src/main.py', 'src/util/helpers.py']);
  assert.equal(new TextDecoder().decode(files.find((f) => f.name === 'src/main.py').data), 'print(1)');
});

test('expandZip rejects unsafe paths, empty archives and non-zips', () => {
  assert.throws(() => expandZip(zipSync({ '../evil.py': strToU8('x') }), 'bad.zip'), /unsafe path/);
  assert.throws(() => expandZip(zipSync({ 'only/': new Uint8Array(0) }), 'empty.zip'), /no files/);
  assert.throws(() => expandZip(strToU8('not a zip at all'), 'fake.zip'), /Could not read fake\.zip/);
});

test('code uploads unpack zips and keep other files as they are', () => {
  const zip = writeZip('cw1-submission.zip', { 'cw1/main.cpp': strToU8('int main(){}'), 'cw1/shader.glsl': strToU8('void main(){}') });
  const extra = path.join(dir, 'report.txt');
  fs.writeFileSync(extra, 'notes');
  const files = checkFiles('code', [zip, extra]);
  assert.deepEqual(
    files.map((f) => [f.name, f.from ?? null]),
    [
      ['cw1/main.cpp', 'cw1-submission.zip'],
      ['cw1/shader.glsl', 'cw1-submission.zip'],
      ['report.txt', null],
    ],
  );
});

test('--keep-zip uploads the archive itself, and PDFs are never unpacked', () => {
  const zip = writeZip('keep.zip', { 'a.py': strToU8('1') });
  assert.deepEqual(
    checkFiles('code', [zip], { unzip: false }).map((f) => f.name),
    ['keep.zip'],
  );
  assert.throws(() => checkFiles('fixed_length', [zip]), /exactly one PDF/);
});

test('two files that would upload under the same name are refused', () => {
  const zip = writeZip('dup.zip', { 'main.py': strToU8('from zip') });
  const loose = path.join(dir, 'main.py');
  fs.writeFileSync(loose, 'loose file');
  assert.throws(() => checkFiles('code', [zip, loose]), /both upload as "main\.py"/);
});
