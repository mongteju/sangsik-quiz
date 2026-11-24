const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  CATEGORIES,
  QUESTION_BY_ID,
  getStats
} = require('../data/questions');
const db = require('../db');
const { server, startServer, getStageConfig } = require('../server');

async function runTests() {
  console.log('=== 1. Question Bank Integrity ===');
  const stats = getStats();
  assert(stats.totalQuestions >= 1490, `Expected >= 1490 questions, got ${stats.totalQuestions}`);
  assert(stats.byDifficulty.intro >= 195, `Expected >= 195 intro questions, got ${stats.byDifficulty.intro}`);
  assert(stats.byDifficulty.beginner >= 245, `Expected >= 245 beginner questions, got ${stats.byDifficulty.beginner}`);
  assert.strictEqual(CATEGORIES.length, 10);
  console.log(`Loaded ${stats.totalQuestions} unique questions (intro=${stats.byDifficulty.intro}, beginner=${stats.byDifficulty.beginner}, intermediate=${stats.byDifficulty.intermediate}, advanced=${stats.byDifficulty.advanced}).`);

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
    ['입문:6', '초급:6', '중급:7', '고급 1:7', '고급 2:8', '고급 3:9', '고급 4:10']
  );

  console.log('\n=== 4. Live Server: Ranking High-Score Overwrite & Local 2P Sudden-Death Overtime ===');
  await startServer(0);
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const testNick = '__TEST_BEST_OVERWRITE__';

  try {
    // 4a. Test same-nickname best-score overwrite directly via db.upsertBestRanking + /api/rankings
    await db.deleteRankingByNickname(testNick);

    const low = {
      id: 'test-low', nickname: testNick, score: 400, stageReached: 1, stageLabel: '초급',
      correctCount: 3, totalCount: 10, accuracy: 30, noHintCorrect: 3, maxStreak: 2,
      createdAt: '2026-11-24T01:00:00.000Z'
    };
    const r1 = await db.upsertBestRanking(low);
    assert.strictEqual(r1.saved, true);
    assert.strictEqual(r1.isPersonalBest, true);

    const high = {
      id: 'test-high', nickname: testNick, score: 1950, stageReached: 2, stageLabel: '중급',
      correctCount: 14, totalCount: 20, accuracy: 70, noHintCorrect: 13, maxStreak: 7,
      createdAt: '2026-11-24T06:00:00.000Z'
    };
    const r2 = await db.upsertBestRanking(high);
    assert.strictEqual(r2.saved, true);
    assert.strictEqual(r2.updated, true, 'Higher score for same nickname must overwrite existing record');

    const mid = {
      id: 'test-mid', nickname: testNick, score: 900, stageReached: 1, stageLabel: '초급',
      correctCount: 5, totalCount: 10, accuracy: 50, noHintCorrect: 5, maxStreak: 3,
      createdAt: '2026-11-24T07:00:00.000Z'
    };
    const r3 = await db.upsertBestRanking(mid);
    assert.strictEqual(r3.saved, false, 'Lower score for same nickname must NOT overwrite higher score');
    assert.strictEqual(r3.record.score, 1950);

    const rankRes = await (await fetch(`${baseUrl}/api/rankings`)).json();
    const matches = rankRes.rankings.filter((x) => x.nickname === testNick);
    assert.strictEqual(matches.length, 1, 'Same nickname must appear only ONCE in rankings');
    assert.strictEqual(matches[0].score, 1950);
    assert.strictEqual(matches[0].createdAt, '2026-11-24T06:00:00.000Z');
    console.log('Same-nickname high-score overwrite + date/time persistence verified!');

    // 4b. Local 2P Duel: 10 tied rounds -> Overtime 1 (still tied) -> Overtime 2 (P1 wins decisively!)
    const startDuel = await (await fetch(`${baseUrl}/api/duel/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ p1Name: '철수', p2Name: '영희' })
    })).json();
    assert(startDuel.duelId && startDuel.question);

    let q = startDuel.question;
    let duelPayload = null;
    for (let i = 0; i < 10; i++) {
      const fullQ = QUESTION_BY_ID.get(q.id);
      const ansIdx = q.choices.indexOf(fullQ.answer);
      // Both players answer identically -> tied after 10 rounds!
      duelPayload = await (await fetch(`${baseUrl}/api/duel/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ duelId: startDuel.duelId, p1Choice: ansIdx, p2Choice: ansIdx })
      })).json();
      q = duelPayload.nextQuestion;
    }

    assert.strictEqual(duelPayload.finished, false, 'Tied 2P duel after 10 rounds must enter sudden-death overtime');
    assert.strictEqual(q.isOvertime, true);
    assert.strictEqual(q.overtimeRound, 1);

    // Overtime 1: still tied!
    const ot1Full = QUESTION_BY_ID.get(q.id);
    const ot1Ans = q.choices.indexOf(ot1Full.answer);
    duelPayload = await (await fetch(`${baseUrl}/api/duel/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ duelId: startDuel.duelId, p1Choice: ot1Ans, p2Choice: ot1Ans })
    })).json();
    assert.strictEqual(duelPayload.finished, false);
    assert.strictEqual(duelPayload.nextQuestion.overtimeRound, 2);

    // Overtime 2: P1 answers right, P2 answers wrong -> Decisive P1 victory!
    q = duelPayload.nextQuestion;
    const ot2Full = QUESTION_BY_ID.get(q.id);
    const ot2Ans = q.choices.indexOf(ot2Full.answer);
    const ot2Wrong = (ot2Ans + 1) % 4;
    duelPayload = await (await fetch(`${baseUrl}/api/duel/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ duelId: startDuel.duelId, p1Choice: ot2Ans, p2Choice: ot2Wrong })
    })).json();

    assert.strictEqual(duelPayload.finished, true);
    assert.strictEqual(duelPayload.winner, 'p1');
    assert.strictEqual(duelPayload.totalRoundsPlayed, 12);
    console.log('Local 2P Duel 10 base rounds + sudden-death overtime (연장 1 -> 연장 2 결판) verified!');
  } finally {
    await db.deleteRankingByNickname(testNick);
    await new Promise((resolve) => server.close(resolve));
    await db.closeDb();
  }

  console.log('\nALL VERIFICATION TESTS PASSED!');
}

runTests().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
