# Contributing

Thanks for contributing to `@brandon-svec/express_mcp`.

## Development

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

## Pull requests

1. Branch from `main` (e.g. `feat/...` or `fix/...`).
2. Ensure `npm run lint` and `npm test` pass.
3. Describe the problem and the approach in the PR body.

## Security

Do not open public issues for vulnerabilities. See [SECURITY.md](SECURITY.md).
