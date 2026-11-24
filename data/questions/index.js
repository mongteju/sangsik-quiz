const beginnerEasyRaw = require('./beginner_easy');
const historyRaw = require('./history');
const scienceRaw = require('./science');
const humanitiesRaw = require('./humanities');
const geographyRaw = require('./geography');
const artsRaw = require('./arts');
const societyRaw = require('./society');
const languageRaw = require('./language');
const lifestyleRaw = require('./lifestyle');
const sportsRaw = require('./sports');
const techRaw = require('./tech');

const CATEGORIES = [
  { id: 'history', name: '역사·세계사', shortName: '역사', en: 'HISTORY' },
  { id: 'science', name: '과학·자연', shortName: '과학', en: 'SCIENCE' },
  { id: 'humanities', name: '문학·인문·철학', shortName: '인문', en: 'HUMANITIES' },
  { id: 'geography', name: '지리·세계문화', shortName: '지리', en: 'GEOGRAPHY' },
  { id: 'arts', name: '예술·대중문화', shortName: '예술', en: 'ARTS' },
  { id: 'society', name: '시사·경제·상식', shortName: '시사', en: 'SOCIETY' },
  { id: 'language', name: '우리말·속담·한자', shortName: '우리말', en: 'LANGUAGE' },
  { id: 'lifestyle', name: '음식·생활·건강', shortName: '생활', en: 'LIFESTYLE' },
  { id: 'sports', name: '스포츠·레저', shortName: '스포츠', en: 'SPORTS' },
  { id: 'tech', name: 'IT·기술·발명', shortName: '기술', en: 'TECH' }
];

const CATEGORY_MAP = new Map(CATEGORIES.map((c) => [c.id, c]));

const DIFFICULTY_META = {
  beginner: { id: 'beginner', name: '초급', en: 'STANDARD', basePoints: 100, timeSec: 35 },
  intermediate: { id: 'intermediate', name: '중급', en: 'NATIONAL', basePoints: 150, timeSec: 35 },
  advanced: { id: 'advanced', name: '고급', en: 'CHIEF EDITOR', basePoints: 200, timeSec: 40 }
};

const RAW_BY_CATEGORY = {
  history: historyRaw,
  science: scienceRaw,
  humanities: humanitiesRaw,
  geography: geographyRaw,
  arts: artsRaw,
  society: societyRaw,
  language: languageRaw,
  lifestyle: lifestyleRaw,
  sports: sportsRaw,
  tech: techRaw
};

const ALL_QUESTIONS = [];
const QUESTION_BY_ID = new Map();
const SEEN_PROMPTS = new Set();

function addQuestion({ id, cat, difficulty, question, answer, distractors, hint, explanation }) {
  const norm = question.replace(/\s+/g, '');
  if (SEEN_PROMPTS.has(norm)) return;
  SEEN_PROMPTS.add(norm);

  const qObj = {
    id,
    category: cat.id,
    categoryName: cat.name,
    categoryEn: cat.en,
    difficulty,
    difficultyName: DIFFICULTY_META[difficulty].name,
    difficultyEn: DIFFICULTY_META[difficulty].en,
    basePoints: DIFFICULTY_META[difficulty].basePoints,
    timeSec: DIFFICULTY_META[difficulty].timeSec,
    question,
    answer,
    distractors: Array.from(new Set(distractors.filter((d) => d && d !== answer))),
    hint,
    explanation
  };
  ALL_QUESTIONS.push(qObj);
  QUESTION_BY_ID.set(id, qObj);
}

// 1. Load truly accessible everyday beginner pool (250 questions, 25 per category)
beginnerEasyRaw.forEach((row, idx) => {
  const [catId, question, answer, distractors, hint, explanation] = row;
  const cat = CATEGORY_MAP.get(catId);
  if (!cat) return;
  addQuestion({
    id: `easy-${catId}-${String(idx + 1).padStart(3, '0')}`,
    cat,
    difficulty: 'beginner',
    question,
    answer,
    distractors,
    hint,
    explanation
  });
});

