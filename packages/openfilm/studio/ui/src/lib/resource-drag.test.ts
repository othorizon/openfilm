import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clearResourceDrag, peekResourceDrag, readResourceDragData, setResourceDragData, RESOURCE_DRAG_TYPE } from './resource-drag.ts';

test('cloud drag keeps account identity but never serializes signed preview URLs', () => {
  const values = new Map<string, string>();
  const transfer = { setData: (key: string, value: string) => { values.set(key, value); }, getData: (key: string) => values.get(key) ?? '' };
  const cloud = { id: '1e25df64-c78b-45e2-b33f-5ee0b00d1611', accountId: 'alice', serviceUrl: 'https://cloud.example.com' };
  const file = { path: `cloud/${cloud.id}/clip.mp4`, name: 'clip.mp4', kind: 'video' as const, cloud, cloudPreviewUrl: 'https://oss.example.com/private?signature=secret' };
  setResourceDragData(transfer, file);
  assert.deepEqual(readResourceDragData(transfer)?.cloud, cloud);
  assert.deepEqual(peekResourceDrag()?.cloud, cloud);
  assert.ok(!values.get(RESOURCE_DRAG_TYPE)?.includes('signature'));
  clearResourceDrag(); assert.equal(peekResourceDrag(), null);
  values.set(RESOURCE_DRAG_TYPE, JSON.stringify({ ...file, cloud: { ...cloud, id: 'bad' } }));
  assert.equal(readResourceDragData(transfer), null);
});
