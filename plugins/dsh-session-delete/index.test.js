import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { apply, inject, name } from './index.js';

async function createRoot(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'dsh-session-delete-'));
  t.after(async () => {
    await fs.chmod(root, 0o700).catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

async function createStorage(t, {
  sessionId = 'session-test',
  projectName = '--project--',
  logName = 'session.v4.jsonl.zstd',
  root,
} = {}) {
  const base = root ?? await createRoot(t);
  const projectDirectory = path.join(base, projectName);
  const sessionDirectory = path.join(projectDirectory, sessionId);
  const logPath = path.join(sessionDirectory, logName);

  await fs.mkdir(sessionDirectory, { recursive: true });
  await fs.writeFile(logPath, '{"type":"session"}\n');
  await fs.writeFile(path.join(sessionDirectory, 'extra.bin'), 'session-local artifact');

  return {
    root: base,
    projectDirectory,
    sessionDirectory,
    logPath,
  };
}

function snapshot(sessionId, logPath) {
  return {
    header: {
      version: 4,
      id: sessionId,
      createdAt: 1,
      isSeeded: false,
      delegationDepth: 0,
      cwd: '/project',
    },
    formatStatus: 'current',
    revision: 'revision-1',
    sizeBytes: 18,
    ...(logPath === undefined ? {} : {
      location: { kind: 'jsonl', path: logPath },
    }),
  };
}

function createContext({
  sessionId = 'session-test',
  snapshots,
  session,
  withAgent = false,
  flush,
  rejection,
} = {}) {
  const routes = new Map();
  const disposers = [];
  const calls = {
    stat: [],
    sessionsGet: [],
    agentsGet: [],
    flush: [],
    cancel: [],
    idle: 0,
    emit: [],
    order: [],
  };

  const liveSession = session ?? (withAgent ? { id: sessionId } : undefined);
  const agent = withAgent
    ? {
        session: liveSession,
        cancel(cause) {
          calls.cancel.push(cause);
          calls.order.push('cancel');
        },
        async whenIdle() {
          calls.idle += 1;
          calls.order.push('idle:start');
          await Promise.resolve();
          calls.order.push('idle:end');
        },
      }
    : undefined;

  const ctx = {
    connection: {
      requestRejection() {
        return rejection;
      },
    },
    sessionPersistence: {
      async stat(id) {
        calls.stat.push(id);
        if (typeof snapshots === 'function') return snapshots(id, calls.stat.length);
        if (Array.isArray(snapshots)) return snapshots[calls.stat.length - 1];
        return snapshots;
      },
    },
    sessions: {
      get(id) {
        calls.sessionsGet.push(id);
        return liveSession;
      },
      async flush(value) {
        calls.flush.push(value);
        calls.order.push('flush');
        return typeof flush === 'function' ? flush(value, calls) : true;
      },
    },
    agents: {
      get(id) {
        calls.agentsGet.push(id);
        return agent;
      },
    },
    webServer: {
      register(route) {
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      },
    },
    effect(factory) {
      const dispose = factory();
      disposers.push(dispose);
      return dispose;
    },
    emit(...args) {
      calls.emit.push(args);
    },
    logger: {
      warn() {},
      error() {},
    },
  };

  function response() {
    return {
      status: 0,
      headers: {},
      body: '',
      writeHead(status, headers = {}) {
        this.status = status;
        this.headers = headers;
      },
      end(body = '') {
        this.body = String(body);
      },
    };
  }

  async function request(method, url, body) {
    const route = routes.get('/session-delete');
    assert.ok(route, 'the Host half must register its channel');
    const req = Readable.from(body === undefined ? [] : [Buffer.from(body)]);
    req.method = method;
    req.url = url;
    const res = response();
    await route.handler(req, res);
    return res;
  }

  async function post(endpoint, payload) {
    const body = payload === undefined ? '' : JSON.stringify(payload);
    const res = await request('POST', `/session-delete/${endpoint}`, body);
    if (res.status !== 200) return { status: res.status, ok: false, raw: res.body };
    return { status: res.status, ...JSON.parse(res.body) };
  }

  return {
    ctx,
    calls,
    routes,
    request,
    post,
    disposeAll() {
      for (const dispose of disposers.splice(0).reverse()) dispose();
    },
  };
}

test('exports only the permanent-delete Host capability', () => {
  assert.equal(name, 'dsh-permanent-session-delete');
  assert.deepEqual(inject, [
    'connection',
    'sessionPersistence',
    'webServer',
    'sessions',
    'agents',
  ]);
});

test('registers one route and disposes it', () => {
  const fake = createContext({ snapshots: undefined });
  apply(fake.ctx);
  assert.deepEqual([...fake.routes.keys()], ['/session-delete']);
  fake.disposeAll();
  assert.equal(fake.routes.size, 0);
});

test('deletes a verified session directory and notifies listeners', async (t) => {
  const sessionId = 'session-123';
  const storage = await createStorage(t, { sessionId });
  const fake = createContext({
    sessionId,
    snapshots: snapshot(sessionId, storage.logPath),
  });
  apply(fake.ctx);

  const result = await fake.post('deleteSession', { sessionId });

  assert.deepEqual(result, {
    status: 200,
    ok: true,
    value: { sessionId, deleted: true },
  });
  await assert.rejects(fs.lstat(storage.sessionDirectory), { code: 'ENOENT' });
  assert.equal((await fs.stat(storage.projectDirectory)).isDirectory(), true);
  assert.equal(fake.calls.stat.length, 2);
  assert.deepEqual(fake.calls.emit, [['api-session/removed', sessionId]]);
});

test('deletes plain and compressed canonical session log generations', async (t) => {
  for (const logName of ['session.jsonl', 'session.jsonl.zstd', 'session.v7.jsonl']) {
    const sessionId = `session-${logName.replaceAll('.', '-')}`;
    const storage = await createStorage(t, { sessionId, logName });
    const fake = createContext({
      sessionId,
      snapshots: snapshot(sessionId, storage.logPath),
    });
    apply(fake.ctx);

    const result = await fake.post('deleteSession', { sessionId });

    assert.equal(result.ok, true, logName);
    await assert.rejects(fs.lstat(storage.sessionDirectory), { code: 'ENOENT' });
  }
});

test('cancels the Agent, waits for idle, and flushes before deleting', async (t) => {
  const sessionId = 'session-running';
  const storage = await createStorage(t, { sessionId });
  const liveSession = { id: sessionId };
  const fake = createContext({
    sessionId,
    session: liveSession,
    withAgent: true,
    snapshots: snapshot(sessionId, storage.logPath),
  });
  apply(fake.ctx);

  const result = await fake.post('deleteSession', { sessionId });

  assert.equal(result.ok, true);
  assert.deepEqual(fake.calls.cancel, [{ kind: 'user' }]);
  assert.equal(fake.calls.idle, 1);
  assert.deepEqual(fake.calls.flush, [liveSession]);
  assert.deepEqual(fake.calls.order, ['cancel', 'idle:start', 'idle:end', 'flush']);
  await assert.rejects(fs.lstat(storage.sessionDirectory), { code: 'ENOENT' });
});

test('flushes a pending Session so it can materialize before deletion', async (t) => {
  const sessionId = 'session-pending';
  const storage = await createStorage(t, { sessionId });
  const durable = snapshot(sessionId, storage.logPath);
  const fake = createContext({
    sessionId,
    session: { id: sessionId },
    snapshots(_id, count) {
      return count === 1 ? snapshot(sessionId) : durable;
    },
  });
  apply(fake.ctx);

  const result = await fake.post('deleteSession', { sessionId });

  assert.equal(result.ok, true);
  assert.equal(fake.calls.stat.length, 2);
  assert.equal(fake.calls.flush.length, 1);
  assert.deepEqual(fake.calls.order, ['flush']);
  await assert.rejects(fs.lstat(storage.sessionDirectory), { code: 'ENOENT' });
});

test('refuses a non-canonical log filename without deleting the directory', async (t) => {
  const sessionId = 'session-bad-name';
  const storage = await createStorage(t, {
    sessionId,
    logName: 'session.v0.jsonl',
  });
  const fake = createContext({
    sessionId,
    snapshots: snapshot(sessionId, storage.logPath),
  });
  apply(fake.ctx);

  const result = await fake.post('deleteSession', { sessionId });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'UNSAFE_SESSION_PATH');
  assert.equal((await fs.stat(storage.sessionDirectory)).isDirectory(), true);
  assert.deepEqual(fake.calls.emit, []);
});

test('refuses a snapshot whose header names another Session', async (t) => {
  const sessionId = 'session-requested';
  const storage = await createStorage(t, { sessionId });
  const wrong = snapshot('session-other', storage.logPath);
  const fake = createContext({ sessionId, snapshots: wrong });
  apply(fake.ctx);

  const result = await fake.post('deleteSession', { sessionId });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'UNSAFE_SESSION_PATH');
  assert.equal((await fs.stat(storage.sessionDirectory)).isDirectory(), true);
  assert.deepEqual(fake.calls.emit, []);
});

