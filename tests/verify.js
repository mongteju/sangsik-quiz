const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  ALL_QUESTIONS,
  CATEGORIES,
  QUESTION_BY_ID,
  getStats
} = require('../data/questions');
const db = require('../db');
const { server, startServer, getStageConfig } = require('../server');

async function runTests() {
  console.log('=== 1. 15,000+ Question Bank Integrity ===');
  const stats = getStats();
  console.log(`Total unique questions: ${stats.totalQuestions}`);
  console.log('By difficulty:', stats.byDifficulty);
  for (const cat of CATEGORIES) {
    const s = stats.byCategory[cat.id];
    console.log(`  - ${cat.id.padEnd(16)} (${cat.name}): total=${s.total} [intro=${s.intro}, beg=${s.beginner}, int=${s.intermediate}, adv=${s.advanced}]`);
    assert(s.total >= 2000, `Category ${cat.id} should have >= 2000 questions, got ${s.total}`);
    assert(s.intro >= 250, `Category ${cat.id} intro too low: ${s.intro}`);
    assert(s.beginner >= 400, `Category ${cat.id} beginner too low: ${s.beginner}`);
    assert(s.intermediate >= 500, `Category ${cat.id} intermediate too low: ${s.intermediate}`);
    assert(s.advanced >= 400, `Category ${cat.id} advanced too low: ${s.advanced}`);
  }
  assert(stats.totalQuestions >= 15000, `Expected >= 15000 unique questions, got ${stats.totalQuestions}`);
  assert.strictEqual(CATEGORIES.length, 6);

  const seenIds = new Set();
  const seenPrompts = new Set();
  for (const q of ALL_QUESTIONS) {
    assert(q.id && !seenIds.has(q.id), `Duplicate ID: ${q.id}`);
    seenIds.add(q.id);
    const norm = q.question.replace(/\s+/g, '');
    assert(!seenPrompts.has(norm), `Duplicate prompt: ${q.question}`);
    seenPrompts.add(norm);
    assert(q.distractors.length >= 4, `Too few distractors on ${q.id}`);
    assert(!q.distractors.includes(q.answer), `Answer in distractors on ${q.id}`);
    assert(q.hint && q.explanation, `Missing hint/explanation on ${q.id}`);
  }
  console.log('All 15,000+ questions passed strict uniqueness & schema checks!');

  console.log('\n=== 2. UI Cleanliness Verification ===');
  for (const rel of ['public/index.html', 'public/styles.css', 'public/app.js']) {
    const content = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    assert(!/herald\s*tribune|헤럴드\s*트리뷴/i.test(content), `Found forbidden branding in ${rel}`);
    assert(!/\p{Extended_Pictographic}/u.test(content), `Found emoji in ${rel}`);
  }
  console.log('UI cleanliness passed (0 emojis, 0 Herald Tribune text).');

  console.log('\n=== 3. Stage Cutline Progression ===');
  assert.deepStrictEqual(
    [1, 2, 3, 4, 5, 6, 7].map((n) => `${getStageConfig(n).label}:${getStageConfig(n).passCutline}`),
    ['입문:6', '초급:6', '중급:7', '고급 1:7', '고급 2:7', '고급 3:7', '고급 4:7']
  );

  console.log('\n=== 4. Live Server: Category Filtering, Independent Category Rankings & Local 2P Overtime ===');
  await startServer(0);
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const testNick = '__TEST_CAT__';

  try {
    await db.deleteRankingByNickname(testNick);

    // 4a. Test category-specific solo start (movie only!)
    const movieStart = await (await fetch(`${baseUrl}/api/quiz/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname: testNick, category: 'movie' })
    })).json();
    assert.strictEqual(movieStart.category, 'movie');
    assert.strictEqual(movieStart.question.category, 'movie');

    // Finish 10 movie questions with 3 right (< 6 cutline) -> saves to 'movie' ranking only
    let curQ = movieStart.question;
    let lastAns = null;
    for (let i = 0; i < 10; i++) {
      const full = QUESTION_BY_ID.get(curQ.id);
      assert.strictEqual(full.category, 'movie', 'All questions in movie mode must be movie category');
      const okIdx = curQ.choices.indexOf(full.answer);
      const wrongIdx = (okIdx + 1) % 4;
      lastAns = await (await fetch(`${baseUrl}/api/quiz/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: movieStart.sessionId, choiceIndex: i < 3 ? okIdx : wrongIdx })
      })).json();
      curQ = lastAns.nextQuestion;
    }
    assert.strictEqual(lastAns.finished, true);
    assert.strictEqual(lastAns.summary.category, 'movie');

    // Verify saved in 'movie' ranking, NOT in 'all' ranking
    const movieRanks = await (await fetch(`${baseUrl}/api/rankings?category=movie`)).json();
    const allRanks = await (await fetch(`${baseUrl}/api/rankings?category=all`)).json();
    assert(movieRanks.rankings.some((r) => r.nickname === testNick), 'Must appear in movie ranking');
    assert(!allRanks.rankings.some((r) => r.nickname === testNick), 'Must NOT appear in all ranking');

    // Same nickname saves independently in 'all' AND overwrites only higher score within 'movie'
    await db.upsertBestRanking({
      id: 'test-all-1', nickname: testNick, category: 'all', score: 1500, stageReached: 2, stageLabel: '초급',
      correctCount: 12, totalCount: 20, accuracy: 60, noHintCorrect: 12, maxStreak: 5,
      createdAt: '2026-11-25T01:00:00.000Z'
    });
    const overMovie = await db.upsertBestRanking({
      id: 'test-mov-2', nickname: testNick, category: 'movie', score: 2100, stageReached: 3, stageLabel: '중급',
      correctCount: 18, totalCount: 30, accuracy: 60, noHintCorrect: 17, maxStreak: 6,
      createdAt: '2026-11-25T02:00:00.000Z'
    });
    assert.strictEqual(overMovie.updated, true);

    const movieRanksAfter = await (await fetch(`${baseUrl}/api/rankings?category=movie`)).json();
    const allRanksAfter = await (await fetch(`${baseUrl}/api/rankings?category=all`)).json();
    assert.strictEqual(movieRanksAfter.rankings.filter((r) => r.nickname === testNick).length, 1);
    assert.strictEqual(movieRanksAfter.rankings.find((r) => r.nickname === testNick).score, 2100);
    assert.strictEqual(allRanksAfter.rankings.find((r) => r.nickname === testNick).score, 1500);
    console.log('Category filtering & independent per-category high-score overwrite verified!');

    // 4b. Local 2P Duel with movie category + sudden-death overtime
    const startDuel = await (await fetch(`${baseUrl}/api/duel/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ p1Name: '철수', p2Name: '영희', category: 'movie' })
    })).json();
    assert.strictEqual(startDuel.category, 'movie');
    let q = startDuel.question;
    let duelPayload = null;
    for (let i = 0; i < 10; i++) {
      const fullQ = QUESTION_BY_ID.get(q.id);
      assert.strictEqual(fullQ.category, 'movie');
      const ansIdx = q.choices.indexOf(fullQ.answer);
      duelPayload = await (await fetch(`${baseUrl}/api/duel/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ duelId: startDuel.duelId, p1Choice: ansIdx, p2Choice: ansIdx })
      })).json();
      q = duelPayload.nextQuestion;
    }
    assert.strictEqual(duelPayload.finished, false);
    assert.strictEqual(q.isOvertime, true);
    assert.strictEqual(q.category, 'movie');
    console.log('Local 2P Duel category filtering & sudden-death overtime verified!');
  } finally {
    await db.deleteRankingByNickname(testNick);
    await new Promise((resolve) => server.close(resolve));
    await db.closeDb();
  }

  console.log('\nALL 15,000+ VERIFICATION TESTS PASSED!');
}

runTests().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
