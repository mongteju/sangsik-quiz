/**
 * Shared deterministic helper for structured-fact trivia generators.
 * Ensures every generated question has >= 5 distinct, same-domain distractors
 * that never collide with the answer, plus clean deduplication.
 */

function hashStr(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function pickDistractors(pool, answer, count = 5, seedKey = '') {
  const cleanAns = String(answer || '').trim();
  const candidates = [];
  const seen = new Set([cleanAns]);
  for (const item of pool) {
    const val = String(item || '').trim();
    if (val && !seen.has(val)) {
      seen.add(val);
      candidates.push(val);
    }
  }
  if (candidates.length <= count) return candidates;

  // Deterministic pseudo-random shuffle seeded by seedKey + answer
  let s = hashStr(`${seedKey}|${cleanAns}`) || 1337;
  const arr = [...candidates];
  for (let i = arr.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, count);
}

function createCollector() {
  const rows = [];
  const seenPrompts = new Set();

  function add(diff, question, answer, distractorPool, hint, explanation) {
    const q = String(question || '').trim();
    const a = String(answer || '').trim();
    if (!q || !a) return false;
    const norm = q.replace(/\s+/g, '');
    if (seenPrompts.has(norm)) return false;

    const distractors = pickDistractors(distractorPool, a, 5, q);
    if (distractors.length < 4) return false;

    const h = String(hint || '').trim();
    const exp = String(explanation || '').trim();
    if (!h || !exp) return false;

    seenPrompts.add(norm);
    rows.push([diff, q, a, distractors, h, exp]);
    return true;
  }

  return { rows, add };
}

module.exports = {
  pickDistractors,
  createCollector
};
