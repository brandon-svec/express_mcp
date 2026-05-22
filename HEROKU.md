# Deploy to Heroku (mcp-test-express)

## Prerequisites

- [Heroku CLI](https://devcenter.heroku.com/articles/heroku-cli) installed
- Git repository initialized
- OAuth app registered (GitHub or Google) with callback URL:
  `https://mcp-test-express.herokuapp.com/auth/callback`

## One-time setup

```bash
heroku login
heroku git:remote -a mcp-test-express
```

## Config vars

Copy from [.env.example](.env.example) and set on Heroku:

```bash
heroku config:set BASE_URL=https://mcp-test-express.herokuapp.com -a mcp-test-express
heroku config:set OAUTH_PROVIDER=github -a mcp-test-express
heroku config:set OAUTH_CLIENT_ID=your_client_id -a mcp-test-express
heroku config:set OAUTH_CLIENT_SECRET=your_client_secret -a mcp-test-express
heroku config:set OAUTH_CALLBACK_URL=https://mcp-test-express.herokuapp.com/auth/callback -a mcp-test-express
heroku config:set JWT_SECRET="$(openssl rand -hex 32)" -a mcp-test-express
heroku config:set SESSION_SECRET="$(openssl rand -hex 32)" -a mcp-test-express
```

`NODE_ENV=production` is set automatically by Heroku.

## Deploy

Commit deploy files (`server.js`, `Procfile`, `package.json`, `src/`, etc.), then push the current branch to Heroku:

```bash
git push heroku HEAD:main
```

If your Heroku app uses `master` as the deploy branch:

```bash
git push heroku HEAD:master
```

The app runs without OAuth until config vars are set (see `/health`). MCP works at `POST /mcp` with no auth in that mode.

## Verify

```bash
heroku open -a mcp-test-express
curl https://mcp-test-express.herokuapp.com/health
```

1. Open the app URL and click **Login with GitHub** (or Google).
2. Copy the JWT from the success page.
3. In Cursor `mcp.json`:

```json
{
  "mcpServers": {
    "mcp-test-express": {
      "url": "https://mcp-test-express.herokuapp.com/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_JWT_HERE"
      }
    }
  }
}
```

## Logs

```bash
heroku logs --tail -a mcp-test-express
```
