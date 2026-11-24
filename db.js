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

/**
 * Returns true if candidate is strictly better than existing record (zero speed factor).
 */
function isBetterRecord(candidate, existing) {
  if (candidate.score !== existing.score) return candidate.score > existing.score;
  if (candidate.stageReached !== existing.stageReached) return candidate.stageReached > existing.stageReached;
  if (candidate.accuracy !== existing.accuracy) return candidate.accuracy > existing.accuracy;
  if (candidate.noHintCorrect !== existing.noHintCorrect) return candidate.noHintCorrect > existing.noHintCorrect;
  if (candidate.maxStreak !== existing.maxStreak) return candidate.maxStreak > existing.maxStreak;
  return false;
}

async function deduplicateByNickname() {
  const all = await getTopRankings(1000);
  const seen = new Set();
  for (const row of all) {
    if (seen.has(row.nickname)) {
      await deleteRanking(row.id);
    } else {
      seen.add(row.nickname);
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
      CREATE INDEX IF NOT EXISTS idx_rankings_order
        ON rankings (score DESC, stage_reached DESC, accuracy DESC, no_hint_correct DESC, max_streak DESC, created_at ASC);
      CREATE INDEX IF NOT EXISTS idx_rankings_nickname ON rankings (nickname);
    `);
    await deduplicateByNickname();
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
    CREATE INDEX IF NOT EXISTS idx_rankings_order
      ON rankings (score DESC, stage_reached DESC, accuracy DESC, no_hint_correct DESC, max_streak DESC, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_rankings_nickname ON rankings (nickname);
  `);
  await deduplicateByNickname();
  return { mode, path: SQLITE_PATH };
}

async function findByNickname(nickname) {
  if (mode === 'postgres') {
    const res = await pgPool.query('SELECT * FROM rankings WHERE nickname = $1 LIMIT 1', [nickname]);
    return res.rows[0] ? mapRow(res.rows[0]) : null;
  }
  const row = sqliteDb.prepare('SELECT * FROM rankings WHERE nickname = ? LIMIT 1').get(nickname);
  return row ? mapRow(row) : null;
}

/**
 * Upserts a ranking record for a nickname:
 * - Inserts if nickname does not exist yet
 * - Overwrites existing record ONLY if the new score/record is strictly higher
 * - Keeps existing record untouched if new score is equal or lower
 */
async function upsertBestRanking(entry) {
  const existing = await findByNickname(entry.nickname);

  if (!existing) {
    if (mode === 'postgres') {
      await pgPool.query(
        `INSERT INTO rankings (
          id, nickname, score, stage_reached, stage_label,
          correct_count, total_count, accuracy, no_hint_correct, max_streak, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          entry.id, entry.nickname, entry.score, entry.stageReached, entry.stageLabel,
          entry.correctCount, entry.totalCount, entry.accuracy, entry.noHintCorrect,
          entry.maxStreak, entry.createdAt
        ]
      );
    } else {
      sqliteDb.prepare(`
        INSERT INTO rankings (
          id, nickname, score, stage_reached, stage_label,
          correct_count, total_count, accuracy, no_hint_correct, max_streak, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        entry.id, entry.nickname, entry.score, entry.stageReached, entry.stageLabel,
        entry.correctCount, entry.totalCount, entry.accuracy, entry.noHintCorrect,
        entry.maxStreak, entry.createdAt
      );
    }
    return { saved: true, updated: false, isPersonalBest: true, record: entry };
  }

  if (isBetterRecord(entry, existing)) {
    const updatedRecord = { ...entry, id: existing.id };
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

async function getTopRankings(limit = 50) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 1000));
  if (mode === 'postgres') {
    const res = await pgPool.query(
      `SELECT * FROM rankings
       ORDER BY score DESC, stage_reached DESC, accuracy DESC, no_hint_correct DESC, max_streak DESC, created_at ASC
       LIMIT $1`,
      [safeLimit]
    );
    return res.rows.map((r, i) => ({ rank: i + 1, ...mapRow(r) }));
  }

  const stmt = sqliteDb.prepare(`
    SELECT * FROM rankings
    ORDER BY score DESC, stage_reached DESC, accuracy DESC, no_hint_correct DESC, max_streak DESC, created_at ASC
    LIMIT ?
  `);
  return stmt.all(safeLimit).map((r, i) => ({ rank: i + 1, ...mapRow(r) }));
}

async function getRankPositionByNickname(nickname) {
  const all = await getTopRankings(500);
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
  findByNickname,
  getTopRankings,
  getRankPositionByNickname,
  deleteRanking,
  deleteRankingByNickname,
  closeDb,
  getDbMode,
  isBetterRecord
};