// 2. Load the 10 curated category archives:
//    Previous 'b' & 'i' rows become rich 'intermediate' (700 questions),
//    and 'a' rows remain 'advanced' (350 questions).
for (const cat of CATEGORIES) {
  const rows = RAW_BY_CATEGORY[cat.id] || [];
  rows.forEach((row, idx) => {
    const [diffCode, question, answer, distractors, hint, explanation] = row;
    const difficulty = diffCode === 'a' || diffCode === 'advanced' ? 'advanced' : 'intermediate';
    addQuestion({
      id: `${cat.id}-${difficulty[0]}-${String(idx + 1).padStart(3, '0')}`,
      cat,
      difficulty,
      question,
      answer,
      distractors,
      hint,
      explanation
    });
  });
}

function shuffleArray(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function materializeQuestion(q) {
  const sampledDistractors = shuffleArray(q.distractors).slice(0, 3);
  const choices = shuffleArray([q.answer, ...sampledDistractors]);
  const answerIndex = choices.indexOf(q.answer);
  return {
    id: q.id,
    category: q.category,
    categoryName: q.categoryName,
    categoryEn: q.categoryEn,
    difficulty: q.difficulty,
    difficultyName: q.difficultyName,
    difficultyEn: q.difficultyEn,
    basePoints: q.basePoints,
    timeSec: q.timeSec,
    question: q.question,
    choices,
    answerIndex,
    answer: q.answer,
    hint: q.hint,
    explanation: q.explanation
  };
}

function selectQuestions({ difficulty = 'progressive', category = 'all', count = 10, seenIds = [] }) {
  const seenSet = new Set(Array.isArray(seenIds) ? seenIds : []);

  const pickFromPool = (pool, needed) => {
    const unseen = shuffleArray(pool.filter((q) => !seenSet.has(q.id)));
    const seen = shuffleArray(pool.filter((q) => seenSet.has(q.id)));
    const ordered = [...unseen, ...seen];

    if (category === 'all' && ordered.length > needed) {
      const selected = [];
      const usedIds = new Set();
      let lastCat = null;
      for (let i = 0; i < ordered.length && selected.length < needed; i++) {
        const candidate = ordered.find((q) => !usedIds.has(q.id) && q.category !== lastCat)
          || ordered.find((q) => !usedIds.has(q.id));
        if (!candidate) break;
        selected.push(candidate);
        usedIds.add(candidate.id);
        lastCat = candidate.category;
      }
      return selected;
    }
    return ordered.slice(0, needed);
  };

  const basePool = category === 'all'
    ? ALL_QUESTIONS
    : ALL_QUESTIONS.filter((q) => q.category === category);

  if (difficulty === 'progressive') {
    const bCount = Math.floor(count / 3);
    const iCount = Math.floor(count / 3);
    const aCount = count - bCount - iCount;
    const bQs = pickFromPool(basePool.filter((q) => q.difficulty === 'beginner'), bCount);
    const iQs = pickFromPool(basePool.filter((q) => q.difficulty === 'intermediate'), iCount);
    const aQs = pickFromPool(basePool.filter((q) => q.difficulty === 'advanced'), aCount);
    return [...bQs, ...iQs, ...aQs].map(materializeQuestion);
  }

  const filtered = basePool.filter((q) => q.difficulty === difficulty);
  return pickFromPool(filtered, count).map(materializeQuestion);
}

function getStats() {
  const byCategory = {};
  const byDifficulty = { beginner: 0, intermediate: 0, advanced: 0 };
  for (const cat of CATEGORIES) {
    byCategory[cat.id] = { name: cat.name, en: cat.en, total: 0, beginner: 0, intermediate: 0, advanced: 0 };
  }
  for (const q of ALL_QUESTIONS) {
    byCategory[q.category].total += 1;
    byCategory[q.category][q.difficulty] += 1;
    byDifficulty[q.difficulty] += 1;
  }
  return {
    totalQuestions: ALL_QUESTIONS.length,
    categories: CATEGORIES,
    difficulties: DIFFICULTY_META,
    byCategory,
    byDifficulty
  };
}

module.exports = {
  CATEGORIES,
  DIFFICULTY_META,
  ALL_QUESTIONS,
  QUESTION_BY_ID,
  selectQuestions,
  materializeQuestion,
  getStats
};
