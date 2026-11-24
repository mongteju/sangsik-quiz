const http = require('http');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');
const { selectQuestions, getStats } = require('./data/questions');
const db = require('./db');

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ------------------------------------------------------------
// Stage Progression Configuration (Solo: 10 Questions per Stage)
// Stage 1: 입문 (6/10) -> Stage 2: 초급 (6/10) -> Stage 3: 중급 (7/10)
// Stage 4+: 고급 1, 고급 2, 고급 3... (일괄 7/10 통과)
// ------------------------------------------------------------
function getStageConfig(stageNum) {
  if (stageNum === 1) {
    return { stage: 1, difficulty: 'intro', label: '입문', count: 10, passCutline: 6, basePoints: 80, timeSec: 35 };
  }
  if (stageNum === 2) {
    return { stage: 2, difficulty: 'beginner', label: '초급', count: 10, passCutline: 6, basePoints: 100, timeSec: 35 };
  }
  if (stageNum === 3) {
    return { stage: 3, difficulty: 'intermediate', label: '중급', count: 10, passCutline: 7, basePoints: 150, timeSec: 35 };
  }
  const advTier = stageNum - 3;
  const basePoints = 200 + (advTier - 1) * 30;
  return {
    stage: stageNum,
    difficulty: 'advanced',
    label: `고급 ${advTier}`,
    count: 10,
    passCutline: 7,
    basePoints,
    timeSec: 40
  };
}

// ------------------------------------------------------------
// Fair No-Reflex Scoring Engine (Zero Speed Bonus)
// ------------------------------------------------------------
const SCORING_RULES = {
  noHintBonus: 30,
  streakStep: 15,
  streakMax: 75
};

function evaluateAnswer({ basePoints, isCorrect, usedHint, currentStreak }) {
  if (!isCorrect) {
    return {
      pointsEarned: 0,
      nextStreak: 0,
      breakdown: { base: 0, noHint: 0, streak: 0 }
    };
  }
  const nextStreak = currentStreak + 1;
  const noHintPts = usedHint ? 0 : SCORING_RULES.noHintBonus;
  const streakPts = nextStreak >= 2
    ? Math.min((nextStreak - 1) * SCORING_RULES.streakStep, SCORING_RULES.streakMax)
    : 0;
  return {
    pointsEarned: basePoints + noHintPts + streakPts,
    nextStreak,
    breakdown: { base: basePoints, noHint: noHintPts, streak: streakPts }
  };
}

function sanitizeNickname(raw, fallback = '익명') {
  const trimmed = String(raw || '').trim().replace(/\s+/g, ' ');
  if (!trimmed) return fallback;
  return trimmed.slice(0, 16);
}

function sanitizeSoloQuestion(q, indexInStage, stageCfg) {
  return {
    id: q.id,
    index: indexInStage,
    total: stageCfg.count,
    stage: stageCfg.stage,
    stageLabel: stageCfg.label,
    passCutline: stageCfg.passCutline,
    category: q.category,
    categoryName: q.categoryName,
    difficulty: stageCfg.difficulty,
    basePoints: stageCfg.basePoints,
    timeSec: stageCfg.timeSec,
    question: q.question,
    choices: q.choices
  };
}

function sanitizeDuelQuestion(q, roundIndex, baseRounds, isOvertime, overtimeRound) {
  const diffLabels = { intro: '입문', beginner: '초급', intermediate: '중급', advanced: '고급' };
  return {
    id: q.id,
    roundIndex,
    baseRounds,
    isOvertime,
    overtimeRound,
    stageLabel: isOvertime ? `연장 ${overtimeRound}` : (diffLabels[q.difficulty] || '상식'),
    categoryName: q.categoryName,
    basePoints: q.basePoints,
    timeSec: q.timeSec,
    question: q.question,
    choices: q.choices
  };
}

// ------------------------------------------------------------
// Active Sessions Store (Solo + Local 2P Duel)
// ------------------------------------------------------------
const soloSessions = new Map();
const duelSessions = new Map();

