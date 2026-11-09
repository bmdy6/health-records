// OAuth PKCE + owner consent; SDK handlers perform protocol parsing and client authentication.
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { InvalidClientMetadataError, InvalidGrantError, InvalidScopeError, InvalidTokenError, AccessDeniedError, ServerError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { openOAuthState } from './state.mjs';
const fresh = () => randomBytes(32).toString('base64url');
const hash = text => createHash('sha256').update(text).digest('hex');
const defaultScopes = ['food:read', 'food:write', 'health:read', 'health:write'];
const chatgptRedirect = text => {
  try { const u = new URL(text); return u.protocol === 'https:' && u.host === 'chatgpt.com' && !u.search && !u.hash && !u.username && !u.password &&
    (u.pathname === '/connector_platform_oauth_redirect' || /^\/connector\/oauth\/[\w-]+$/.test(u.pathname)); } catch { return false; }
};
function checkScopes(scopes, allowed) {
  if (!Array.isArray(scopes) || !scopes.length || scopes.length > allowed.length || new Set(scopes).size !== scopes.length || scopes.some(v => !allowed.includes(v))) throw new InvalidScopeError('Unsupported scope.');
  if (scopes.includes('health:write') && !scopes.includes('health:read')) throw new InvalidScopeError('health:write requires explicit health:read.');
  return scopes;
}
// Other AI clients: native-app loopback callbacks (RFC 8252) and Claude's hosted connector.
export const agentRedirect = text => {
  try {
    const u = new URL(text);
    if (u.username || u.password || u.hash) return false;
    if (u.protocol === 'http:') return ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
    return chatgptRedirect(text) || (u.protocol === 'https:' && ['claude.ai', 'claude.com'].includes(u.host) && u.pathname === '/api/mcp/auth_callback' && !u.search);
  } catch { return false; }
};

export async function createFoodOAuth({ stateDir, resource, verifyOwner, ownerBinding = resource, now = () => Math.floor(Date.now() / 1000), scopesAllowed = defaultScopes, fallbackScopes = ['food:read', 'food:write'], validRedirect = chatgptRedirect, clientName = 'ChatGPT' }) {
  const disk = await openOAuthState(stateDir), pending = new Map(), codes = new Map();
  try {
    await disk.mutate(data => {
      const binding = hash(resource + '\0' + ownerBinding);
      if (data.binding && data.binding !== binding) throw new Error('OAuth state belongs to another resource or owner.');
      data.binding = binding;
    });
  } catch (error) { await disk.close(); throw error; }
  function prune() {
    for (const map of [pending, codes]) for (const [key, value] of map) if (value.expiresAt <= now()) map.delete(key);
    if (pending.size + codes.size >= 1000) throw new ServerError('Authorization is busy.');
  }
  function issue(data, clientId, scopes, existing) {
    const access = fresh(), refresh = fresh();
    const grant = existing ?? { id: randomUUID(), clientId, resource, usedRefresh: [] };
    Object.assign(grant, { scopes, access: hash(access), expiresAt: now() + 3600,
      refresh: hash(refresh), refreshExpiresAt: now() + 30 * 86400, revoked: false });
    if (!existing) data.grants.push(grant);
    return { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: 3600, scope: scopes.join(' ') };
  }
  const provider = {
    // Validate PKCE inside exchangeAuthorizationCode as well as all audience bindings.
    skipLocalPkceValidation: true,
    clientsStore: {
      async getClient(id) { const clients = (await disk.read()).clients; return Object.hasOwn(clients, id) ? clients[id] : undefined; },
      async registerClient(input) {
        if (input.token_endpoint_auth_method !== 'none' || !Array.isArray(input.redirect_uris) || !input.redirect_uris.length ||
          input.redirect_uris.length > 5 || input.redirect_uris.some(uri => !validRedirect(uri))) throw new InvalidClientMetadataError('Redirect URI is not allowed.');
        return disk.mutate(data => {
          if (Object.keys(data.clients).length >= 100) throw new ServerError('Client registration limit reached.');
          const client = { client_id: randomUUID(), client_id_issued_at: now(), token_endpoint_auth_method: 'none',
            redirect_uris: input.redirect_uris, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], client_name: clientName };
          data.clients[client.client_id] = client; return client;
        });
      },
    },
    async authorize(client, params, response) {
      prune();
      if (String(params.resource) !== resource || !client.redirect_uris.includes(params.redirectUri) || !/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge)) throw new InvalidGrantError('Invalid authorization binding.');
      const scopes = checkScopes(params.scopes?.length ? params.scopes : fallbackScopes, scopesAllowed);
      const ticket = fresh(); pending.set(hash(ticket), { clientId: client.client_id, ...params, scopes, expiresAt: now() + 300 });
      response.renderConsent(ticket, scopes);
    },
    async challengeForAuthorizationCode(client, code) {
      const entry = codes.get(hash(code));
      if (!entry || entry.clientId !== client.client_id || entry.expiresAt <= now()) throw new InvalidGrantError('Invalid authorization code.');
      return entry.codeChallenge;
    },
    async exchangeAuthorizationCode(client, code, verifier, redirect, audience) {
      const entry = codes.get(hash(code));
      if (!entry || entry.clientId !== client.client_id || entry.expiresAt <= now() || entry.redirectUri !== redirect || String(audience) !== resource ||
        typeof verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || createHash('sha256').update(verifier).digest('base64url') !== entry.codeChallenge) throw new InvalidGrantError('Invalid authorization code or binding.');
      codes.delete(hash(code));
      return disk.mutate(data => {
        data.grants = data.grants.filter(g => g.refreshExpiresAt > now());
        if (data.grants.length >= 100) throw new ServerError('Authorization limit reached.');
        return issue(data, client.client_id, entry.scopes);
      });
    },
    async exchangeRefreshToken(client, token, requested, audience) {
      const digest = hash(token);
      const result = await disk.mutate(data => {
        const g = data.grants.find(item => item.clientId === client.client_id && (item.refresh === digest || item.usedRefresh.includes(digest)));
        if (!g || g.revoked || g.refreshExpiresAt <= now() || String(audience) !== resource) throw new InvalidGrantError('Invalid refresh token or audience.');
        if (g.usedRefresh.includes(digest)) { g.revoked = true; return { reused: true }; }
        const scopes = checkScopes(requested ?? g.scopes, g.scopes);
        if (g.usedRefresh.length >= 100) throw new InvalidGrantError('Reconnect to renew this authorization.');
        g.usedRefresh.push(g.refresh);
        return { tokens: issue(data, client.client_id, scopes, g) };
      });
      if (result.reused) throw new InvalidGrantError('Refresh reuse detected; authorization revoked.');
      return result.tokens;
    },
    async verifyAccessToken(token) {
      const data = await disk.read();
      const g = data.grants.find(item => item.access === hash(token));
      if (!g || g.revoked || g.expiresAt <= now() || g.resource !== resource) throw new InvalidTokenError('Invalid or expired food authorization.');
      return { token, clientId: g.clientId, scopes: g.scopes, expiresAt: g.expiresAt, resource: new URL(resource) };
    },
    async revokeToken(client, request) {
      const digest = hash(request.token);
      await disk.mutate(data => { for (const g of data.grants) if (g.clientId === client.client_id &&
        (g.access === digest || g.refresh === digest || g.usedRefresh.includes(digest))) g.revoked = true; });
    },
  };
  return {
    provider,
    async confirm(ticket, identity, allow) {
      const key = hash(ticket), entry = pending.get(key);
      if (!entry || entry.expiresAt <= now()) throw new AccessDeniedError('Connection request expired.');
      if (allow && !await verifyOwner(identity)) throw new AccessDeniedError('Personal Workbench identity not verified.');
      pending.delete(key);
      const callback = new URL(entry.redirectUri); if (entry.state) callback.searchParams.set('state', entry.state);
      if (!allow) callback.searchParams.set('error', 'access_denied');
      else { const code = fresh(); codes.set(hash(code), entry); callback.searchParams.set('code', code); }
      return callback.href;
    },
    async close() { await disk.close(); },
  };
}
