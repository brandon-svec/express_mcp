import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const CONFIG_FILE = join(dirname(fileURLToPath(import.meta.url)), 'config.js');

let cached = null;

/**
 * Load live Gemini credentials from tests/live/config.js.
 * Throws if the file is missing or invalid — live tests are intentional, not optional.
 *
 * @returns {Promise<{ apiKey: string, model: string }>}
 */
export async function loadLiveGeminiConfig () {
  if (cached) {
    return cached;
  }

  if (!existsSync(CONFIG_FILE)) {
    throw new Error(
      'Live Gemini test config is missing. Copy tests/live/config.example.js to tests/live/config.js and set liveGeminiConfig.apiKey. Run with: npm run test:live',
    );
  }

  const mod = await import(pathToFileURL(CONFIG_FILE).href);
  const cfg = mod.liveGeminiConfig;
  if (!cfg || typeof cfg.apiKey !== 'string' || !cfg.apiKey.trim()) {
    throw new Error('tests/live/config.js: liveGeminiConfig.apiKey must be a non-empty string');
  }
  if (typeof cfg.model !== 'string' || !cfg.model.trim()) {
    throw new Error('tests/live/config.js: liveGeminiConfig.model must be a non-empty string');
  }

  cached = {
    apiKey: cfg.apiKey.trim(),
    model: cfg.model.trim(),
  };
  return cached;
}
