# MCP OAuth Authentication

Optional GitHub and/or Google SSO for ExpressMcp. Users receive a JWT after login; MCP clients send `Authorization: Bearer <token>` on each request.

## Quick start (plug-and-play)

```javascript
import express from 'express';
import { ExpressMcp } from '@brandon-svec/express_mcp';

const expressMcp = new ExpressMcp({
  name: 'my-service',
  auth: {
    enabled: true,
    baseUrl: 'https://my-host.example.com',
    callbackUrl: 'https://my-host.example.com/mcp/auth/callback',
    jwtSecret: process.env.JWT_SECRET,
    sessionSecret: process.env.SESSION_SECRET,
    jwtExpiresIn: '7d',
    allowedUsers: [],
    providers: {
      google: { clientId: '...', clientSecret: '...' }
    }
  }
});

const app = express();
app.use(express.json());
app.use(expressMcp.httpRouter()); // OAuth + MCP on one router
app.listen(3000);
```

`ExpressMcp` normalizes auth config via `buildAuthOptions()` in the constructor. Pass `baseUrl` and `providers`; the library derives `issuer` and validates required fields.

## Auth config reference

| Field | Required when `enabled: true` | Description |
|-------|-------------------------------|-------------|
| `enabled` | — | `false` disables auth; other fields are not validated |
| `baseUrl` | Yes (unless `issuer` set) | Public origin, no trailing slash; library sets `issuer = baseUrl + resourcePath` |
| `callbackUrl` | Yes | Must match OAuth app redirect URI exactly |
| `jwtSecret` | Yes | Signs MCP Bearer JWTs |
| `sessionSecret` | Yes | express-session secret for OAuth handshake only |
| `jwtExpiresIn` | Yes | JWT lifetime (e.g. `7d`, `1h`) |
| `allowedUsers` | No | Email/login allowlist; omit or `[]` = any authenticated user |
| `providers` | Yes | Map of `github` / `google` with `clientId` + `clientSecret` |
| `resourcePath` | No | Default `/mcp`; mount path for MCP + OAuth metadata |

### Derived values (normally do not set manually)

- `issuer` = `{baseUrl}{resourcePath}` (e.g. `https://host/mcp`)
- Default `callbackUrl` pattern: `{baseUrl}/mcp/auth/callback`

### Single-provider shorthand (backward compatible)

```javascript
auth: {
  enabled: true,
  baseUrl: 'http://localhost:3000',
  callbackUrl: 'http://localhost:3000/mcp/auth/callback',
  jwtSecret: '...',
  sessionSecret: '...',
  jwtExpiresIn: '7d',
  provider: 'github',
  clientId: '...',
  clientSecret: '...'
}
```

## Environment variables

For apps without a config module, use `buildAuthOptionsFromEnv()`:

```javascript
import { buildAuthOptionsFromEnv, ExpressMcp } from '@brandon-svec/express_mcp';

const auth = buildAuthOptionsFromEnv({ baseUrl: 'http://localhost:3000' });
if (auth) {
  const expressMcp = new ExpressMcp({ name: 'my-service', auth });
}
```

| Env var | Maps to |
|---------|---------|
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | `providers.github` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | `providers.google` |
| `JWT_SECRET` | `jwtSecret` |
| `SESSION_SECRET` | `sessionSecret` |
| `JWT_EXPIRES_IN` | `jwtExpiresIn` |
| `BASE_URL` | `baseUrl` |
| `OAUTH_CALLBACK_URL` | `callbackUrl` (optional override) |
| `AUTH_ALLOWED_USERS` | `allowedUsers` (comma-separated) |
| `AUTH_ENABLED=false` | Disables env-based auth |

Copy `examples/.env.example` to `examples/.env` and run `npm run example:auth`.

## OAuth provider setup

1. Register redirect URI: `{baseUrl}/mcp/auth/callback`
2. For Cursor MCP: discovery uses `GET /.well-known/oauth-protected-resource/mcp` and `GET /mcp/.well-known/oauth-authorization-server`
3. Use separate OAuth clients for dev and production when possible

## HTTP routes (when auth enabled)

Mount once with `app.use(expressMcp.httpRouter())`:

| Route | Purpose |
|-------|---------|
| `GET /mcp/auth/login` | Provider picker (or auto-redirect if only one) |
| `GET /mcp/auth/login/github` | GitHub sign-in |
| `GET /mcp/auth/login/google` | Google sign-in |
| `GET /mcp/auth/callback` | OAuth callback; issues JWT |
| `GET /mcp/auth/me` | Current user (Bearer token) |
| `POST /mcp` | MCP JSON-RPC (requires Bearer token) |

Tool handlers receive `context.user` (`sub`, `login`, `email`, `provider`).

## API exports

- `buildAuthOptions(input)` — normalize and validate auth config (also called by constructor)
- `buildAuthOptionsFromEnv(overrides)` — build from `process.env`
- `validateAuthOptions(auth)` — validate only (throws when invalid)
- `isOAuthConfigured()` — check if env has minimum OAuth credentials
