import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cloudUploadName } from './cloud-upload-name.mjs';

test('custom cloud names preserve the source media extension', () => {
  assert.equal(cloudUploadName('source.MP4', '  城市夜景  '), '城市夜景.MP4');
  assert.equal(cloudUploadName('source.MP4', '夜景.mp4'), '夜景.mp4');
  assert.equal(cloudUploadName('source.png', 'photo.jpg'), 'photo.jpg.png');
  assert.equal(cloudUploadName('source.wav'), 'source.wav');
});
test('custom cloud names reject paths, control characters and oversized names', () => {
  for (const name of ['', ' ', '../escape', 'folder/file', 'folder\\file', 'x:y', 'a\nb', 'x'.repeat(201), null]) {
    assert.throws(() => cloudUploadName('source.png', name), { status: 400 });
  }
});