test('refuses a symlinked session directory', async (t) => {
  const root = await createRoot(t);
  const sessionId = 'session-symlink-dir';
  const target = path.join(root, 'target');
  const projectDirectory = path.join(root, '--project--');
  const sessionDirectory = path.join(projectDirectory, sessionId);
  const targetLog = path.join(target, 'session.jsonl');
  await fs.mkdir(target, { recursive: true });
  await fs.mkdir(projectDirectory, { recursive: true });
  await fs.writeFile(targetLog, '{}\n');
  await fs.symlink(target, sessionDirectory, 'dir');

  const fake = createContext({
    sessionId,
    snapshots: snapshot(sessionId, path.join(sessionDirectory, 'session.jsonl')),
  });
  apply(fake.ctx);

  const result = await fake.post('deleteSession', { sessionId });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'UNSAFE_SESSION_PATH');
  assert.equal((await fs.stat(targetLog)).isFile(), true);
  assert.deepEqual(fake.calls.emit, []);
});

test('refuses a symlinked session log', async (t) => {
  const sessionId = 'session-symlink-log';
  const storage = await createStorage(t, { sessionId });
  const target = path.join(storage.root, 'real-log.jsonl');
  await fs.rm(storage.logPath);
  await fs.writeFile(target, '{}\n');
  await fs.symlink(target, storage.logPath);
  const fake = createContext({
    sessionId,
    snapshots: snapshot(sessionId, storage.logPath),
  });
  apply(fake.ctx);

  const result = await fake.post('deleteSession', { sessionId });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'UNSAFE_SESSION_PATH');
  assert.equal((await fs.stat(target)).isFile(), true);
  assert.equal((await fs.stat(storage.sessionDirectory)).isDirectory(), true);
  assert.deepEqual(fake.calls.emit, []);
});

