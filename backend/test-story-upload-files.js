// Regression test for "Upload My Own Voice" file selection (frontend/
// app.js's appendStoryUploadedFiles/removeStoryUploadedFileAt, used by the
// story-voice-upload 'change' handler and the per-file "Remove" buttons):
// picking files via "Choose Files" more than once must ADD to the
// previously selected list, not replace it — a native <input type="file">
// always replaces its own .files on every pick, which is exactly the bug
// this fixes. These two functions hold the real, DOM-free logic (append,
// remove-one-without-clearing-the-rest); app.js exports them for Node (see
// its own top-of-file comment) precisely so this is testable without a
// browser/DOM. Run with:
//   node test-story-upload-files.js
// or:
//   npm run test:story-upload-files

const assert = require('assert');
const path = require('path');

const { appendStoryUploadedFiles, removeStoryUploadedFileAt } = require(path.join('..', 'frontend', 'app.js'));

let failures = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failures++;
    console.error(`FAIL - ${name}`);
    console.error(`       ${error.message}`);
  }
}

function fakeFile(name) {
  return { name, size: 1024 * 1024 };
}

test('appendStoryUploadedFiles adds a single newly-picked file to an empty list', () => {
  const result = appendStoryUploadedFiles([], [fakeFile('a.mp3')]);
  assert.deepStrictEqual(result.map((f) => f.name), ['a.mp3']);
});

test('appendStoryUploadedFiles ADDS a later one-at-a-time pick to the existing list, never replacing it', () => {
  const afterFirstPick = appendStoryUploadedFiles([], [fakeFile('a.mp3')]);
  const afterSecondPick = appendStoryUploadedFiles(afterFirstPick, [fakeFile('b.mp3')]);
  assert.deepStrictEqual(
    afterSecondPick.map((f) => f.name),
    ['a.mp3', 'b.mp3'],
    'the second pick must be appended after the first, not replace it'
  );
});

test('appendStoryUploadedFiles supports selecting multiple files at once, in the order given', () => {
  const result = appendStoryUploadedFiles([], [fakeFile('a.mp3'), fakeFile('b.mp3'), fakeFile('c.mp3')]);
  assert.deepStrictEqual(result.map((f) => f.name), ['a.mp3', 'b.mp3', 'c.mp3']);
});

test('appendStoryUploadedFiles supports mixing one-by-one picks and multi-file picks, preserving overall selection order', () => {
  let files = [];
  files = appendStoryUploadedFiles(files, [fakeFile('a.mp3')]); // one at a time
  files = appendStoryUploadedFiles(files, [fakeFile('b.mp3'), fakeFile('c.mp3')]); // two at once
  files = appendStoryUploadedFiles(files, [fakeFile('d.mp3')]); // one at a time again
  assert.deepStrictEqual(files.map((f) => f.name), ['a.mp3', 'b.mp3', 'c.mp3', 'd.mp3']);
});

test('appendStoryUploadedFiles never mutates the existing array it was given', () => {
  const existing = [fakeFile('a.mp3')];
  const existingSnapshot = existing.slice();
  appendStoryUploadedFiles(existing, [fakeFile('b.mp3')]);
  assert.deepStrictEqual(existing, existingSnapshot, 'the caller\'s existing list must be left untouched');
});

test('removeStoryUploadedFileAt removes exactly the targeted file, leaving every other file (and their order) intact', () => {
  const files = [fakeFile('a.mp3'), fakeFile('b.mp3'), fakeFile('c.mp3')];
  const result = removeStoryUploadedFileAt(files, 1); // remove b.mp3
  assert.deepStrictEqual(result.map((f) => f.name), ['a.mp3', 'c.mp3']);
});

test('removeStoryUploadedFileAt removing the first file keeps the rest in their original relative order', () => {
  const files = [fakeFile('a.mp3'), fakeFile('b.mp3'), fakeFile('c.mp3')];
  const result = removeStoryUploadedFileAt(files, 0);
  assert.deepStrictEqual(result.map((f) => f.name), ['b.mp3', 'c.mp3']);
});

test('removeStoryUploadedFileAt removing the last file keeps the earlier ones untouched', () => {
  const files = [fakeFile('a.mp3'), fakeFile('b.mp3'), fakeFile('c.mp3')];
  const result = removeStoryUploadedFileAt(files, 2);
  assert.deepStrictEqual(result.map((f) => f.name), ['a.mp3', 'b.mp3']);
});

test('removeStoryUploadedFileAt never mutates the existing array it was given', () => {
  const existing = [fakeFile('a.mp3'), fakeFile('b.mp3')];
  const existingSnapshot = existing.slice();
  removeStoryUploadedFileAt(existing, 0);
  assert.deepStrictEqual(existing, existingSnapshot, 'the caller\'s existing list must be left untouched');
});

test('a remove followed by picking a new file keeps every remaining file, in order, plus the new one at the end', () => {
  let files = appendStoryUploadedFiles([], [fakeFile('a.mp3'), fakeFile('b.mp3'), fakeFile('c.mp3')]);
  files = removeStoryUploadedFileAt(files, 1); // remove b.mp3 only
  files = appendStoryUploadedFiles(files, [fakeFile('d.mp3')]); // pick one more
  assert.deepStrictEqual(files.map((f) => f.name), ['a.mp3', 'c.mp3', 'd.mp3']);
});

if (failures > 0) {
  console.error(`\n${failures} test(s) failed.`);
  process.exitCode = 1;
} else {
  console.log('\nAll story-upload-files tests passed.');
}
