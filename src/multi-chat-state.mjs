import path from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOOL = /^[A-Za-z0-9_][A-Za-z0-9_.:/-]{0,127}$/;
const TOOL_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/;
const EVENTS = new Set([
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'PermissionRequest', 'Stop', 'Interrupt', 'SessionEnd',
]);
const FIELDS = new Set([
  'sessionId', 'project', 'event', 'turnId', 'toolName', 'toolUseId', 'at', 'subagent',
]);
const ACTIVE = new Set(['running', 'tool_running', 'waiting']);
const LIMIT = 16;
const STALE_MS = 5 * 60 * 1000;

function uuid(value) {
  return typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : null;
}

function iso(value) {
  if (typeof value !== 'string') return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value ? value : null;
}

function projectName(value) {
  if (typeof value !== 'string' || !value || /\p{Cc}/u.test(value)) return null;
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '');
  const name = path.posix.basename(normalized);
  return name && name !== '.' && name !== '..' && name.length <= 60 ? name : null;
}

// Hook metadata is locally reported and is not an authenticated source.
export function normalizeHookInput(raw, now = () => new Date()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const sessionId = uuid(raw.session_id);
  const project = projectName(raw.cwd);
  const event = raw.hook_event_name;
  const turnId = raw.turn_id == null ? null : uuid(raw.turn_id);
  const toolName = raw.tool_name == null ? null : raw.tool_name;
  const toolUseId = raw.tool_use_id == null ? null : raw.tool_use_id;
  if (!sessionId || !project || !EVENTS.has(event)) return null;
  if (raw.turn_id != null && !turnId) return null;
  if (event !== 'SessionStart' && event !== 'SessionEnd' && !turnId) return null;
  if (toolName !== null && (typeof toolName !== 'string' || !TOOL.test(toolName))) return null;
  if (toolUseId !== null && (typeof toolUseId !== 'string' || !TOOL_ID.test(toolUseId))) return null;
  const at = now().toISOString();
  return { sessionId, project, event, turnId, toolName, toolUseId, at,
    subagent: raw.agent_id != null && raw.agent_id !== '' };
}

export function validateHookEvent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (Object.keys(value).some((key) => !FIELDS.has(key))) return false;
  if (Object.keys(value).length !== FIELDS.size) return false;
  if (!uuid(value.sessionId) || value.sessionId !== value.sessionId.toLowerCase()) return false;
  if (projectName(value.project) !== value.project || !EVENTS.has(value.event)) return false;
  if (value.turnId !== null && (!uuid(value.turnId) || value.turnId !== value.turnId.toLowerCase())) return false;
  if (value.event !== 'SessionStart' && value.event !== 'SessionEnd' && !value.turnId) return false;
  if (value.toolName !== null && (typeof value.toolName !== 'string' || !TOOL.test(value.toolName))) return false;
  if (value.toolUseId !== null && (typeof value.toolUseId !== 'string' || !TOOL_ID.test(value.toolUseId))) return false;
  return !!iso(value.at) && typeof value.subagent === 'boolean';
}