test('refuses a symlinked project directory', async (t) => {
  const root = await createRoot(t);
  const sessionId = 'session-symlink-project';
  const target = path.join(root, 'target');
  const projectDirectory = path.join(root, '--project--');
  const sessionDirectory = path.join(target, sessionId);
  const logPath = path.join(sessionDirectory, 'session.jsonl');
  await fs.mkdir(sessionDirectory, { recursive: true });
  await fs.writeFile(logPath, '{}\n');
  await fs.symlink(target, projectDirectory, 'dir');

  const fake = createContext({
    sessionId,
    snapshots: snapshot(sessionId, path.join(projectDirectory, sessionId, 'session.jsonl')),
  });
  apply(fake.ctx);

  const result = await fake.post('deleteSession', { sessionId });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'UNSAFE_SESSION_PATH');
  assert.equal((await fs.stat(sessionDirectory)).isDirectory(), true);
  assert.deepEqual(fake.calls.emit, []);
});

test('does not delete either path when flushing moves the log', async (t) => {
  const sessionId = 'session-moving';
  const first = await createStorage(t, { sessionId, projectName: '--first--' });
  const second = await createStorage(t, {
    sessionId,
    projectName: '--second--',
    root: first.root,
  });
  const fake = createContext({
    sessionId,
    session: { id: sessionId },
    snapshots: [
      snapshot(sessionId, first.logPath),
      snapshot(sessionId, second.logPath),
    ],
  });
  apply(fake.ctx);

  const result = await fake.post('deleteSession', { sessionId });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'UNSAFE_SESSION_PATH');
  assert.equal((await fs.stat(first.sessionDirectory)).isDirectory(), true);
  assert.equal((await fs.stat(second.sessionDirectory)).isDirectory(), true);
  assert.deepEqual(fake.calls.emit, []);
});

