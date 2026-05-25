/** Mocha config for intentional live Gemini tests only (npm run test:live). */
module.exports = {
  extension: ['js'],
  timeout: 60000,
  exit: true,
  spec: ['tests/live/**/*.live.test.js'],
};
