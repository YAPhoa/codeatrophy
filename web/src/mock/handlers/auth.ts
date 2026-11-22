// Sign-in endpoints. By default the mock runs as a server with sign-in
// turned off; under `auth: 'on'` one account, `MOCK_ACCOUNT`, is signed in
// and can sign out, sign in again, change its password, list and end its
// sessions and keep MCP tokens.

import type { AuthSession, BrowserSession, McpToken, McpTokenCreated } from '../../api/types';
import type { MockDb, StoredMcpToken } from '../db';
import { MOCK_ACCOUNT } from '../db';
import type { Handler, Req } from '../http';
import { HttpError, badRequest, conflict, created, invalid, noContent, notFound, objectBody, ok } from '../http';
import { uuid } from '../util';

const MIN_PASSWORD_CHARS = 8;
const MAX_PASSWORD_BYTES = 72;
const MAX_MCP_TOKENS = 20;
const MAX_MCP_TOKEN_NAME = 60;

const offline = () => badRequest('sign-in is turned off on this server');
const unauthorized = () => new HttpError(401, 'unauthorized', 'sign in to continue');

function session(db: MockDb): AuthSession {
  if (db.options.auth !== 'on') return { enabled: false, setupRequired: false, user: null };
  const user = db.account.signedIn ? { id: 'mock-account', email: MOCK_ACCOUNT.email, createdAt: db.account.createdAt } : null;
  return { enabled: true, setupRequired: false, user };
}

/** Refuses a request unless sign-in is on and the account is signed in. */
function signedIn(db: MockDb): void {
  if (db.options.auth !== 'on' || !db.account.signedIn) throw unauthorized();
}

function login(db: MockDb, req: Req) {
  if (db.options.auth !== 'on') throw offline();
  const body = objectBody(req);
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (email !== MOCK_ACCOUNT.email || body.password !== db.account.password) throw new HttpError(401, 'unauthorized', 'the email or password is incorrect');
  db.account.signedIn = true;
  const now = db.now();
  db.account.sessions.unshift({ id: uuid().replace(/-/g, '').slice(0, 16), browser: 'Firefox on Linux', createdAt: now, lastUsedAt: now, current: true });
  return ok(session(db));
}

/** Signs this browser out, ending its session. */
function signOut(db: MockDb) {
  db.account.signedIn = false;
  db.account.sessions = db.account.sessions.filter((s) => !s.current);
}

function listSessions(db: MockDb) {
  signedIn(db);
  const now = db.now();
  const items: BrowserSession[] = db.account.sessions
    .map((s) => ({ ...s, lastUsedAt: s.current ? now : s.lastUsedAt }))
    .sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
  return ok({ items });
}

function endSession(db: MockDb, req: Req) {
  signedIn(db);
  const s = db.account.sessions.find((x) => x.id === req.params.id);
  if (!s) throw notFound('session');
  if (s.current) signOut(db);
  else db.account.sessions = db.account.sessions.filter((x) => x !== s);
  return noContent();
}

function endOtherSessions(db: MockDb) {
  signedIn(db);
  db.account.sessions = db.account.sessions.filter((s) => s.current);
  return noContent();
}

function changePassword(db: MockDb, req: Req) {
  signedIn(db);
  // The session is enough: a `currentPassword` from an older client is ignored.
  const pw = objectBody(req).newPassword;
  const text = typeof pw === 'string' ? pw : '';
  if ([...text].length < MIN_PASSWORD_CHARS) throw invalid('newPassword', `must be at least ${MIN_PASSWORD_CHARS} characters`);
  if (new TextEncoder().encode(text).length > MAX_PASSWORD_BYTES) throw invalid('newPassword', `must be at most ${MAX_PASSWORD_BYTES} bytes`);
  db.account.password = text;
  db.account.sessions = db.account.sessions.filter((s) => s.current);
  return noContent();
}

const publicToken = ({ id, name, hint, createdAt, lastUsedAt }: StoredMcpToken): McpToken => ({ id, name, hint, createdAt, lastUsedAt });

const TOKEN_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function createToken(db: MockDb, req: Req) {
  signedIn(db);
  const raw = objectBody(req).name;
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (name === '') throw invalid('name', 'is required');
  if ([...name].length > MAX_MCP_TOKEN_NAME) throw invalid('name', `must be at most ${MAX_MCP_TOKEN_NAME} characters`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F\u2028\u2029]/.test(name)) throw invalid('name', 'must be a single line');
  if (db.account.mcpTokens.length >= MAX_MCP_TOKENS) throw conflict(`an account may hold at most ${MAX_MCP_TOKENS} MCP tokens; revoke one first`);
  const token = `cat_${Array.from({ length: 43 }, () => TOKEN_CHARS[Math.floor(Math.random() * TOKEN_CHARS.length)]).join('')}`;
  const stored: StoredMcpToken = { id: uuid().replace(/-/g, '').slice(0, 16), name, hint: token.slice(-4), token, createdAt: db.now(), lastUsedAt: null };
  db.account.mcpTokens.unshift(stored);
  const out: McpTokenCreated = { ...publicToken(stored), token };
  return created(out);
}

function revokeToken(db: MockDb, req: Req) {
  signedIn(db);
  const i = db.account.mcpTokens.findIndex((t) => t.id === req.params.id);
  if (i < 0) throw notFound('MCP token');
  db.account.mcpTokens.splice(i, 1);
  return noContent();
}

export function authRoutes(db: MockDb): [string, string, Handler][] {
  return [
    ['GET', '/auth/session', () => ok(session(db))],
    ['POST', '/auth/login', (req) => login(db, req)],
    ['POST', '/auth/setup', () => Promise.reject(db.options.auth === 'on' ? conflict('an account already exists') : offline())],
    [
      'POST',
      '/auth/logout',
      () => {
        signOut(db);
        return noContent();
      },
    ],
    ['POST', '/auth/password', (req) => changePassword(db, req)],
    ['GET', '/auth/sessions', () => listSessions(db)],
    ['DELETE', '/auth/sessions/:id', (req) => endSession(db, req)],
    ['POST', '/auth/sessions/end-others', () => endOtherSessions(db)],
    [
      'GET',
      '/auth/mcp-tokens',
      () => {
        signedIn(db);
        return ok({ items: db.account.mcpTokens.map(publicToken) });
      },
    ],
    ['POST', '/auth/mcp-tokens', (req) => createToken(db, req)],
    ['DELETE', '/auth/mcp-tokens/:id', (req) => revokeToken(db, req)],
  ];
}
