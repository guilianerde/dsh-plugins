/**
 * Host half of the permanent session-delete command.
 *
 * DSH has no public Session-dispose API. This plugin therefore cancels the
 * live Agent, waits for its final writes, flushes the Session, and then removes
 * only the verified JSONL log's own session directory.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

export const name = 'dsh-permanent-session-delete';

export const inject = [
  'connection',
  'sessionPersistence',
  'storageDomain',
  'webServer',
  'sessions',
  'agents',
];

const CHANNEL = '/session-delete';
const ENDPOINT = /^[A-Za-z0-9_$.-]+$/;
const LOG_FILENAME = /^session(?:\.v[1-9][0-9]*)?\.jsonl(?:\.zstd)?$/u;
const PROJECT_DIRECTORY = /^--.+--$/u;
const MAX_BODY_BYTES = 16 * 1024;
const PROJECTION_CACHE_DOMAIN = 'session_projcache';

class DeleteError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DeleteError';
    this.code = code;
  }
}

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const failure = (code, message) => ({ ok: false, error: { code, message } });
const success = (value) => ({ ok: true, value });

/**
 * Match the JSONL backend's injective Session-id path encoding.
 *
 * Checking the final directory name binds the trusted persistence location to
 * the requested Session id instead of merely trusting the path's filename.
 */
