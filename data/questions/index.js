const introEasyRaw = require('./intro_easy');
const introExtraRaw = require('./intro_extra');
const beginnerEasyRaw = require('./beginner_easy');
const {
  polishKoreanText,
  rebalanceDifficulty,
  isBoringClone,
  normalizeAnswerKey,
  extractSubjectKey,
  getTemplateSignature
} = require('./rebalance');
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

const movieGen = require('./generators/movie_gen');
const philosophyLangGen = require('./generators/philosophy_lang_gen');
const historyGeoGen = require('./generators/history_geo_gen');
const scienceTechGen = require('./generators/science_tech_gen');
const societyGen = require('./generators/society_gen');
const artsLifeGen = require('./generators/arts_life_gen');

const CATEGORIES = [
  { id: 'movie', name: '영화', en: 'MOVIE' },
  { id: 'philosophy_lang', name: '철학·언어', en: 'PHILOSOPHY_LANG' },
  { id: 'history_geo', name: '역사·지리', en: 'HISTORY_GEO' },
  { id: 'science_tech', name: '과학·기술', en: 'SCIENCE_TECH' },
  { id: 'society', name: '시사·사회', en: 'SOCIETY' },
  { id: 'arts_life', name: '예술·생활', en: 'ARTS_LIFE' }
];

const CATEGORY_MAP = new Map(CATEGORIES.map((c) => [c.id, c]));

const LEGACY_CAT_MAP = {
  humanities: 'philosophy_lang',
  language: 'philosophy_lang',
  history: 'history_geo',
  geography: 'history_geo',
  science: 'science_tech',
  tech: 'science_tech',
  society: 'society',
  arts: 'arts_life',
  lifestyle: 'arts_life',
  sports: 'arts_life'
};

const MOVIE_RE = /영화|아카데미|황금종려|황금사자|황금곰|봉준호|기생충|올드보이|칸 국제|오스카|애니메이션|겨울왕국|팝콘|감독|할리우드|시네마/;

function mapLegacyCategory(oldCatId, questionText) {
  if (oldCatId === 'arts' && MOVIE_RE.test(questionText || '')) {
    return 'movie';
  }
  return LEGACY_CAT_MAP[oldCatId] || 'society';
}

const DIFFICULTY_META = {
  intro: { id: 'intro', name: '입문', en: 'INTRO', basePoints: 80, timeSec: 35 },
  beginner: { id: 'beginner', name: '초급', en: 'STANDARD', basePoints: 100, timeSec: 35 },
  intermediate: { id: 'intermediate', name: '중급', en: 'NATIONAL', basePoints: 150, timeSec: 35 },
  advanced: { id: 'advanced', name: '고급', en: 'CHIEF EDITOR', basePoints: 200, timeSec: 40 }
};

const DIFF_ALIAS = {
  intro: 'intro',
  n: 'intro',
  beginner: 'beginner',
  b: 'beginner',
  intermediate: 'intermediate',
  i: 'intermediate',
  advanced: 'advanced',
  a: 'advanced'
};

const ALL_QUESTIONS = [];
const QUESTION_BY_ID = new Map();
const SEEN_PROMPTS = new Set();
const SEEN_ANSWERS = new Set();
const SEEN_SUBJECTS = new Set();

