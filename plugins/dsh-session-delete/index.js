/** Host half: exposes session management RPC methods for client */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const inject = ['sessionPersistence', 'sessions'];

export function apply(ctx) {
  const sessionsDir = path.join(os.homedir(), '.dsh', 'sessions');

  /**
   * Permanently delete a local session from local disk storage.
   * Called from client via host.call('deleteSession', { sessionId })
   */
  async function deleteSession({ sessionId } = {}) {
    if (!sessionId || typeof sessionId !== 'string') {
      throw new Error('Invalid session id');
    }

    let deletedPath = null;

    // Try to get storage path from persistence snapshot first
    try {
      const snapshot = await ctx.sessionPersistence.stat(sessionId);
      if (snapshot?.location?.path) {
        deletedPath = snapshot.location.path;
      }
    } catch {
      // fall through to manual directory scan
    }

    // Fallback: scan workspace-named directories for matching session folder
    // Session folders are named "session-<uuid>" inside directories named after workspace paths
    if (!deletedPath) {
      try {
        const entries = await fs.readdir(sessionsDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const candidate = path.join(sessionsDir, entry.name, `session-${sessionId}`);
          try {
            const stat = await fs.stat(candidate);
            if (stat.isDirectory()) {
              deletedPath = candidate;
              break;
            }
          } catch {
            // session not in this workspace directory, continue scanning
          }
        }
      } catch (err) {
        ctx.logger?.warn?.('session-delete: failed to scan sessions directory:', err.message);
      }
    }

    // Delete the persisted session directory if found
    if (deletedPath) {
      await fs.rm(deletedPath, { recursive: true, force: true });
    }

    // Notify all subscribers that the session was removed so UI lists refresh
    ctx.emit('api-session/removed', sessionId);

    return { ok: true, deletedPath };
  }

  /**
   * Rewind session to a specific message, replacing it with edited content
   * and discarding all messages after it.
   * Called from client via host.call('rewindSessionToMessage', { sessionId, messageId, newContent })
   */
  async function rewindSessionToMessage({ sessionId, messageId, newContent } = {}) {
    if (!sessionId || typeof sessionId !== 'string') {
      throw new Error('Invalid session id');
    }
    if (!messageId || typeof messageId !== 'string') {
      throw new Error('Invalid message id');
    }
    if (typeof newContent !== 'string') {
      throw new Error('Invalid message content');
    }

    // Get session storage path
    let sessionPath = null;
    try {
      const snapshot = await ctx.sessionPersistence.stat(sessionId);
      if (snapshot?.location?.path) {
        sessionPath = snapshot.location.path;
      }
    } catch {
      // fall through to manual scan
    }

    if (!sessionPath) {
      try {
        const entries = await fs.readdir(sessionsDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const candidate = path.join(sessionsDir, entry.name, `session-${sessionId}`);
          try {
            const stat = await fs.stat(candidate);
            if (stat.isDirectory()) {
              sessionPath = candidate;
              break;
            }
          } catch {
            continue;
          }
        }
      } catch (err) {
        ctx.logger?.warn?.('session-delete: failed to scan sessions directory:', err.message);
      }
    }

    if (!sessionPath) {
      throw new Error('Session not found in storage');
    }

    // Read session log file (messages are stored in log.jsonl or similar)
    const logPath = path.join(sessionPath, 'log.jsonl');
    let logContent;
    try {
      logContent = await fs.readFile(logPath, 'utf8');
    } catch (err) {
      throw new Error(`Failed to read session log: ${err.message}`);
    }

    // Parse lines and find the target message
    const lines = logContent.split('\n').filter(line => line.trim());
    const events = lines.map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    }).filter(Boolean);

    // Find index of target message
    let targetIndex = -1;
    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      // Look for user message events
      if (event?.type === 'event' && event?.event?.type === 'user/message') {
        const msgId = event.event.data?.id || event.event.data?.messageId;
        if (msgId === messageId) {
          targetIndex = i;
          break;
        }
      }
    }

    if (targetIndex === -1) {
      throw new Error('Target message not found in session log');
    }

    // Modify the target message content
    const targetEvent = events[targetIndex];
    if (targetEvent?.event?.data?.content) {
      // Replace content - handle both string and array content formats
      if (typeof targetEvent.event.data.content === 'string') {
        targetEvent.event.data.content = newContent;
      } else if (Array.isArray(targetEvent.event.data.content)) {
        // Find text part and replace
        for (const part of targetEvent.event.data.content) {
          if (part?.type === 'text') {
            part.text = newContent;
            break;
          }
        }
      }
    }

    // Keep only events up to and including the target message, discard all after
    const truncatedEvents = events.slice(0, targetIndex + 1);

    // Write back the truncated log
    const newLogContent = truncatedEvents.map(e => JSON.stringify(e)).join('\n') + '\n';
    
    // Backup original log first
    const backupPath = path.join(sessionPath, `log.backup.${Date.now()}.jsonl`);
    await fs.writeFile(backupPath, logContent, 'utf8');
    
    // Write new log
    await fs.writeFile(logPath, newLogContent, 'utf8');

    // If this is the active session, trigger a reload/refresh
    const currentSessionId = ctx.sessions?.activeSessionId;
    if (currentSessionId === sessionId) {
      // Emit event to notify UI that session was modified
      ctx.emit('api-session/modified', sessionId, {
        type: 'rewind',
        messageId,
        truncatedAt: targetEvent.event.seq
      });
      
      // Reload the session from disk
      try {
        await ctx.sessions.resume(sessionId, { force: true });
      } catch (err) {
        ctx.logger?.warn?.('session-delete: failed to resume session after rewind:', err.message);
      }
    }

    return { 
      ok: true, 
      sessionPath,
      backupPath,
      messagesKept: truncatedEvents.length,
      messagesDiscarded: events.length - truncatedEvents.length
    };
  }

  // Expose methods for client-side host.call
  return {
    deleteSession,
    rewindSessionToMessage,
  };
}
