import express from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import dotenv from "dotenv";
import cors from "cors";
import rateLimit from "express-rate-limit";

dotenv.config();

const app = express();
app.set('trust proxy', 1); // Trust first proxy
app.use(cors());

// Strip the internal service token from every inbound request, before any
// route or proxy can see it.
//
// INTERNAL_SERVICE_TOKEN authenticates the auth-service -> user-service call
// made directly across the Docker network during registration; it never
// legitimately travels through this gateway. A client presenting one is
// confused or probing, and must not have it forwarded: POST /sync-user accepts
// a whole profile -- _id, email and a pre-hashed password -- so a leaked token
// that survived this hop would be replayable from the public internet.
//
// Done once here rather than inside each proxy's options so that a route added
// later cannot silently reopen the hole. That is exactly how it was open
// before: the removal lived only in a per-route callback that never ran (see
// the note on `on` below).
const INTERNAL_TOKEN_HEADER = 'x-internal-token';
app.use((req, _res, next) => {
  // Node lowercases inbound header names, but sweep case-insensitively so this
  // does not depend on that detail.
  for (const name of Object.keys(req.headers)) {
    if (name.toLowerCase() === INTERNAL_TOKEN_HEADER) {
      delete req.headers[name];
    }
  }
  next();
});

// Global rate limiter
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { message: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api', globalLimiter);

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "healthy", service: "api-gateway" });
});

// Service health aggregator
app.get("/api/health/all", async (req, res) => {
  const services = {
    gateway: "healthy",
    auth: "unknown",
    user: "unknown",
    post: "unknown"
  };

  try {
    const authHealth = await fetch(`${process.env.AUTH_SERVICE_URL}/health`);
    services.auth = authHealth.ok ? "healthy" : "unhealthy";
  } catch { services.auth = "down"; }

  try {
    const userHealth = await fetch(`${process.env.USER_SERVICE_URL}/health`);
    services.user = userHealth.ok ? "healthy" : "unhealthy";
  } catch { services.user = "down"; }

  try {
    const postHealth = await fetch(`${process.env.POST_SERVICE_URL}/health`);
    services.post = postHealth.ok ? "healthy" : "unhealthy";
  } catch { services.post = "down"; }

  const allHealthy = Object.values(services).every(s => s === "healthy");
  res.status(allHealthy ? 200 : 503).json({ services, overall: allHealthy ? "healthy" : "degraded" });
});

// Proxy routes
//
// http-proxy-middleware v3 moved every proxy callback under `on`. The old
// top-level `onProxyReq` / `onError` / `logLevel` keys are only honoured by the
// separate `legacyCreateProxyMiddleware` export; `createProxyMiddleware`
// ignores unrecognised options **silently** -- no warning, no error. Anything
// registered the old way simply never runs, which is how the x-internal-token
// removal below came to be dead code.
const proxyOptions = {
  changeOrigin: true,
  pathRewrite: (path, req) => {
    // Remove /api/<service> prefix when forwarding
    // e.g., /api/auth/register -> /register
    return path.replace(/^\/api\/[^\/]+/, '');
  },
  on: {
    proxyReq: (proxyReq, req, res) => {
      // Second, independent removal: the middleware above already deleted the
      // header from req.headers, so this covers the outgoing request even if
      // something re-added it. removeHeader is case-insensitive.
      proxyReq.removeHeader(INTERNAL_TOKEN_HEADER);
      // Forward authorization header
      if (req.headers.authorization) {
        proxyReq.setHeader('authorization', req.headers.authorization);
      }
    },
    error: (err, req, res) => {
      console.error('Proxy Error:', err.message);
      // On a websocket upgrade failure the second argument is a net.Socket,
      // which has no status()/json().
      if (typeof res?.status !== 'function') {
        res?.destroy?.();
        return;
      }
      if (res.headersSent) {
        return;
      }
      // err.message carries the upstream host and port (e.g.
      // "connect ECONNREFUSED 172.18.0.5:3002"). Log it, never return it.
      res.status(503).json({ message: 'Service temporarily unavailable' });
    },
  },
  timeout: 30000
};

// Auth service routes
app.use('/api/auth', createProxyMiddleware({
  ...proxyOptions,
  target: process.env.AUTH_SERVICE_URL
}));

// User service routes
app.use('/api/users', createProxyMiddleware({
  ...proxyOptions,
  target: process.env.USER_SERVICE_URL
}));

// Post service routes
app.use('/api/posts', createProxyMiddleware({
  ...proxyOptions,
  target: process.env.POST_SERVICE_URL
}));

// 404 handler - must be last
app.use((req, res) => {
  res.status(404).json({ 
    message: 'Route not found',
    path: req.originalUrl 
  });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🌐 API Gateway running on port ${PORT}`);
  console.log(`📍 Routes:`);
  console.log(`   - /api/auth/* → ${process.env.AUTH_SERVICE_URL}`);
  console.log(`   - /api/users/* → ${process.env.USER_SERVICE_URL}`);
  console.log(`   - /api/posts/* → ${process.env.POST_SERVICE_URL}`);
});
