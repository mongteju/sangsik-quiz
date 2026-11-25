const fs = require('fs');
const path = require('path');

function loadDotEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}

loadDotEnv();

const SQLITE_PATH = path.join(__dirname, 'data', 'quiz.db');

let mode = 'sqlite';
let sqliteDb = null;
let pgPool = null;

function mapRow(row) {
  return {
    id: row.id,
    nickname: row.nickname,
    category: row.category || 'all',
    score: Number(row.score),
    stageReached: Number(row.stage_reached),
    stageLabel: row.stage_label,
    correctCount: Number(row.correct_count),
    totalCount: Number(row.total_count),
    accuracy: Number(row.accuracy),
    noHintCorrect: Number(row.no_hint_correct),
    maxStreak: Number(row.max_streak),
    createdAt: row.created_at
  };
}

function isBetterRecord(candidate, existing) {
  if (candidate.score !== existing.score) return candidate.score > existing.score;
  if (candidate.stageReached !== existing.stageReached) return candidate.stageReached > existing.stageReached;
  if (candidate.accuracy !== existing.accuracy) return candidate.accuracy > existing.accuracy;
  if (candidate.noHintCorrect !== existing.noHintCorrect) return candidate.noHintCorrect > existing.noHintCorrect;
  if (candidate.maxStreak !== existing.maxStreak) return candidate.maxStreak > existing.maxStreak;
  return false;
}

async function deduplicateByNicknameAndCategory() {
  let rows;
  if (mode === 'postgres') {
    const res = await pgPool.query(
      `SELECT * FROM rankings
       ORDER BY score DESC, stage_reached DESC, accuracy DESC, no_hint_correct DESC, max_streak DESC, created_at ASC`
    );
    rows = res.rows.map(mapRow);
  } else {
    rows = sqliteDb.prepare(
      `SELECT * FROM rankings
       ORDER BY score DESC, stage_reached DESC, accuracy DESC, no_hint_correct DESC, max_streak DESC, created_at ASC`
    ).all().map(mapRow);
  }

  const seen = new Set();
  for (const row of rows) {
    const key = `${row.nickname}::${row.category || 'all'}`;
    if (seen.has(key)) {
      await deleteRanking(row.id);
    } else {
      seen.add(key);
    }
  }
}

