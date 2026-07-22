/**
 * @param {string} duration - e.g. 7d, 1h, 30m, 120s
 * @returns {number} seconds
 */
export function parseDurationToSeconds(duration) {
  if (typeof duration !== 'string' || !duration.trim()) {
    throw new Error('duration is required');
  }
  const match = /^(\d+)([smhd])$/i.exec(duration.trim());
  if (!match) {
    throw new Error(`Invalid duration: ${duration}`);
  }
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error(`Invalid duration amount: ${duration}`);
  }
  const multipliers = { s: 1, m: 60, h: 3600, d: 86400 };
  return amount * multipliers[unit];
}
