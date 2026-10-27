// Parser tests for files embedded in Ultra document bodies.
// The HTML is hand-written; file names and ids are made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEmbeddedFiles } from '../src/embedded.js';

const bbfile = (meta) => JSON.stringify(meta).replace(/"/g, '&quot;');

test('reads data-bbfile links and images in document order', () => {
  const pdf = 'https://minerva.leeds.ac.uk/bbcswebdav/pid-1-dt-content-rid-2_1/xid-2_1?a=1&amp;b=2';
  const html = `
    <div><a data-bbfile="${bbfile({ displayName: 'Guide.pdf', mimeType: 'application/pdf', resourceUrl: pdf.replace(/&amp;/g, '&') })}" href="${pdf}"></a></div>
    <p><img data-bbfile="${bbfile({ linkName: 'diagram.png', mimeType: 'image/png' })}" src="/bbcswebdav/pid-1-dt-content-rid-3_1/xid-3_1"></p>`;
  assert.deepEqual(parseEmbeddedFiles(html), [
    {
      fileName: 'Guide.pdf',
      mimeType: 'application/pdf',
      url: 'https://minerva.leeds.ac.uk/bbcswebdav/pid-1-dt-content-rid-2_1/xid-2_1?a=1&b=2',
    },
    {
      fileName: 'diagram.png',
      mimeType: 'image/png',
      url: 'https://minerva.leeds.ac.uk/bbcswebdav/pid-1-dt-content-rid-3_1/xid-3_1',
    },
  ]);
});

test('picks up plain links and skips duplicates', () => {
  const html = `
    <a href="/bbcswebdav/courses/TEST/Week%201%20notes.pdf">Week 1 notes</a>
    <a href="/bbcswebdav/courses/TEST/Week%201%20notes.pdf">again</a>
    <a href="/bbcswebdav/courses/TEST/slides.pptx"></a>`;
  assert.deepEqual(
    parseEmbeddedFiles(html).map((f) => f.fileName),
    ['Week 1 notes', 'slides.pptx'],
  );
});

test('ignores other hosts, non-file links and bad JSON', () => {
  const html = `
    <a href="https://evil.example/bbcswebdav/x.pdf">x</a>
    <a href="http://minerva.leeds.ac.uk/bbcswebdav/y.pdf">y</a>
    <a href="https://minerva.leeds.ac.uk/ultra/courses/_1_1/outline">outline</a>
    <a data-bbfile="{not json" href="https://minerva.leeds.ac.uk/bbcswebdav/z.pdf">z</a>`;
  assert.deepEqual(parseEmbeddedFiles(html).map((f) => f.fileName), ['z']);
  assert.deepEqual(parseEmbeddedFiles(''), []);
  assert.deepEqual(parseEmbeddedFiles(undefined), []);
});