function pruneSessions() {
  const cutoff = Date.now() - 1000 * 60 * 60 * 2;
  for (const [id, s] of soloSessions.entries()) {
    if (s.createdAt < cutoff) soloSessions.delete(id);
  }
  for (const [id, d] of duelSessions.entries()) {
    if (d.createdAt < cutoff) duelSessions.delete(id);
  }
}
setInterval(pruneSessions, 1000 * 60 * 15).unref();

function loadStageIntoSolo(session, stageNum) {
  const cfg = getStageConfig(stageNum);
  const questions = selectQuestions({
    difficulty: cfg.difficulty,
    category: 'all',
    count: cfg.count,
    seenIds: Array.from(session.usedIds)
  });
  questions.forEach((q) => session.usedIds.add(q.id));

  session.stage = stageNum;
  session.stageCfg = cfg;
  session.stageQuestions = questions;
  session.stageIndex = 0;
  session.stageCorrect = 0;
  session.stageOutcomes = [];
  session.hintsLeft = { fiftyFifty: 1, editorial: 1 };
  session.currentHintsUsed = { fiftyFifty: false, editorial: false };
}

// ------------------------------------------------------------
// REST API — Meta & Rankings (1인 모드 전용)
// ------------------------------------------------------------
app.get('/api/meta', (req, res) => {
  const stats = getStats();
  res.json({
    totalQuestions: stats.totalQuestions,
    dbMode: db.getDbMode()
  });
});

app.get('/api/rankings', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const rankings = await db.getTopRankings(limit);
    res.json({ rankings, dbMode: db.getDbMode() });
  } catch (err) {
    console.error('Failed to fetch rankings:', err);
    res.status(500).json({ error: '랭킹을 불러오지 못했습니다.' });
  }
});

// ------------------------------------------------------------
// REST API — Solo Mode (Stage Cutline Progression)
// ------------------------------------------------------------
app.post('/api/quiz/start', (req, res) => {
  const { nickname = '익명', seenIds = [] } = req.body || {};
  const sessionId = crypto.randomBytes(10).toString('hex');

  const session = {
    sessionId,
    nickname: sanitizeNickname(nickname, '익명'),
    usedIds: new Set(Array.isArray(seenIds) ? seenIds.slice(-1200) : []),
    stage: 1,
    stageCfg: null,
    stageQuestions: [],
    stageIndex: 0,
    stageCorrect: 0,
    stageOutcomes: [],
    score: 0,
    totalCorrect: 0,
    totalAnswered: 0,
    noHintCorrect: 0,
    streak: 0,
    maxStreak: 0,
    hintsLeft: { fiftyFifty: 1, editorial: 1 },
    currentHintsUsed: { fiftyFifty: false, editorial: false },
    history: [],
    finished: false,
    createdAt: Date.now()
  };

  loadStageIntoSolo(session, 1);
  soloSessions.set(sessionId, session);

  res.json({
    sessionId,
    nickname: session.nickname,
    stage: session.stageCfg,
    stageOutcomes: session.stageOutcomes,
    hintsLeft: session.hintsLeft,
    question: sanitizeSoloQuestion(session.stageQuestions[0], 0, session.stageCfg)
  });
});

