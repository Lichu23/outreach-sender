import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEmails } from '../lib/parse-emails.js';

test('splits every common separator', () => {
  const { valid } = parseEmails('a@x.com, b@x.com; c@x.com\nd@x.com\te@x.com f@x.com');
  assert.deepEqual(valid, ['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com', 'e@x.com', 'f@x.com']);
});

test('handles names, angle brackets, mailto and uppercase', () => {
  const { valid, invalid } = parseEmails('Juan Perez <Juan@Cafe.com>, mailto:ana@cafe.com.ar');
  assert.deepEqual(valid, ['juan@cafe.com', 'ana@cafe.com.ar']);
  assert.deepEqual(invalid, []);
});

test('reads a row pasted from the leads table', () => {
  const { valid } = parseEmails('| 2 | Sablé Paris | Rosario | info@sableparis.com \\* | - | - |');
  assert.deepEqual(valid, ['info@sableparis.com']);
});

test('removes duplicates and trailing punctuation', () => {
  const { valid, duplicates } = parseEmails('a@x.com. A@x.com a@x.com');
  assert.deepEqual(valid, ['a@x.com']);
  assert.deepEqual(duplicates, ['a@x.com']);
});

test('reports addresses that are broken', () => {
  const { valid, invalid } = parseEmails('good@x.com bad@ @nope.com juan.gmail.com a@b');
  assert.deepEqual(valid, ['good@x.com']);
  assert.deepEqual(invalid, ['bad@', '@nope.com', 'juan.gmail.com', 'a@b']);
});

test('copes with empty and non-string input', () => {
  assert.deepEqual(parseEmails('').valid, []);
  assert.deepEqual(parseEmails(undefined).valid, []);
  assert.deepEqual(parseEmails(42).valid, []);
});