async function initDb() {
  if (process.env.DATABASE_URL) {
    const { Pool } = require('pg');
    pgPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false }
    });
    mode = 'postgres';
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS rankings (
        id TEXT PRIMARY KEY,
        nickname TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'all',
        score INTEGER NOT NULL,
        stage_reached INTEGER NOT NULL,
        stage_label TEXT NOT NULL,
        correct_count INTEGER NOT NULL,
        total_count INTEGER NOT NULL,
        accuracy REAL NOT NULL,
        no_hint_correct INTEGER NOT NULL,
        max_streak INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      ALTER TABLE rankings ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'all';
      CREATE INDEX IF NOT EXISTS idx_rankings_cat_order
        ON rankings (category, score DESC, stage_reached DESC, accuracy DESC, no_hint_correct DESC, max_streak DESC, created_at ASC);
      CREATE INDEX IF NOT EXISTS idx_rankings_nick_cat ON rankings (nickname, category);
    `);
    await deduplicateByNicknameAndCategory();
    return { mode };
  }

  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(path.dirname(SQLITE_PATH), { recursive: true });
  sqliteDb = new DatabaseSync(SQLITE_PATH);
  mode = 'sqlite';
  sqliteDb.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS rankings (
      id TEXT PRIMARY KEY,
      nickname TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'all',
      score INTEGER NOT NULL,
      stage_reached INTEGER NOT NULL,
      stage_label TEXT NOT NULL,
      correct_count INTEGER NOT NULL,
      total_count INTEGER NOT NULL,
      accuracy REAL NOT NULL,
      no_hint_correct INTEGER NOT NULL,
      max_streak INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  // Safe migration for existing SQLite databases created before category column
  const cols = sqliteDb.prepare('PRAGMA table_info(rankings)').all();
  if (!cols.some((c) => c.name === 'category')) {
    sqliteDb.exec(`ALTER TABLE rankings ADD COLUMN category TEXT NOT NULL DEFAULT 'all';`);
  }

  sqliteDb.exec(`
    CREATE INDEX IF NOT EXISTS idx_rankings_cat_order
      ON rankings (category, score DESC, stage_reached DESC, accuracy DESC, no_hint_correct DESC, max_streak DESC, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_rankings_nick_cat ON rankings (nickname, category);
  `);

  await deduplicateByNicknameAndCategory();
  return { mode, path: SQLITE_PATH };
}

async function findByNicknameAndCategory(nickname, category = 'all') {
  const cat = category || 'all';
  if (mode === 'postgres') {
    const res = await pgPool.query(
      'SELECT * FROM rankings WHERE nickname = $1 AND category = $2 LIMIT 1',
      [nickname, cat]
    );
    return res.rows[0] ? mapRow(res.rows[0]) : null;
  }
  const row = sqliteDb
    .prepare('SELECT * FROM rankings WHERE nickname = ? AND category = ? LIMIT 1')
    .get(nickname, cat);
  return row ? mapRow(row) : null;
}

async function upsertBestRanking(entry) {
  const category = entry.category || 'all';
  const normalized = { ...entry, category };
  const existing = await findByNicknameAndCategory(normalized.nickname, category);

  if (!existing) {
    if (mode === 'postgres') {
      await pgPool.query(
        `INSERT INTO rankings (
          id, nickname, category, score, stage_reached, stage_label,
          correct_count, total_count, accuracy, no_hint_correct, max_streak, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          normalized.id, normalized.nickname, category, normalized.score,
          normalized.stageReached, normalized.stageLabel, normalized.correctCount,
          normalized.totalCount, normalized.accuracy, normalized.noHintCorrect,
          normalized.maxStreak, normalized.createdAt
        ]
      );
    } else {
      sqliteDb.prepare(`
        INSERT INTO rankings (
          id, nickname, category, score, stage_reached, stage_label,
          correct_count, total_count, accuracy, no_hint_correct, max_streak, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        normalized.id, normalized.nickname, category, normalized.score,
        normalized.stageReached, normalized.stageLabel, normalized.correctCount,
        normalized.totalCount, normalized.accuracy, normalized.noHintCorrect,
        normalized.maxStreak, normalized.createdAt
      );
    }
    return { saved: true, updated: false, isPersonalBest: true, record: normalized };
  }

  if (isBetterRecord(normalized, existing)) {
    const updatedRecord = { ...normalized, id: existing.id };
    if (mode === 'postgres') {
      await pgPool.query(
        `UPDATE rankings
         SET score = $1, stage_reached = $2, stage_label = $3,
             correct_count = $4, total_count = $5, accuracy = $6,
             no_hint_correct = $7, max_streak = $8, created_at = $9
         WHERE id = $10`,
        [
          updatedRecord.score, updatedRecord.stageReached, updatedRecord.stageLabel,
          updatedRecord.correctCount, updatedRecord.totalCount, updatedRecord.accuracy,
          updatedRecord.noHintCorrect, updatedRecord.maxStreak, updatedRecord.createdAt,
          existing.id
        ]
      );
    } else {
      sqliteDb.prepare(`
        UPDATE rankings
        SET score = ?, stage_reached = ?, stage_label = ?,
            correct_count = ?, total_count = ?, accuracy = ?,
            no_hint_correct = ?, max_streak = ?, created_at = ?
        WHERE id = ?
      `).run(
        updatedRecord.score, updatedRecord.stageReached, updatedRecord.stageLabel,
        updatedRecord.correctCount, updatedRecord.totalCount, updatedRecord.accuracy,
        updatedRecord.noHintCorrect, updatedRecord.maxStreak, updatedRecord.createdAt,
        existing.id
      );
    }
    return { saved: true, updated: true, isPersonalBest: true, record: updatedRecord };
  }

  return { saved: false, updated: false, isPersonalBest: false, record: existing };
}

async function getTopRankings(limit = 50, category = 'all') {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 1000));
  const cat = category || 'all';
  if (mode === 'postgres') {
    const res = await pgPool.query(
      `SELECT * FROM rankings
       WHERE category = $1
       ORDER BY score DESC, stage_reached DESC, accuracy DESC, no_hint_correct DESC, max_streak DESC, created_at ASC
       LIMIT $2`,
      [cat, safeLimit]
    );
    return res.rows.map((r, i) => ({ rank: i + 1, ...mapRow(r) }));
  }

  const stmt = sqliteDb.prepare(`
    SELECT * FROM rankings
    WHERE category = ?
    ORDER BY score DESC, stage_reached DESC, accuracy DESC, no_hint_correct DESC, max_streak DESC, created_at ASC
    LIMIT ?
  `);
  return stmt.all(cat, safeLimit).map((r, i) => ({ rank: i + 1, ...mapRow(r) }));
}

async function getRankPositionByNickname(nickname, category = 'all') {
  const all = await getTopRankings(500, category);
  const idx = all.findIndex((r) => r.nickname === nickname);
  return idx === -1 ? null : idx + 1;
}

async function deleteRanking(id) {
  if (mode === 'postgres') {
    await pgPool.query('DELETE FROM rankings WHERE id = $1', [id]);
    return;
  }
  sqliteDb.prepare('DELETE FROM rankings WHERE id = ?').run(id);
}

async function deleteRankingByNickname(nickname) {
  if (mode === 'postgres') {
    await pgPool.query('DELETE FROM rankings WHERE nickname = $1', [nickname]);
    return;
  }
  sqliteDb.prepare('DELETE FROM rankings WHERE nickname = ?').run(nickname);
}

async function closeDb() {
  if (pgPool) {
    await pgPool.end();
    pgPool = null;
  }
  if (sqliteDb) {
    sqliteDb.close();
    sqliteDb = null;
  }
}

function getDbMode() {
  return mode;
}

module.exports = {
  initDb,
  upsertBestRanking,
  findByNicknameAndCategory,
  getTopRankings,
  getRankPositionByNickname,
  deleteRanking,
  deleteRankingByNickname,
  closeDb,
  getDbMode,
  isBetterRecord
};