app.post('/api/quiz/hint', (req, res) => {
  const { sessionId, type } = req.body || {};
  const session = soloSessions.get(sessionId);
  if (!session || session.finished) {
    return res.status(404).json({ error: '종료된 세션입니다.' });
  }
  const q = session.stageQuestions[session.stageIndex];
  if (!q) return res.status(400).json({ error: '문항을 찾을 수 없습니다.' });

  if (type === 'fiftyFifty') {
    if (session.currentHintsUsed.fiftyFifty || session.hintsLeft.fiftyFifty <= 0) {
      return res.status(400).json({ error: '사용할 수 없습니다.' });
    }
    session.hintsLeft.fiftyFifty -= 1;
    session.currentHintsUsed.fiftyFifty = true;
    const wrongIndices = q.choices.map((_, i) => i).filter((i) => i !== q.answerIndex);
    for (let i = wrongIndices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [wrongIndices[i], wrongIndices[j]] = [wrongIndices[j], wrongIndices[i]];
    }
    return res.json({
      type: 'fiftyFifty',
      removedIndices: wrongIndices.slice(0, 2),
      hintsLeft: session.hintsLeft
    });
  }

  if (type === 'editorial') {
    if (session.currentHintsUsed.editorial || session.hintsLeft.editorial <= 0) {
      return res.status(400).json({ error: '사용할 수 없습니다.' });
    }
    session.hintsLeft.editorial -= 1;
    session.currentHintsUsed.editorial = true;
    return res.json({
      type: 'editorial',
      hintText: q.hint,
      hintsLeft: session.hintsLeft
    });
  }

  return res.status(400).json({ error: '알 수 없는 요청입니다.' });
});

app.post('/api/quiz/answer', async (req, res) => {
  const { sessionId, choiceIndex, timedOut = false } = req.body || {};
  const session = soloSessions.get(sessionId);
  if (!session || session.finished) {
    return res.status(404).json({ error: '종료된 세션입니다.' });
  }

  const q = session.stageQuestions[session.stageIndex];
  if (!q) return res.status(400).json({ error: '문항을 찾을 수 없습니다.' });

  const cfg = session.stageCfg;
  const usedHint = session.currentHintsUsed.fiftyFifty || session.currentHintsUsed.editorial;
  const isCorrect = !timedOut && Number(choiceIndex) === q.answerIndex;

  const evalRes = evaluateAnswer({
    basePoints: cfg.basePoints,
    isCorrect,
    usedHint,
    currentStreak: session.streak
  });

  session.score += evalRes.pointsEarned;
  session.streak = evalRes.nextStreak;
  if (session.streak > session.maxStreak) session.maxStreak = session.streak;
  session.totalAnswered += 1;
  session.stageOutcomes.push(isCorrect);

  if (isCorrect) {
    session.stageCorrect += 1;
    session.totalCorrect += 1;
    if (!usedHint) session.noHintCorrect += 1;
  }

  const record = {
    questionId: q.id,
    stage: cfg.stage,
    stageLabel: cfg.label,
    categoryName: q.categoryName,
    question: q.question,
    choices: q.choices,
    selectedIndex: timedOut ? -1 : Number(choiceIndex),
    answerIndex: q.answerIndex,
    answer: q.answer,
    explanation: q.explanation,
    isCorrect,
    timedOut: Boolean(timedOut),
    usedHint,
    pointsEarned: evalRes.pointsEarned
  };
  session.history.push(record);

  session.stageIndex += 1;
  session.currentHintsUsed = { fiftyFifty: false, editorial: false };

  const currentStageOutcomes = [...session.stageOutcomes];
  const currentStageCorrect = session.stageCorrect;

  let stageTransition = null;
  let nextQuestion = null;
  let finished = false;
  let summary = null;

  if (session.stageIndex >= cfg.count) {
    if (currentStageCorrect >= cfg.passCutline) {
      const nextStageNum = cfg.stage + 1;
      loadStageIntoSolo(session, nextStageNum);
      stageTransition = {
        passed: true,
        completedStage: cfg,
        stageCorrect: currentStageCorrect,
        nextStage: session.stageCfg
      };
      nextQuestion = sanitizeSoloQuestion(session.stageQuestions[0], 0, session.stageCfg);
    } else {
      finished = true;
      session.finished = true;
      stageTransition = {
        passed: false,
        completedStage: cfg,
        stageCorrect: currentStageCorrect
      };

      const accuracy = Number(((session.totalCorrect / Math.max(1, session.totalAnswered)) * 100).toFixed(1));
      const entry = {
        id: crypto.randomBytes(8).toString('hex'),
        nickname: session.nickname,
        score: session.score,
        stageReached: cfg.stage,
        stageLabel: cfg.label,
        correctCount: session.totalCorrect,
        totalCount: session.totalAnswered,
        accuracy,
        noHintCorrect: session.noHintCorrect,
        maxStreak: session.maxStreak,
        createdAt: new Date().toISOString()
      };

      let rankPosition = null;
      let personalBestInfo = null;
      try {
        personalBestInfo = await db.upsertBestRanking(entry);
        rankPosition = await db.getRankPositionByNickname(entry.nickname);
        if (personalBestInfo.saved) {
          const topRankings = await db.getTopRankings(50);
          broadcastAll({ type: 'RANKING_UPDATED', rankings: topRankings });
        }
      } catch (err) {
        console.error('Failed to persist ranking:', err);
      }

      summary = {
        ...entry,
        rankPosition,
        isPersonalBest: personalBestInfo ? personalBestInfo.isPersonalBest : true,
        bestScore: personalBestInfo ? personalBestInfo.record.score : entry.score
      };
    }
  } else {
    nextQuestion = sanitizeSoloQuestion(
      session.stageQuestions[session.stageIndex],
      session.stageIndex,
      session.stageCfg
    );
  }

  res.json({
    result: record,
    totalScore: session.score,
    streak: session.streak,
    stageCorrect: currentStageCorrect,
    stageOutcomes: currentStageOutcomes,
    hintsLeft: session.hintsLeft,
    stageTransition,
    finished,
    nextQuestion,
    summary
  });
});

