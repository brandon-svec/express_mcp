import { loadLiveGeminiConfig } from '../tests/live/liveConfig.js';

try {
  await loadLiveGeminiConfig();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