test('does not delete a directory when its log disappears after flush', async (t) => {
  const sessionId = 'session-disappearing';
  const storage = await createStorage(t, { sessionId });
  const durable = snapshot(sessionId, storage.logPath);
  const fake = createContext({
    sessionId,
    session: { id: sessionId },
    snapshots: durable,
    async flush() {
      await fs.rm(storage.logPath);
      return true;
    },
  });
  apply(fake.ctx);

  const result = await fake.post('deleteSession', { sessionId });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'SESSION_NOT_FOUND');
  assert.equal((await fs.stat(storage.sessionDirectory)).isDirectory(), true);
  assert.deepEqual(fake.calls.emit, []);
});

test('does not emit removal when filesystem deletion fails', async (t) => {
  const sessionId = 'session-delete-fails';
  const storage = await createStorage(t, { sessionId });
  const fake = createContext({
    sessionId,
    snapshots: snapshot(sessionId, storage.logPath),
  });
  apply(fake.ctx);

  const originalRm = fs.rm;
  fs.rm = async () => {
    const error = new Error('permission denied');
    error.code = 'EACCES';
    throw error;
  };
  let result;
  try {
    result = await fake.post('deleteSession', { sessionId });
  } finally {
    fs.rm = originalRm;
  }

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'DELETE_FAILED');
  assert.equal((await fs.stat(storage.sessionDirectory)).isDirectory(), true);
  assert.deepEqual(fake.calls.emit, []);
});

test('rejects unauthenticated requests before inspecting storage', async () => {
  const fake = createContext({ rejection: 401 });
  apply(fake.ctx);

  const res = await fake.request(
    'POST',
    '/session-delete/deleteSession',
    JSON.stringify({ sessionId: 'session-test' }),
  );

  assert.equal(res.status, 401);
  assert.deepEqual(fake.calls.stat, []);
});

test('accepts only POST and one valid endpoint segment', async () => {
  const fake = createContext({ snapshots: undefined });
  apply(fake.ctx);

  const get = await fake.request('GET', '/session-delete/deleteSession');
  assert.equal(get.status, 405);
  assert.equal(get.headers.allow, 'POST');

  const traversal = await fake.request(
    'POST',
    '/session-delete/../deleteSession',
    '{}',
  );
  assert.equal(traversal.status, 404);

  const deeper = await fake.request('POST', '/session-delete/deleteSession/extra', '{}');
  assert.equal(deeper.status, 404);
});

test('reports malformed payloads and unknown endpoints', async () => {
  const fake = createContext({ snapshots: undefined });
  apply(fake.ctx);

  const malformed = await fake.request('POST', '/session-delete/deleteSession', '{');
  assert.equal(malformed.status, 400);

  const missing = await fake.post('deleteSession', {});
  assert.equal(missing.error.code, 'INVALID_REQUEST');

  const arrayPayload = await fake.post('deleteSession', []);
  assert.equal(arrayPayload.error.code, 'INVALID_REQUEST');

  const unknown = await fake.post('deleteEverything', { sessionId: 'session-test' });
  assert.equal(unknown.error.code, 'UNKNOWN_ENDPOINT');
  assert.deepEqual(fake.calls.stat, []);
});

test('turns an oversized request body into a JSON failure envelope', async () => {
  const fake = createContext({ snapshots: undefined });
  apply(fake.ctx);

  const res = await fake.request(
    'POST',
    '/session-delete/deleteSession',
    'x'.repeat(16 * 1024 + 1),
  );

  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'application/json');
  assert.equal(JSON.parse(res.body).error.code, 'INVALID_REQUEST');
  assert.deepEqual(fake.calls.stat, []);
});

test('reports a session whose persistence row is absent', async () => {
  const fake = createContext({ snapshots: undefined });
  apply(fake.ctx);

  const result = await fake.post('deleteSession', { sessionId: 'session-missing' });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'SESSION_NOT_FOUND');
  assert.deepEqual(fake.calls.emit, []);
});
