import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Gateway proxy behaviour, asserted against the real server.js running as a
// child process in front of stub upstreams.
//
// Why a running gateway rather than a unit test of the callback: the defect
// these tests exist for was that the callback was never invoked at all.
// http-proxy-middleware v3 moved proxy callbacks under `on`, and
// createProxyMiddleware ignores unrecognised top-level options silently -- no
// warning, no error. A test asserting that `removeHeader` appears in the
// source, or calling the callback directly, passes against the broken build.
// Only observing what an upstream actually receives can catch it.

const HERE = path.dirname(fileURLToPath(import.meta.url));

// The value a leaked token would have. Generated per run; never a committed
// literal.
const INTERNAL_TOKEN = 'f'.repeat(64);

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

const listen = (server, port) =>
  new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

const close = (server) => new Promise((resolve) => server.close(resolve));

// Records what each proxied request actually arrived with.
const received = [];

// Stand-in for user-service: enforces the same internal-token rule and keeps a
// profile store, so "was the forged profile created?" is answerable here.
const profiles = new Map();

const makeUpstream = (name) =>
  http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({
        upstream: name,
        method: req.method,
        path: req.url,
        internalToken: req.headers['x-internal-token'] ?? null,
        authorization: req.headers.authorization ?? null,
      });

      const json = (code, payload) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      if (req.url === '/sync-user' && req.method === 'POST') {
        if (req.headers['x-internal-token'] !== INTERNAL_TOKEN) {
          return json(401, { message: 'Unauthorized' });
        }
        const parsed = body ? JSON.parse(body) : {};
        profiles.set(parsed._id, parsed);
        return json(201, { message: 'User synced successfully' });
      }

      const byId = req.url.match(/^\/([0-9a-f]{24})$/);
      if (byId && req.method === 'GET') {
        return profiles.has(byId[1])
          ? json(200, profiles.get(byId[1]))
          : json(404, { message: 'User not found' });
      }

      if (req.url === '/me' && req.method === 'GET') {
        if (!req.headers.authorization) {
          return json(401, { message: 'No token provided' });
        }
        return json(200, { _id: 'a'.repeat(24), seenAuthorization: req.headers.authorization });
      }

      if (req.url === '/register' && req.method === 'POST') {
        return json(201, { message: 'User registered successfully', userId: 'b'.repeat(24) });
      }

      json(404, { message: 'not found' });
    });
  });

const spawnGateway = (env) =>
  spawn(process.execPath, ['server.js'], {
    cwd: HERE,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

const waitForHealth = async (port, ms = 20000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`gateway on ${port} did not start`);
    await new Promise((r) => setTimeout(r, 150));
  }
};

let gateway;
let gatewayPort;
let userUpstream;
let authUpstream;
let deadPort;

