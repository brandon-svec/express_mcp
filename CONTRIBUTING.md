# Contributing

Thanks for contributing to `@brandon-svec/express_mcp`.

## Development setup

```bash
git clone git@github.com:brandon-svec/express_mcp.git
cd express_mcp
npm install
npm test
npm run lint
```

- Use Node.js 20+ and npm 10+.
- Prefer focused PRs: one concern per change.
- Add or update mocha tests under `tests/unit` or `tests/integration` for behavior changes.
- Do not bump `package.json` version in feature PRs; releases are cut separately.

## Scripts

```bash
# Development
npm run dev                    # Start example with auto-restart
npm run example               # Run example application
npm run example:auth          # Run OAuth SSO example

# Testing
npm test                      # Run unit then integration tests
npm run test:unit            # In-process unit tests (tests/unit)
npm run test:integration     # HTTP/MCP supertest tests (tests/integration)
npm run test:live            # Live Gemini API — intentional; needs tests/live/config.js (see tests/live/README.md)
npm run coverage             # Coverage for full test suite
npm run coverage:unit        # Coverage for unit tests only
npm run coverage:integration # Coverage for integration tests only
npm run test:coverage        # LCOV coverage for full test suite

# Code Quality
npm run lint                  # Run ESLint
npm run lint:fix             # Fix auto-fixable issues
```

## Project structure

```
src/
├── index.js                 # Main module exports
├── classes/
│   ├── index.js            # Class exports
│   ├── expressMcp.js         # Main ExpressMcp class
│   ├── toolRegistry.js     # Tool registry management
│   ├── baseTool.js         # Base tool interface
│   └── knowledgeBase.js    # Knowledge base implementation
├── tools/
│   └── knowledgeBase.js    # Knowledge base MCP tools
tests/
├── unit/                   # In-process unit tests (npm run test:unit)
│   ├── expressMcp.test.js
│   ├── toolRegistry.test.js
│   ├── agent.test.js
│   └── knowledgeBase.test.js
├── integration/            # HTTP/MCP supertest tests (npm run test:integration)
│   ├── mcpProtocol.test.js
│   ├── agent.mcp.integration.test.js
│   ├── expressMcpKnowledgeBase.test.js
│   └── authMiddleware.test.js
├── live/                   # Live Gemini API (npm run test:live; copy config.example.js → config.js)
│   ├── README.md
│   ├── config.example.js
│   ├── liveConfig.js
│   ├── geminiAdapter.live.test.js
│   └── agent.live.test.js
├── config.js               # Shared MCP test helpers
├── testUtils.js            # Test utilities
└── authTestUtils.js        # OAuth test helpers
examples/
└── example.js             # Example application with knowledge base
```

## Pull requests

1. Branch from `main` (e.g. `feat/...` or `fix/...`).
2. Ensure `npm run lint` and `npm test` pass.
3. Describe the problem and the approach in the PR body.

## Publishing new versions

Releases to the npm registry run only when a **GitHub Release** is published for a `v*` tag (not on bare tag push, and not from feature branches).

To create a new release:

1. **Land the feature on `main`** via PR (no version bump / no tags in the feature PR).
2. **On `main`**, cut the version with `npm version major|minor|patch`
   - Bumps `package.json` / lockfile
   - Creates the version commit and git tag
3. **Push**: `git push && git push --tags`
4. **Publish a GitHub Release** for that tag (UI or `gh release create vX.Y.Z --generate-notes`). The Publish NPM Package workflow runs on `release: published` and verifies `package.json` version matches the tag before `npm publish`.

**Important notes:**

- New versions should **only** be generated using the `npm version` command (do not hand-edit version fields)
- Do **not** push `v*` tags from a feature branch before merge
- A tag alone does not publish; creating the GitHub Release does
- You don't need a Release for trivial README-only edits when no registry publish is intended

### Version guidelines

- **patch**: Bug fixes, documentation updates
- **minor**: New features, backward-compatible changes
- **major**: Breaking changes, API modifications

## Security

Do not open public issues for vulnerabilities. See [SECURITY.md](SECURITY.md).
