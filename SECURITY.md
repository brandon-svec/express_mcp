# Security Policy

## Reporting a Vulnerability

If you discover a security issue in this package, please report it privately rather than opening a public GitHub issue.

Email the maintainer via the contact listed on the [GitHub profile](https://github.com/brandon-svec) for `brandon-svec/express_mcp`, and include:

- A description of the issue and its impact
- Steps to reproduce (or a proof of concept)
- Affected versions if known

We will acknowledge reports as soon as practical and coordinate a fix and disclosure timeline.

## Scope

This library provides Express **routers** for MCP and optional OAuth. Host applications own TLS, CORS, body size limits, rate limiting, and Origin/Host checks.

## Host Security Responsibilities

This package mounts routers on **your** Express app. It does not configure CORS, body size limits, rate limiting, Origin/Host checks, or TLS. For internet-facing deployments:

- Prefer `auth.enabled: true` with an `allowedUsers` allowlist (see [docs/AUTH.md](docs/AUTH.md)).
- Set body limits on the host (`express.json({ limit: '...' })`) and add rate limiting (e.g. `express-rate-limit`) on MCP and OAuth routes.
- Configure CORS explicitly if browsers call your endpoints; do not default to `Access-Control-Allow-Origin: *` for authenticated MCP.
- Validate `Origin` / `Host` when MCP is reachable from browsers (DNS-rebinding guidance in the MCP HTTP transport).
- Terminate TLS at your reverse proxy or load balancer.

When auth is disabled, the library logs a startup warning: the MCP surface is unauthenticated.