// ------------------------------------------------------------
// REST API — Local Offline 2-Player Duel (10 Base Rounds + Sudden-Death Overtime)
// ------------------------------------------------------------
app.post('/api/duel/start', (req, res) => {
  const { p1Name = 'P1', p2Name = 'P2', seenIds = [] } = req.body || {};
  const duelId = crypto.randomBytes(10).toString('hex');
  const usedIds = new Set(Array.isArray(seenIds) ? seenIds.slice(-1200) : []);

  // 10 base questions: 2 intro + 3 beginner + 3 intermediate + 2 advanced
  const nQs = selectQuestions({ difficulty: 'intro', category: 'all', count: 2, seenIds: Array.from(usedIds) });
  nQs.forEach((q) => usedIds.add(q.id));
  const bQs = selectQuestions({ difficulty: 'beginner', category: 'all', count: 3, seenIds: Array.from(usedIds) });
  bQs.forEach((q) => usedIds.add(q.id));
  const iQs = selectQuestions({ difficulty: 'intermediate', category: 'all', count: 3, seenIds: Array.from(usedIds) });
  iQs.forEach((q) => usedIds.add(q.id));
  const aQs = selectQuestions({ difficulty: 'advanced', category: 'all', count: 2, seenIds: Array.from(usedIds) });
  aQs.forEach((q) => usedIds.add(q.id));

  const questions = [...nQs, ...bQs, ...iQs, ...aQs];

  const duel = {
    duelId,
    p1: { name: sanitizeNickname(p1Name, 'P1'), score: 0, correct: 0, streak: 0 },
    p2: { name: sanitizeNickname(p2Name, 'P2'), score: 0, correct: 0, streak: 0 },
    baseRounds: 10,
    roundIndex: 0,
    overtimeRound: 0,
    usedIds,
    currentQuestion: questions[0],
    queue: questions.slice(1),
    finished: false,
    createdAt: Date.now()
  };

  duelSessions.set(duelId, duel);

  res.json({
    duelId,
    p1: duel.p1,
    p2: duel.p2,
    question: sanitizeDuelQuestion(duel.currentQuestion, 0, duel.baseRounds, false, 0)
  });
});

