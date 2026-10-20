import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDatabase } from './database.ts';
import { startCloud } from '../src/server.ts';

const database = { skip: !process.env.OPENFILM_TEST_DATABASE_URL && 'Set OPENFILM_TEST_DATABASE_URL for real PostgreSQL integration tests.' };

test('a registered user can sign in and see their personal cloud space', database, async () => {
  const db = await testDatabase();
  const cloud = await startCloud({ databaseUrl: db.url, port: 0 });
  try {
    const registration = await fetch(`${cloud.origin}/v1/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'a-long-test-password' }),
    });
    assert.equal(registration.status, 201);
    const { token, user } = await registration.json();
    assert.equal(user.username, 'alice');
    assert.ok(token);
    const space = await fetch(`${cloud.origin}/v1/space`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(space.status, 200);
    assert.deepEqual(await space.json(), { ownerId: user.id, quotaBytes: 10_000_000_000, usedBytes: 0, reservedBytes: 0 });
    const login = await fetch(`${cloud.origin}/v1/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'a-long-test-password' }),
    });
    assert.equal(login.status, 200);
    assert.equal((await login.json()).user.id, user.id);
  } finally { await cloud.close(); await db.close(); }
});

test('accounts remain private across service restart and signing out revokes the session', database, async () => {
  const db = await testDatabase();
  let cloud = await startCloud({ databaseUrl: db.url, port: 0 });
  const ask = (path: string, token?: string, body?: object) => fetch(`${cloud.origin}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  try {
    const alice = await (await ask('/v1/auth/register', undefined, { username: 'alice', password: 'alice-password-long' })).json();
    const bob = await (await ask('/v1/auth/register', undefined, { username: 'bob', password: 'bob-password-long' })).json();
    assert.notEqual(alice.user.id, bob.user.id);
    assert.equal((await ask('/v1/space')).status, 401);
    assert.equal((await ask('/v1/me', 'not-a-session')).status, 401);
    const own = await (await ask(`/v1/space?ownerId=${bob.user.id}`, alice.token)).json();
    assert.equal(own.ownerId, alice.user.id, 'an owner supplied by the caller cannot select another space');
    assert.equal((await ask(`/v1/users/${bob.user.id}/space`, alice.token)).status, 404);
    assert.equal((await ask('/v1/auth/login', undefined, { username: 'alice', password: 'wrong-password-long' })).status, 401);
    await cloud.close();
    cloud = await startCloud({ databaseUrl: db.url, port: 0 });
    assert.equal((await (await ask('/v1/me', alice.token)).json()).id, alice.user.id);
    const logout = await ask('/v1/auth/logout', alice.token, {});
    assert.equal(logout.status, 200);
    assert.equal((await ask('/v1/space', alice.token)).status, 401);
    assert.equal((await ask('/v1/space', bob.token)).status, 200);
  } finally { await cloud.close(); await db.close(); }
});

test('registration reports duplicate usernames and invalid input without exposing service details', database, async () => {
  const db = await testDatabase();
  const cloud = await startCloud({ databaseUrl: db.url, port: 0 });
  const register = (body: unknown) => fetch(`${cloud.origin}/v1/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    assert.equal((await register({ username: 'Alice', password: 'alice-password-long' })).status, 201);
    const duplicate = await register({ username: 'alice', password: 'different-password-long' });
    assert.equal(duplicate.status, 409);
    assert.deepEqual(await duplicate.json(), { error: 'That username is already registered.' });
    for (const body of [null, {}, { username: '../alice', password: 'alice-password-long' }, { username: 'alice', password: 'short' }]) {
      assert.equal((await register(body)).status, 400);
    }
    assert.equal((await register({ username: 'another', password: 'x'.repeat(5000) })).status, 413);
  } finally { await cloud.close(); await db.close(); }
});

test('repeated sign-in attempts are throttled without blocking cloud health', database, async () => {
  const db = await testDatabase();
  const cloud = await startCloud({ databaseUrl: db.url, port: 0 });
  try {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const response = await fetch(`${cloud.origin}/v1/auth/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      assert.equal(response.status, 400);
    }
    const refused = await fetch(`${cloud.origin}/v1/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(refused.status, 429);
    assert.ok(Number(refused.headers.get('retry-after')) > 0);
    assert.equal((await fetch(`${cloud.origin}/health`)).status, 200);
  } finally { await cloud.close(); await db.close(); }
});
