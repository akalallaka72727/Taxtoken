// Simple in-memory session store keyed by Telegram chat id.
// Good enough for a testbed bot; swap for Redis/DB if you need persistence across restarts.

const sessions = new Map();

export function getSession(chatId) {
  if (!sessions.has(chatId)) {
    sessions.set(chatId, { step: null, data: {} });
  }
  return sessions.get(chatId);
}

export function resetSession(chatId) {
  sessions.set(chatId, { step: null, data: {} });
}

export function setStep(chatId, step) {
  const s = getSession(chatId);
  s.step = step;
  return s;
}