function addQuestion({ id, catId, difficulty, question, answer, distractors, hint, explanation }) {
  const cat = CATEGORY_MAP.get(catId);
  const rawDiff = DIFF_ALIAS[difficulty] || 'intermediate';
  if (!cat || !question || !answer) return;

  const qClean = polishKoreanText(question);
  const aClean = polishKoreanText(answer);
  if (isBoringClone(id, qClean, aClean)) return;

  const normPrompt = qClean.replace(/\s+/g, '');
  if (SEEN_PROMPTS.has(normPrompt)) return;

  // Strict semantic deduplication: 1 unique answer & 1 unique quoted subject per category
  const ansKey = normalizeAnswerKey(cat.id, aClean);
  if (SEEN_ANSWERS.has(ansKey)) return;

  const subjKey = extractSubjectKey(cat.id, qClean);
  if (subjKey && SEEN_SUBJECTS.has(subjKey)) return;

  const cleanDistractors = Array.from(
    new Set((distractors || []).map((d) => polishKoreanText(d)).filter((d) => d && d !== aClean))
  );
  if (cleanDistractors.length < 4) return;

  const diff = rebalanceDifficulty({
    id,
    category: cat.id,
    difficulty: rawDiff,
    question: qClean,
    answer: aClean
  });

  SEEN_PROMPTS.add(normPrompt);
  SEEN_ANSWERS.add(ansKey);
  if (subjKey) SEEN_SUBJECTS.add(subjKey);

  const meta = DIFFICULTY_META[diff];
  const qObj = {
    id,
    category: cat.id,
    categoryName: cat.name,
    categoryEn: cat.en,
    difficulty: diff,
    difficultyName: meta.name,
    difficultyEn: meta.en,
    basePoints: meta.basePoints,
    timeSec: meta.timeSec,
    templateSig: getTemplateSignature(qClean),
    question: qClean,
    answer: aClean,
    distractors: cleanDistractors,
    hint: polishKoreanText(hint),
    explanation: polishKoreanText(explanation)
  };
  ALL_QUESTIONS.push(qObj);
  QUESTION_BY_ID.set(id, qObj);
}

// 1. Load legacy curated intro & beginner sets mapped to 6 categories
introEasyRaw.forEach((row, idx) => {
  const [oldCat, question, answer, distractors, hint, explanation] = row;
  addQuestion({
    id: `cur-intro-${String(idx + 1).padStart(4, '0')}`,
    catId: mapLegacyCategory(oldCat, question),
    difficulty: 'intro',
    question,
    answer,
    distractors,
    hint,
    explanation
  });
});

introExtraRaw.forEach((row, idx) => {
  const [catId, question, answer, distractors, hint, explanation] = row;
  addQuestion({
    id: `intro-extra-${String(idx + 1).padStart(4, '0')}`,
    catId,
    difficulty: 'intro',
    question,
    answer,
    distractors,
    hint,
    explanation
  });
});

beginnerEasyRaw.forEach((row, idx) => {
  const [oldCat, question, answer, distractors, hint, explanation] = row;
  addQuestion({
    id: `cur-beg-${String(idx + 1).padStart(4, '0')}`,
    catId: mapLegacyCategory(oldCat, question),
    difficulty: 'beginner',
    question,
    answer,
    distractors,
    hint,
    explanation
  });
});