const request = async (method, pathname, { headers = {}, body } = {}) => {
  const res = await fetch(`http://127.0.0.1:${gatewayPort}${pathname}`, {
    method,
    headers: body ? { 'content-type': 'application/json', ...headers } : headers,
    body,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON body is itself something a test may assert on */
  }
  return { status: res.status, text, json };
};

before(async () => {
  const userPort = await freePort();
  const authPort = await freePort();
  gatewayPort = await freePort();
  // Nothing ever listens here, so proxying to it exercises the error handler.
  deadPort = await freePort();

  userUpstream = makeUpstream('user-service');
  authUpstream = makeUpstream('auth-service');
  await listen(userUpstream, userPort);
  await listen(authUpstream, authPort);

  gateway = spawnGateway({
    PORT: String(gatewayPort),
    AUTH_SERVICE_URL: `http://127.0.0.1:${authPort}`,
    USER_SERVICE_URL: `http://127.0.0.1:${userPort}`,
    POST_SERVICE_URL: `http://127.0.0.1:${deadPort}`,
  });
  await waitForHealth(gatewayPort);
});

after(async () => {
  gateway?.kill('SIGKILL');
  await close(userUpstream);
  await close(authUpstream);
});

describe('gateway strips the internal service token', () => {
  // The header authenticates auth-service -> user-service calls made directly
  // across the Docker network. If the gateway forwards a client-supplied one,
  // a leaked token becomes replayable from the public internet against an
  // endpoint that accepts _id, email and a pre-hashed password.
  const forgedId = 'c'.repeat(24);

  it('does not forward a valid token, so the client cannot authenticate', async () => {
    const res = await request('POST', '/api/users/sync-user', {
      headers: { 'x-internal-token': INTERNAL_TOKEN },
      body: JSON.stringify({ _id: forgedId, email: 'forged@example.test' }),
    });

    assert.equal(res.status, 401, 'a client-supplied internal token must not authenticate');
    assert.deepEqual(res.json, { message: 'Unauthorized' });
  });

  it('the header is absent when the request reaches the upstream', async () => {
    const hit = received.findLast((r) => r.path === '/sync-user');
    assert.ok(hit, 'the request should still reach the upstream');
    assert.equal(hit.internalToken, null, 'x-internal-token must not be forwarded');
  });

  it('no profile was created by the attempt', async () => {
    assert.equal(profiles.has(forgedId), false, 'the forged profile must not exist');
    const res = await request('GET', `/api/users/${forgedId}`, {
      headers: { authorization: 'Bearer legitimate-user-token' },
    });
    assert.equal(res.status, 404);
  });

  for (const header of ['X-Internal-Token', 'X-INTERNAL-TOKEN', 'x-InTeRnAl-ToKeN']) {
    it(`strips the header spelled "${header}"`, async () => {
      await request('POST', '/api/users/sync-user', {
        headers: { [header]: INTERNAL_TOKEN },
        body: JSON.stringify({ _id: 'd'.repeat(24) }),
      });
      const hit = received.at(-1);
      assert.equal(hit.internalToken, null);
    });
  }

  it('strips a duplicated header', async () => {
    // fetch() joins repeats with ", "; send it raw to be certain.
    const raw = await new Promise((resolve) => {
      const req = http.request(
        { host: '127.0.0.1', port: gatewayPort, method: 'POST', path: '/api/users/sync-user' },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        },
      );
      req.setHeader('x-internal-token', [INTERNAL_TOKEN, INTERNAL_TOKEN]);
      req.end('{}');
    });
    assert.equal(raw, 401);
    assert.equal(received.at(-1).internalToken, null);
  });

  it('strips it on the auth route too', async () => {
    await request('POST', '/api/auth/register', {
      headers: { 'x-internal-token': INTERNAL_TOKEN },
      body: JSON.stringify({ email: 'x@example.test' }),
    });
    const hit = received.at(-1);
    assert.equal(hit.upstream, 'auth-service');
    assert.equal(hit.internalToken, null);
  });
});