export function createMultiChatState({ clock = () => new Date() } = {}) {
  const sessions = new Map();
  let displayRequest = 0;
  let full = false;

  function accept(event) {
    if (!validateHookEvent(event)) return false;
    let session = sessions.get(event.sessionId);
    if (!session) {
      if (sessions.size >= LIMIT) {
        const candidates = [...sessions.values()]
          .filter((item) => !ACTIVE.has(item.status))
          .sort((a, b) => a.lastSeen.localeCompare(b.lastSeen));
        if (!candidates.length) {
          full = true;
          return true;
        }
        sessions.delete(candidates[0].sessionId);
      }
      session = {
        sessionId: event.sessionId, project: event.project, status: 'unknown',
        turnId: null, source: 'hook', lastSeen: event.at, toolName: null,
        toolUseId: null, history: [], closedTurns: [], seen: [], returned: [],
        activeTools: [], uncertainTools: false,
      };
      sessions.set(event.sessionId, session);
    } else if (event.at < session.lastSeen) {
      return true;
    }

    const key = JSON.stringify([event.event, event.turnId, event.toolUseId, event.subagent,
      ...(((event.event === 'SessionStart' || event.event === 'SessionEnd') &&
        event.turnId === null && event.toolUseId === null) ||
        (event.event === 'PermissionRequest' && event.toolUseId === null) ? [event.at] : [])]);
    if (session.seen.includes(key)) return true;
    session.seen.push(key);
    if (session.seen.length > 200) session.seen.shift();
    session.lastSeen = event.at;
    session.project = event.project;
    full = false;

    const current = event.turnId && event.turnId === session.turnId;
    const closed = event.turnId && session.closedTurns.includes(event.turnId);
    if (event.event === 'UserPromptSubmit' && !event.subagent && !closed) {
      if (session.turnId && session.turnId !== event.turnId) {
        session.closedTurns.push(session.turnId);
        if (session.closedTurns.length > 64) session.closedTurns.shift();
      }
      session.turnId = event.turnId;
      session.status = 'running';
      session.toolName = null;
      session.toolUseId = null;
      session.returned = [];
      session.activeTools = [];
      session.uncertainTools = false;
    } else if (event.event === 'SessionStart' && !session.turnId && session.status === 'unknown') {
      session.status = 'connected';
    } else if (event.event === 'SessionEnd' && !event.subagent &&
      !ACTIVE.has(session.status) && (event.turnId === null || current)) {
      session.status = 'ended';
    } else if (session.turnId === null && !event.subagent &&
      (event.event === 'PreToolUse' || event.event === 'PostToolUse' || event.event === 'PermissionRequest')) {
      session.toolName = event.toolName;
      session.toolUseId = event.toolUseId;
    } else if (current && !closed && !event.subagent) {
      if (event.event === 'PreToolUse') {
        if (!event.toolUseId || !session.returned.includes(event.toolUseId)) {
          if (!event.toolUseId || session.activeTools.length >= 200) {
            session.uncertainTools = true;
          } else if (!session.activeTools.some((tool) => tool.toolUseId === event.toolUseId)) {
            session.activeTools.push({ toolName: event.toolName, toolUseId: event.toolUseId });
          }
          session.status = 'tool_running';
          session.toolName = event.toolName;
          session.toolUseId = event.toolUseId;
        }
      } else if (event.event === 'PostToolUse') {
        if (event.toolUseId && !session.returned.includes(event.toolUseId)) {
          session.returned.push(event.toolUseId);
          if (session.returned.length > 200) session.returned.shift();
        }
        session.activeTools = session.activeTools.filter((tool) => tool.toolUseId !== event.toolUseId);
        const active = session.activeTools.at(-1);
        if (active) {
          session.status = 'tool_running';
          session.toolName = active.toolName;
          session.toolUseId = active.toolUseId;
        } else if (session.uncertainTools) {
          session.status = 'tool_running';
        } else {
          session.status = 'running';
          session.toolName = event.toolName;
          session.toolUseId = event.toolUseId;
        }
      } else if (event.event === 'PermissionRequest') {
        session.status = 'waiting';
        session.toolName = event.toolName;
        session.toolUseId = event.toolUseId;
      } else if (event.event === 'Stop' || event.event === 'Interrupt') {
        session.status = event.event === 'Stop' ? 'idle' : 'interrupted';
        if (!session.closedTurns.includes(event.turnId)) {
          session.closedTurns.push(event.turnId);
          if (session.closedTurns.length > 64) session.closedTurns.shift();
        }
      }
    }
    session.history.push({
      event: event.event, at: event.at, toolName: event.toolName, toolUseId: event.toolUseId,
    });
    if (session.history.length > 20) session.history.shift();
    return true;
  }

  function snapshot() {
    const now = clock();
    const items = [...sessions.values()].map(({ closedTurns, seen, returned, activeTools, uncertainTools, ...session }) => ({
      ...session,
      status: ACTIVE.has(session.status) && now.getTime() - Date.parse(session.lastSeen) >= STALE_MS
        ? 'unknown' : session.status,
    }));
    return structuredClone({
      kind: 'multi_chat', version: 1, generatedAt: now.toISOString(), displayRequest,
      sessions: items, capacity: { maxSessions: LIMIT, full },
    });
  }

  return { accept, snapshot, display() { displayRequest += 1; } };
}
