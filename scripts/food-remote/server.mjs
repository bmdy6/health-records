// Private remote MCP adapter. Food rules and storage remain in the existing shared service.
import express from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { authorizationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import { clientRegistrationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/register.js';
import { tokenHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/token.js';
import { revocationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/revoke.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { foodModule } from '../food-agent.mjs';
import { agentRedirect, createFoodOAuth } from './oauth.mjs';
import { consentPage } from './consent.mjs';
import { registerFoodTools } from './food-tools.mjs';
const digest = value => createHash('sha256').update(value).digest();

const PROFILES = {
  food: { name: 'health-records', resourceName: 'Health Records', service: 'health-records-mcp',
    scopes: ['food:read', 'food:write', 'health:read', 'health:write'],
    origins: ['https://chatgpt.com', 'https://claude.ai', 'https://claude.com'],
    oauth: { validRedirect: agentRedirect, clientName: 'AI client' },
    consent: { client: '这个 AI 客户端', disconnect: '你可以随时在该客户端里断开连接。', grouped: true } },
};

export async function createFoodRemote({ publicBase, stateDir, config, fetchImpl = fetch, profile: profileName = 'food' }) {
  const profile = PROFILES[profileName];
  if (!profile) throw new Error('Unknown MCP profile.');
  const base = new URL(publicBase);
  if (base.href.replace(/\/$/, '') !== publicBase || base.search || base.hash || base.username || base.password || !/^\/[\w/-]+$/.test(base.pathname) ||
    (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(base.hostname)))) throw new Error('Invalid public MCP base URL.');
  const prefix = base.pathname, resource = publicBase + '/mcp';
  const { createFoodStore } = await foodModule(); const store = createFoodStore(config, fetchImpl);
  const auth = await createFoodOAuth({ ...profile.oauth, scopesAllowed: profile.scopes, stateDir, resource, ownerBinding: new URL(config.url).href.replace(/\/$/, '') + '\0' + config.username, verifyOwner: async identity => {
    if (!identity || typeof identity.username !== 'string' || typeof identity.password !== 'string' || identity.username.length > 200 || identity.password.length > 4000) return false;
    const userMatch = timingSafeEqual(digest(identity.username), digest(config.username));
    const passwordMatch = timingSafeEqual(digest(identity.password), digest(config.password));
    return userMatch && passwordMatch;
  } });
  const app = express(); app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
    if (req.headers.host !== base.host) return res.status(421).json({ error: 'Unexpected host.' });
    if (req.headers.origin && ![base.origin, ...profile.origins].includes(req.headers.origin)) return res.status(403).json({ error: 'Origin rejected.' });
    next();
  });
  app.use(express.json({ limit: '64kb' }));
  const metadata = { issuer: publicBase, authorization_endpoint: publicBase + '/authorize', token_endpoint: publicBase + '/token',
    registration_endpoint: publicBase + '/register', revocation_endpoint: publicBase + '/revoke', response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'], token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'], scopes_supported: profile.scopes };
  const discovery = '/.well-known/oauth-authorization-server' + prefix;
  const protectedMetadata = '/.well-known/oauth-protected-resource' + prefix + '/mcp';
  for (const endpoint of [discovery, prefix + '/.well-known/oauth-authorization-server']) app.get(endpoint, (_req, res) => res.set('Access-Control-Allow-Origin', '*').json(metadata));
  app.get(protectedMetadata, (_req, res) => res.set('Access-Control-Allow-Origin', '*').json({ resource, authorization_servers: [publicBase], scopes_supported: metadata.scopes_supported, resource_name: profile.resourceName }));
  app.use(prefix + '/register', clientRegistrationHandler({ clientsStore: auth.provider.clientsStore }));
  app.use(prefix + '/token', tokenHandler({ provider: auth.provider }));
  app.use(prefix + '/revoke', revocationHandler({ provider: auth.provider }));
  app.use(prefix + '/authorize', (_req, res, next) => {
    res.renderConsent = (ticket, scopes) => {
      const page = consentPage(ticket, scopes, prefix, config.url, profile.consent);
      res.set('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${page.nonce}'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`);
      res.type('html').send(page.html);
    }; next();
  }, authorizationHandler({ provider: auth.provider }));
  // One owner; bounded aggregate attempts also work behind a loopback reverse proxy.
  let windowStart = Date.now(), confirmations = 0;
  app.post(prefix + '/confirm', async (req, res) => {
    if (req.headers.origin !== base.origin) return res.status(403).json({ error: 'Origin rejected.' });
    if (Date.now() - windowStart > 60000) { windowStart = Date.now(); confirmations = 0; }
    if (++confirmations > 10) return res.status(429).json({ error: 'Try again later.' });
    if (typeof req.body?.ticket !== 'string' || !/^[\w-]{43}$/.test(req.body.ticket) || typeof req.body.allow !== 'boolean') return res.status(400).json({ error: 'Invalid consent.' });
    try { const redirect = await auth.confirm(req.body.ticket, req.body, req.body.allow); res.json({ redirect }); }
    catch { res.status(403).json({ error: 'Connection not authorized.' }); }
  });
  const bearer = requireBearerAuth({ verifier: auth.provider, requiredScopes: [], expectedResource: new URL(resource), resourceMetadataUrl: new URL(protectedMetadata, base).href });
  let active = 0;
  app.post(prefix + '/mcp', bearer, async (req, res) => {
    if (active >= 16) return res.status(429).json({ error: 'Food service busy.' });
    active++; let released = false;
    const server = new McpServer({ name: profile.name, version: '1.0.0' }, profile.instructions ? { instructions: profile.instructions } : undefined);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.once('close', () => { if (!released) { released = true; active--; } void server.close().catch(() => {}); });
    const register = (name, description, inputSchema, write, run) => server.registerTool(name, { description, inputSchema,
      annotations: { readOnlyHint: !write, destructiveHint: false, idempotentHint: true, openWorldHint: false } }, async args => {
      try { const value = await run(args); const payload = { ok: true, ...value };
        return { isError: false, content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
      } catch (error) {
        const known = ['input', 'auth', 'network', 'http', 'data', 'conflict', 'version', 'uncertain', 'not_found', 'active_task'].includes(error.code);
        const payload = { ok: false, error: { code: known ? error.code : 'runtime', message: known ? error.message : 'Operation failed.', write_may_have_succeeded: error.uncertain === true } };
        return { isError: true, content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
      }
    });
    await registerFoodTools(register, store, req.auth.scopes, config, fetchImpl);
    try { await server.connect(transport); await transport.handleRequest(req, res, req.body); }
    catch { if (!res.headersSent) res.status(500).json({ error: 'MCP request failed.' }); }
  });
  app.all(prefix + '/mcp', bearer, (_req, res) => res.status(405).end());
  app.get(prefix + '/health', (_req, res) => res.json({ service: profile.service, status: 'ready' }));
  app.use((_req, res) => res.status(404).json({ error: 'Not found.' }));
  app.use((error, _req, res, _next) => { if (!res.headersSent) res.status(error.type === 'entity.too.large' ? 413 : 400).json({ error: 'Request rejected.' }); });
  return { app, close: () => auth.close() };
}
export async function main() {
  if (process.argv.slice(2).length === 1 && process.argv[2] === '--help') {
    console.log('Remote food MCP: inject HEALTH_MCP_PUBLIC_BASE, HEALTH_MCP_STATE_DIR, HEALTH_WEBDAV_URL, HEALTH_WEBDAV_USER, HEALTH_WEBDAV_PASSWORD. Bind loopback HEALTH_MCP_PORT (default 18725). No dotenv or credentials in arguments.'); return;
  }
  let service;
  try {
    service = await createFoodRemote({ publicBase: process.env.HEALTH_MCP_PUBLIC_BASE, stateDir: process.env.HEALTH_MCP_STATE_DIR, profile: process.env.HEALTH_MCP_PROFILE ?? 'food',
      config: { url: process.env.HEALTH_WEBDAV_URL, username: process.env.HEALTH_WEBDAV_USER, password: process.env.HEALTH_WEBDAV_PASSWORD } });
    const port = Number(process.env.HEALTH_MCP_PORT ?? 18725);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid port.');
    const listener = createServer(service.app); listener.listen(port, '127.0.0.1');
    listener.on('error', async () => { console.error('Food MCP listener failed.'); await service.close(); process.exitCode = 1; });
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { listener.close(async () => { await service.close(); }); listener.closeAllConnections(); });
  } catch { if (service) await service.close(); console.error('Food MCP configuration unavailable.'); process.exitCode = 1; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