describe('legitimate traffic is unaffected', () => {
  it('forwards the Authorization header', async () => {
    const res = await request('GET', '/api/users/me', {
      headers: { authorization: 'Bearer a-real-user-token' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.seenAuthorization, 'Bearer a-real-user-token');
    assert.equal(received.at(-1).authorization, 'Bearer a-real-user-token');
  });

  it('registration still reaches auth-service and succeeds', async () => {
    const res = await request('POST', '/api/auth/register', {
      body: JSON.stringify({ email: 'new@example.test' }),
    });
    assert.equal(res.status, 201);
    assert.equal(res.json.message, 'User registered successfully');
  });

  it('strips the /api/<service> prefix when forwarding', async () => {
    await request('POST', '/api/auth/register', { body: '{}' });
    assert.equal(received.at(-1).path, '/register');
    await request('GET', '/api/users/me', { headers: { authorization: 'Bearer t' } });
    assert.equal(received.at(-1).path, '/me');
  });

  it('serves its own health endpoint', async () => {
    const res = await request('GET', '/health');
    assert.equal(res.status, 200);
    assert.equal(res.json.service, 'api-gateway');
  });

  it('still 404s an unknown route', async () => {
    const res = await request('GET', '/not-a-route');
    assert.equal(res.status, 404);
    assert.equal(res.json.message, 'Route not found');
  });
});

// The error callback was registered the same dead way as the header removal,
// so it never ran either: a downed service produced the library's default
// plain-text 504 naming the host and URL. These assertions fail against that.
describe('the proxy error handler is actually registered', () => {
  it('returns a JSON 503 when the upstream is unreachable', async () => {
    const res = await request('GET', '/api/posts/');
    assert.equal(res.status, 503);
    assert.deepEqual(res.json, { message: 'Service temporarily unavailable' });
  });

  it('does not leak the upstream host or port in the response', async () => {
    const res = await request('GET', '/api/posts/');
    assert.doesNotMatch(res.text, /ECONNREFUSED/);
    assert.doesNotMatch(res.text, new RegExp(String(deadPort)));
    assert.doesNotMatch(res.text, /127\.0\.0\.1/);
  });
});

// A hung upstream -- one that accepts the connection and never answers -- is a
// different failure from a refused connection, and the two options that look
// like they cover it do not behave the same way.
//
// http-proxy applies `timeout` to the incoming client socket and registers no
// handler, so when it fires the connection is dropped with no HTTP response.
// `proxyTimeout` aborts the outgoing request, which reaches the error handler
// and produces the documented 503. The gateway shipped only `timeout`, so a
// hung upstream returned an empty reply after 30 seconds.
//
// This runs its own gateway with PROXY_TIMEOUT_MS set low, so the assertion
// costs about a second rather than half a minute.
describe('a hung upstream yields the documented 503, not a dropped connection', () => {
  const PROXY_TIMEOUT_MS = 1000;
  let hung;
  let slowGateway;
  let slowPort;

  before(async () => {
    const hungPort = await freePort();
    slowPort = await freePort();

    // Accepts the request, reads it, and never responds.
    hung = http.createServer((req) => req.resume());
    await listen(hung, hungPort);

    slowGateway = spawnGateway({
      PORT: String(slowPort),
      AUTH_SERVICE_URL: `http://127.0.0.1:${hungPort}`,
      USER_SERVICE_URL: `http://127.0.0.1:${hungPort}`,
      POST_SERVICE_URL: `http://127.0.0.1:${hungPort}`,
      PROXY_TIMEOUT_MS: String(PROXY_TIMEOUT_MS),
    });
    await waitForHealth(slowPort);
  });

  after(async () => {
    slowGateway?.kill('SIGKILL');
    await close(hung);
  });

  it('responds 503 rather than dropping the connection', async () => {
    const started = Date.now();
    const res = await fetch(`http://127.0.0.1:${slowPort}/api/posts/`);
    const elapsed = Date.now() - started;
    const body = await res.json();

    assert.equal(res.status, 503, 'a hung upstream must produce a response, not an empty reply');
    assert.deepEqual(body, { message: 'Service temporarily unavailable' });
    assert.ok(
      elapsed >= PROXY_TIMEOUT_MS - 200,
      `should wait for the proxy timeout, waited ${elapsed}ms`,
    );
  });

  it('gives up near the proxy timeout, not the client timeout', async () => {
    // The client backstop is PROXY_TIMEOUT_MS + 5000. Landing well inside that
    // proves proxyTimeout won the race -- with the two equal, the socket drop
    // wins and there is no response at all.
    const started = Date.now();
    const res = await fetch(`http://127.0.0.1:${slowPort}/api/users/me`, {
      headers: { authorization: 'Bearer t' },
    });
    const elapsed = Date.now() - started;

    assert.equal(res.status, 503);
    assert.ok(elapsed < PROXY_TIMEOUT_MS + 2000, `took ${elapsed}ms, expected near ${PROXY_TIMEOUT_MS}ms`);
  });
});
