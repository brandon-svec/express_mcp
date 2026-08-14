# Live Gemini tests

Real calls to the Gemini API. **Not** part of `npm test` or CI.

## Setup (once)

```bash
cp tests/live/config.example.js tests/live/config.js
```

Edit `tests/live/config.js` and set `liveGeminiConfig.apiKey`. The file is gitignored.

## Run

```bash
npm run test:live
```

If `config.js` is missing or `apiKey` is empty, the run fails immediately with a clear error (no silent skips).

## Models

Set `liveGeminiConfig.model` (default in example: `gemini-2.5-flash`) and `liveGeminiConfig.gemini3Model` (default: `gemini-3.5-flash-lite`). The Gemini 3 live agent case requires a thought-signature-safe tool loop.