// 2. Load legacy 10 curated intermediate/advanced sets mapped to 6 categories
const LEGACY_RAW = {
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

for (const [oldCat, rows] of Object.entries(LEGACY_RAW)) {
  rows.forEach((row, idx) => {
    const [diffCode, question, answer, distractors, hint, explanation] = row;
    const difficulty = diffCode === 'a' || diffCode === 'advanced' ? 'advanced' : 'intermediate';
    addQuestion({
      id: `cur-${oldCat}-${String(idx + 1).padStart(4, '0')}`,
      catId: mapLegacyCategory(oldCat, question),
      difficulty,
      question,
      answer,
      distractors,
      hint,
      explanation
    });
  });
}

// 3. Load all 6 large-scale structured-fact generators (13,500+ additional unique verified questions)
const GENERATORS = [
  ['movie', movieGen],
  ['philosophy_lang', philosophyLangGen],
  ['history_geo', historyGeoGen],
  ['science_tech', scienceTechGen],
  ['society', societyGen],
  ['arts_life', artsLifeGen]
];

for (const [catId, genFn] of GENERATORS) {
  const generated = typeof genFn === 'function' ? genFn() : [];
  generated.forEach((row, idx) => {
    const [diffCode, question, answer, distractors, hint, explanation] = row;
    addQuestion({
      id: `gen-${catId}-${String(idx + 1).padStart(5, '0')}`,
      catId,
      difficulty: diffCode,
      question,
      answer,
      distractors,
      hint,
      explanation
    });
  });
}

// Pre-index pools by (category, difficulty) for O(1) lookup across 15,000+ questions
const POOLS = new Map();
for (const q of ALL_QUESTIONS) {
  const keys = [
    `all::${q.difficulty}`,
    `${q.category}::${q.difficulty}`
  ];
  for (const k of keys) {
    if (!POOLS.has(k)) POOLS.set(k, []);
    POOLS.get(k).push(q);
  }
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

function selectQuestions({ difficulty = 'intro', category = 'all', count = 10, seenIds = [] }) {
  const seenSet = new Set(Array.isArray(seenIds) ? seenIds : []);
  const safeCat = CATEGORY_MAP.has(category) ? category : 'all';
  const pool = POOLS.get(`${safeCat}::${difficulty}`) || POOLS.get(`all::${difficulty}`) || [];

  // Sample efficiently without sorting the entire 15,000 array unnecessarily
  const unseen = [];
  const seen = [];
  for (const q of pool) {
    if (seenSet.has(q.id)) seen.push(q);
    else unseen.push(q);
  }

  const pickDiverse = (list, needed, usedIds, usedTpls, catCounts, lastCatRef) => {
    const shuffled = shuffleArray(list);
    const out = [];

    // Multi-pass greedy diversity picker:
    // Pass 1: fresh template (0 used) + different category from previous + balanced category count
    // Pass 2: max 1 of same template + different category
    // Pass 3: any remaining unused item
    const passes = [
      (q) => !usedIds.has(q.id) && (usedTpls.get(q.templateSig) || 0) === 0 && (safeCat !== 'all' || q.category !== lastCatRef.cat) && (safeCat !== 'all' || (catCounts.get(q.category) || 0) < Math.ceil(count / CATEGORIES.length)),
      (q) => !usedIds.has(q.id) && (usedTpls.get(q.templateSig) || 0) === 0 && (safeCat !== 'all' || q.category !== lastCatRef.cat),
      (q) => !usedIds.has(q.id) && (usedTpls.get(q.templateSig) || 0) <= 1 && (safeCat !== 'all' || q.category !== lastCatRef.cat),
      (q) => !usedIds.has(q.id) && (usedTpls.get(q.templateSig) || 0) <= 1,
      (q) => !usedIds.has(q.id)
    ];

    while (out.length < needed) {
      let pickedOne = null;
      for (const pred of passes) {
        pickedOne = shuffled.find(pred);
        if (pickedOne) break;
      }
      if (!pickedOne) break;
      out.push(pickedOne);
      usedIds.add(pickedOne.id);
      usedTpls.set(pickedOne.templateSig, (usedTpls.get(pickedOne.templateSig) || 0) + 1);
      catCounts.set(pickedOne.category, (catCounts.get(pickedOne.category) || 0) + 1);
      lastCatRef.cat = pickedOne.category;
    }
    return out;
  };

  const usedIds = new Set();
  const usedTpls = new Map();
  const catCounts = new Map();
  const lastCatRef = { cat: null };
  const picked = pickDiverse(unseen, count, usedIds, usedTpls, catCounts, lastCatRef);
  if (picked.length < count) {
    picked.push(...pickDiverse(seen, count - picked.length, usedIds, usedTpls, catCounts, lastCatRef));
  }
  return picked.map(materializeQuestion);
}

function getStats() {
  const byCategory = {};
  const byDifficulty = { intro: 0, beginner: 0, intermediate: 0, advanced: 0 };
  for (const cat of CATEGORIES) {
    byCategory[cat.id] = { name: cat.name, en: cat.en, total: 0, intro: 0, beginner: 0, intermediate: 0, advanced: 0 };
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