function encodeSegment(value) {
  if (value === '.') return '~002E';
  if (value === '..') return '~002E~002E';

  let encoded = '';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const character = String.fromCharCode(code);
    encoded += character !== '~' && /^[A-Za-z0-9._-]$/.test(character)
      ? character
      : `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return encoded;
}

function requireSessionId(payload) {
  if (!isRecord(payload) || typeof payload.sessionId !== 'string' || payload.sessionId === '') {
    throw new DeleteError('INVALID_REQUEST', 'The request is missing a non-empty "sessionId".');
  }
  return payload.sessionId;
}

/**
 * Validate the persistence observation and derive the one directory that may
 * be removed. A pending Session may legitimately have no location until its
 * first flush, in which case this returns undefined.
 */
function sessionStorage(sessionId, snapshot) {
  if (!isRecord(snapshot) || !isRecord(snapshot.header) || snapshot.header.id !== sessionId) {
    throw new DeleteError(
      'UNSAFE_SESSION_PATH',
      'The stored session identity does not match the requested session.',
    );
  }

  const location = snapshot.location;
  if (location === undefined) return undefined;
  if (
    !isRecord(location)
    || location.kind !== 'jsonl'
    || typeof location.path !== 'string'
    || location.path.includes('\0')
    || !path.isAbsolute(location.path)
  ) {
    throw new DeleteError('UNSAFE_SESSION_PATH', 'The stored session path is not a safe JSONL path.');
  }

  const logPath = path.resolve(location.path);
  const filename = path.basename(logPath);
  const sessionDirectory = path.dirname(logPath);
  const projectDirectory = path.dirname(sessionDirectory);
  const projectName = path.basename(projectDirectory);

  if (
    logPath !== location.path
    || !LOG_FILENAME.test(filename)
    || path.basename(sessionDirectory) !== encodeSegment(sessionId)
    || sessionDirectory === path.parse(sessionDirectory).root
    || (projectName !== '_no-cwd' && !PROJECT_DIRECTORY.test(projectName))
  ) {
    throw new DeleteError('UNSAFE_SESSION_PATH', 'The stored session path is not a safe session directory.');
  }

  return { logPath, sessionDirectory };
}

async function readPayload(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new DeleteError('INVALID_REQUEST', 'The request body is too large.');
    }
    chunks.push(chunk);
  }

  const body = Buffer.concat(chunks).toString('utf8');
  if (body === '') return {};

  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function writeJson(res, status, value) {
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(value));
}

export function apply(ctx) {
  async function readSessionSnapshot(sessionId) {
    try {
      return await ctx.sessionPersistence.stat(sessionId);
    } catch (error) {
      if (error instanceof DeleteError) throw error;
      throw new DeleteError('DELETE_FAILED', 'The session storage could not be inspected.');
    }
  }

  async function discardProjectionCache(sessionId) {
    const domain = ctx.storageDomain?.get?.(PROJECTION_CACHE_DOMAIN);
    const table = domain?.table?.('sessions');
    if (typeof table?.delete !== 'function') return;

    try {
      await table.delete(sessionId);
    } catch (error) {
      // The log is authoritative. A stale cache write is harmless, but must not
      // prevent the sidebar from dropping a session whose log is already gone.
      ctx.logger?.warn?.('session-delete: failed to discard projection-cache row', error);
    }
  }

  async function announceRemoval(sessionId) {
    await discardProjectionCache(sessionId);
    ctx.emit('api-session/removed', sessionId);
    return { sessionId, deleted: true };
  }

  async function assertSafeFiles(storage) {
    let project;
    try {
      project = await fs.lstat(path.dirname(storage.sessionDirectory));
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new DeleteError('SESSION_NOT_FOUND', 'The session storage no longer exists.');
      }
      throw new DeleteError('DELETE_FAILED', 'The session directory could not be inspected.');
    }
    if (project.isSymbolicLink() || !project.isDirectory()) {
      throw new DeleteError('UNSAFE_SESSION_PATH', 'The session project directory is not a real directory.');
    }

    let directory;
    try {
      directory = await fs.lstat(storage.sessionDirectory);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new DeleteError('SESSION_NOT_FOUND', 'The session storage no longer exists.');
      }
      throw new DeleteError('DELETE_FAILED', 'The session directory could not be inspected.');
    }
    if (directory.isSymbolicLink() || !directory.isDirectory()) {
      throw new DeleteError('UNSAFE_SESSION_PATH', 'The session directory is not a real directory.');
    }

    let log;
    try {
      log = await fs.lstat(storage.logPath);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new DeleteError('SESSION_NOT_FOUND', 'The session log no longer exists.');
      }
      throw new DeleteError('DELETE_FAILED', 'The session log could not be inspected.');
    }
    if (log.isSymbolicLink() || !log.isFile()) {
      throw new DeleteError('UNSAFE_SESSION_PATH', 'The session log is not a regular file.');
    }
  }

  async function deleteSession(payload) {
    const sessionId = requireSessionId(payload);
    const initialSnapshot = await readSessionSnapshot(sessionId);
    const initialStorage = initialSnapshot === undefined
      ? undefined
      : sessionStorage(sessionId, initialSnapshot);

    const session = ctx.sessions.get(sessionId);
    const agent = ctx.agents.get(sessionId);
    if (agent !== undefined && agent.session?.id !== sessionId) {
      throw new DeleteError('UNSAFE_SESSION_PATH', 'The live Agent does not own the requested session.');
    }

    try {
      if (agent !== undefined) {
        agent.cancel({ kind: 'user' });
        await agent.whenIdle();
      }

      const liveSession = ctx.sessions.get(sessionId) ?? session;
      if (liveSession !== undefined) {
        const flushed = await ctx.sessions.flush(liveSession);
        if (flushed === false) {
          throw new DeleteError('DELETE_FAILED', 'The session could not be made durable before deletion.');
        }
      }
    } catch (error) {
      // A resident Session can outlive its deleted log and keep failing on
      // flush. If no durable snapshot reappears, remove its sidebar residue.
      let currentSnapshot;
      try {
        currentSnapshot = await readSessionSnapshot(sessionId);
      } catch {
        currentSnapshot = undefined;
      }
      if (currentSnapshot === undefined) {
        return announceRemoval(sessionId);
      }
      throw error;
    }

    // Flush can materialize a pending Session or move it to a new generation.
    const finalSnapshot = await readSessionSnapshot(sessionId);
    if (finalSnapshot === undefined) {
      return announceRemoval(sessionId);
    }
    const finalStorage = sessionStorage(sessionId, finalSnapshot);
    if (finalStorage === undefined) {
      return announceRemoval(sessionId);
    }
    if (initialStorage !== undefined && initialStorage.logPath !== finalStorage.logPath) {
      throw new DeleteError('UNSAFE_SESSION_PATH', 'The session storage path changed during deletion.');
    }

    try {
      await assertSafeFiles(finalStorage);
    } catch (error) {
      if (error instanceof DeleteError && error.code === 'SESSION_NOT_FOUND') {
        return announceRemoval(sessionId);
      }
      throw error;
    }
    try {
      await fs.rm(finalStorage.sessionDirectory, { recursive: true });
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return announceRemoval(sessionId);
      }
      ctx.logger?.warn?.('session-delete: failed to remove the session directory', error);
      throw new DeleteError('DELETE_FAILED', 'The session directory could not be deleted.');
    }

    return announceRemoval(sessionId);
  }

  async function dispatch(endpoint, payload) {
    if (endpoint !== 'deleteSession') {
      return failure('UNKNOWN_ENDPOINT', `Unknown endpoint ${JSON.stringify(endpoint)}.`);
    }

    try {
      return success(await deleteSession(payload));
    } catch (error) {
      if (error instanceof DeleteError) return failure(error.code, error.message);
      ctx.logger?.error?.('session-delete: unexpected deletion failure', error);
      return failure('DELETE_FAILED', 'The session could not be deleted.');
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: CHANNEL,
    handler: async (req, res) => {
      const rejection = ctx.connection.requestRejection(req);
      if (rejection !== undefined) {
        res.writeHead(rejection);
        res.end();
        return;
      }
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' });
        res.end();
        return;
      }

      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (!pathname.startsWith(`${CHANNEL}/`)) {
        res.writeHead(404);
        res.end();
        return;
      }
      const endpoint = pathname.slice(CHANNEL.length + 1);
      if (!ENDPOINT.test(endpoint)) {
        res.writeHead(404);
        res.end();
        return;
      }

      let payload;
      try {
        payload = await readPayload(req);
      } catch (error) {
        if (!(error instanceof DeleteError)) throw error;
        writeJson(res, 200, failure(error.code, error.message));
        return;
      }
      if (payload === undefined) {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end('body is not JSON');
        return;
      }
      writeJson(res, 200, await dispatch(endpoint, payload));
    },
  }), 'session-delete: permanent delete route');
}