app.post('/api/duel/answer', (req, res) => {
  const { duelId, p1Choice = -1, p2Choice = -1 } = req.body || {};
  const duel = duelSessions.get(duelId);
  if (!duel || duel.finished) {
    return res.status(404).json({ error: '종료된 대결입니다.' });
  }

  const q = duel.currentQuestion;
  const p1Correct = Number(p1Choice) === q.answerIndex;
  const p2Correct = Number(p2Choice) === q.answerIndex;

  // Fair no-reflex scoring for both players simultaneously
  const pts = q.basePoints || 100;
  const p1Eval = evaluateAnswer({ basePoints: pts, isCorrect: p1Correct, usedHint: true, currentStreak: duel.p1.streak });
  const p2Eval = evaluateAnswer({ basePoints: pts, isCorrect: p2Correct, usedHint: true, currentStreak: duel.p2.streak });

  duel.p1.score += p1Eval.pointsEarned;
  duel.p1.streak = p1Eval.nextStreak;
  if (p1Correct) duel.p1.correct += 1;

  duel.p2.score += p2Eval.pointsEarned;
  duel.p2.streak = p2Eval.nextStreak;
  if (p2Correct) duel.p2.correct += 1;

  const roundResult = {
    roundIndex: duel.roundIndex,
    isOvertime: duel.overtimeRound > 0,
    overtimeRound: duel.overtimeRound,
    answerIndex: q.answerIndex,
    answer: q.answer,
    explanation: q.explanation,
    p1: {
      choiceIndex: Number(p1Choice),
      isCorrect: p1Correct,
      pointsEarned: p1Eval.pointsEarned,
      totalScore: duel.p1.score
    },
    p2: {
      choiceIndex: Number(p2Choice),
      isCorrect: p2Correct,
      pointsEarned: p2Eval.pointsEarned,
      totalScore: duel.p2.score
    }
  };

  duel.roundIndex += 1;

  let finished = false;
  let winner = null;
  let nextQuestion = null;

  if (duel.roundIndex < duel.baseRounds) {
    // Still within regular 10 rounds
    duel.currentQuestion = duel.queue.shift();
    nextQuestion = sanitizeDuelQuestion(duel.currentQuestion, duel.roundIndex, duel.baseRounds, false, 0);
  } else if (duel.p1.score !== duel.p2.score) {
    // Completed 10+ rounds and tie is broken -> Decisive winner!
    finished = true;
    duel.finished = true;
    winner = duel.p1.score > duel.p2.score ? 'p1' : 'p2';
  } else {
    // Still tied after round 10+ -> Sudden-Death Overtime until settled!
    duel.overtimeRound += 1;
    const overtimePool = selectQuestions({
      difficulty: duel.overtimeRound <= 2 ? 'intermediate' : 'advanced',
      category: 'all',
      count: 1,
      seenIds: Array.from(duel.usedIds)
    });
    const otQ = overtimePool[0];
    duel.usedIds.add(otQ.id);
    duel.currentQuestion = otQ;
    nextQuestion = sanitizeDuelQuestion(otQ, duel.roundIndex, duel.baseRounds, true, duel.overtimeRound);
  }

  res.json({
    result: roundResult,
    p1: duel.p1,
    p2: duel.p2,
    totalRoundsPlayed: duel.roundIndex,
    finished,
    winner,
    nextQuestion
  });
});

// ------------------------------------------------------------
// HTTP & WebSocket Server (Live 1P Ranking Sync)
// ------------------------------------------------------------
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const connectedClients = new Set();

function broadcastAll(payload) {
  const data = JSON.stringify(payload);
  for (const ws of connectedClients) {
    if (ws.readyState === 1) ws.send(data);
  }
}

wss.on('connection', (ws) => {
  connectedClients.add(ws);
  ws.on('close', () => connectedClients.delete(ws));
});

async function startServer(port = PORT) {
  const dbInfo = await db.initDb();
  return new Promise((resolve) => {
    server.listen(port, () => {
      const stats = getStats();
      console.log(`Server listening on http://localhost:${server.address().port} | Questions: ${stats.totalQuestions} | DB: ${dbInfo.mode}`);
      resolve(server);
    });
  });
}

if (require.main === module) {
  startServer(PORT).catch((err) => {
    console.error('Server boot error:', err);
    process.exit(1);
  });
}

module.exports = {
  app,
  server,
  startServer,
  getStageConfig,
  evaluateAnswer,
  SCORING_RULES
};
