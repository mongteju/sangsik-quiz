(() => {
  'use strict';

  const STORAGE_KEYS = {
    nickname: 'quiz_nickname',
    p1Name: 'quiz_p1_name',
    p2Name: 'quiz_p2_name',
    seenIds: 'quiz_seen_ids'
  };

  const CATEGORIES = [
    { id: 'all', name: '전체' },
    { id: 'movie', name: '영화' },
    { id: 'philosophy_lang', name: '철학·언어' },
    { id: 'history_geo', name: '역사·지리' },
    { id: 'science_tech', name: '과학·기술' },
    { id: 'society', name: '시사·사회' },
    { id: 'arts_life', name: '예술·생활' }
  ];

  const state = {
    ws: null,
    seenIds: [],

    // Selected categories
    soloCategory: 'all',
    duelCategory: 'all',
    rankingCategory: 'all',

    // Solo state
    soloSessionId: null,
    currentStage: null,
    stageOutcomes: [],
    soloQuestion: null,
    pendingNextSolo: null,
    pendingStageTransition: null,
    pendingSoloSummary: null,
    soloAnswered: false,
    soloRevealAt: 0,
    stageClearAt: 0,
    hintsLeft: { fiftyFifty: 1, editorial: 1 },
    usedHintOnCurrent: { fiftyFifty: false, editorial: false },

    // Local 2P Duel state
    duelId: null,
    p1Name: 'P1',
    p2Name: 'P2',
    duelQuestion: null,
    duelP1Choice: null,
    duelP2Choice: null,
    duelResolved: false,
    duelRevealAt: 0,
    pendingDuelNext: null,
    pendingDuelWinner: null,
    duelFinalP1: null,
    duelFinalP2: null,
    duelTotalRounds: 10,

    // Shared timer
    timerInterval: null,
    timerRemaining: 35,
    timerTotal: 35
  };

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatDateTime(iso) {
    if (!iso) return '-';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '-';
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${y}.${m}.${day} ${hh}:${mm}`;
  }

  let toastTimer = null;
  function showToast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 2400);
  }

  function showView(viewId) {
    $$('.view').forEach((v) => v.classList.toggle('active', v.id === viewId));
    window.scrollTo({ top: 0 });
  }

  // ------------------------------------------------------------
  // Category Selector Bars (Solo / Duel / Ranking)
  // ------------------------------------------------------------
  function renderCategoryBar(containerSel, activeId, onSelect) {
    const container = $(containerSel);
    container.innerHTML = CATEGORIES
      .map((c) => `
        <button type="button" class="cat-btn ${c.id === activeId ? 'active' : ''}" data-cat="${c.id}">
          ${escapeHtml(c.name)}
        </button>
      `)
      .join('');

    container.querySelectorAll('.cat-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.cat;
        container.querySelectorAll('.cat-btn').forEach((b) => b.classList.toggle('active', b.dataset.cat === id));
        onSelect(id);
      });
    });
  }

  function initCategoryBars() {
    renderCategoryBar('#soloCategoryBar', state.soloCategory, (id) => {
      state.soloCategory = id;
    });
    renderCategoryBar('#duelCategoryBar', state.duelCategory, (id) => {
      state.duelCategory = id;
    });
    renderCategoryBar('#rankingCategoryBar', state.rankingCategory, (id) => {
      state.rankingCategory = id;
      fetchRankings(id);
    });
  }

  // ------------------------------------------------------------
  // Local Storage Prefs
  // ------------------------------------------------------------
  function loadLocalPrefs() {
    $('#soloNameInput').value = localStorage.getItem(STORAGE_KEYS.nickname) || '';
    $('#p1NameInput').value = localStorage.getItem(STORAGE_KEYS.p1Name) || '';
    $('#p2NameInput').value = localStorage.getItem(STORAGE_KEYS.p2Name) || '';
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEYS.seenIds) || '[]');
      if (Array.isArray(parsed)) state.seenIds = parsed;
    } catch {
      state.seenIds = [];
    }
  }

  function recordSeenId(id) {
    if (!id || state.seenIds.includes(id)) return;
    state.seenIds.push(id);
    if (state.seenIds.length > 3500) state.seenIds = state.seenIds.slice(-3500);
    localStorage.setItem(STORAGE_KEYS.seenIds, JSON.stringify(state.seenIds));
  }

  // ------------------------------------------------------------
  // WebSocket (Real-Time 1P Ranking Sync)
  // ------------------------------------------------------------
  function connectWs() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}`);
    state.ws = ws;
    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (
          msg.type === 'RANKING_UPDATED' &&
          $('#view-ranking').classList.contains('active') &&
          (msg.category || 'all') === state.rankingCategory
        ) {
          renderRankings(msg.rankings || []);
        }
      } catch {
        // ignore
      }
    });
    ws.addEventListener('close', () => {
      setTimeout(() => {
        if (!state.ws || state.ws.readyState === WebSocket.CLOSED) connectWs();
      }, 2500);
    });
  }

  // ------------------------------------------------------------
  // Real-Time Ranking (1인 모드 전용 · 영역별 독립)
  // ------------------------------------------------------------
  async function openRanking(category = state.rankingCategory) {
    state.rankingCategory = category || 'all';
    renderCategoryBar('#rankingCategoryBar', state.rankingCategory, (id) => {
      state.rankingCategory = id;
      fetchRankings(id);
    });
    showView('view-ranking');
    await fetchRankings(state.rankingCategory);
  }

  async function fetchRankings(category = 'all') {
    try {
      const res = await fetch(`/api/rankings?category=${encodeURIComponent(category)}&limit=50`);
      const data = await res.json();
      renderRankings(data.rankings || []);
    } catch {
      showToast('랭킹을 불러오지 못했습니다.');
    }
  }

  function renderRankings(list) {
    const el = $('#rankingList');
    if (!list.length) {
      el.innerHTML = '<div class="empty-state">기록 없음</div>';
      return;
    }
    el.innerHTML = list
      .map((item) => `
        <div class="ranking-row ${item.rank <= 3 ? 'is-top' : ''}">
          <span class="ranking-rank">${item.rank}</span>
          <span class="ranking-name">${escapeHtml(item.nickname)}</span>
          <span class="ranking-stage">${escapeHtml(item.stageLabel)}</span>
          <span class="ranking-score">${Number(item.score).toLocaleString()}</span>
          <span class="ranking-date">${formatDateTime(item.createdAt)}</span>
        </div>
      `)
      .join('');
  }

  // ------------------------------------------------------------
  // Calm Timer (Zero Speed Bonus)
  // ------------------------------------------------------------
  function stopTimer() {
    if (state.timerInterval) {
      clearInterval(state.timerInterval);
      state.timerInterval = null;
    }
  }

  function startTimer(totalSec, displaySel, fillSel, onTimeout) {
    stopTimer();
    state.timerTotal = totalSec;
    state.timerRemaining = totalSec;

    const update = () => {
      const pct = Math.max(0, Math.min(100, (state.timerRemaining / state.timerTotal) * 100));
      const sec = Math.ceil(state.timerRemaining);
      const disp = $(displaySel);
      const fill = $(fillSel);
      if (disp) {
        disp.textContent = String(sec);
        disp.classList.toggle('urgent', sec <= 7);
      }
      if (fill) {
        fill.style.width = `${pct}%`;
        fill.classList.toggle('urgent', sec <= 7);
      }
    };

    update();
    const startAt = Date.now();
    state.timerInterval = setInterval(() => {
      state.timerRemaining = Math.max(0, totalSec - (Date.now() - startAt) / 1000);
      update();
      if (state.timerRemaining <= 0) {
        stopTimer();
        onTimeout();
      }
    }, 120);
  }

  // ------------------------------------------------------------
  // SOLO MODE (Stage Cutline Progression + Dynamic Sliding Cutline)
  // ------------------------------------------------------------
  function renderStagePips(outcomes, currentIndex, cutline, total = 10) {
    const html = [];
    for (let i = 0; i < total; i++) {
      let cls = 'pip';
      if (i < outcomes.length) cls += outcomes[i] ? ' ok' : ' no';
      else if (i === currentIndex) cls += ' current';
      html.push(`<span class="${cls}"></span>`);
    }
    $('#stagePips').innerHTML = html.join('');

    // Dynamic cutline marker: shifts +1 slot right for every wrong answer
    const wrongCount = outcomes.filter((v) => v === false).length;
    const correctCount = outcomes.filter((v) => v === true).length;
    const requiredSlot = cutline + wrongCount;
    const marker = $('#cutlineMarker');

    if (!marker) return;

    if (correctCount >= cutline) {
      // Already secured stage passage! Lock marker at the clinching pip in green
      let seenCorrect = 0;
      let clinchSlot = cutline;
      for (let i = 0; i < outcomes.length; i++) {
        if (outcomes[i]) {
          seenCorrect += 1;
          if (seenCorrect === cutline) {
            clinchSlot = i + 1;
            break;
          }
        }
      }
      marker.style.left = `${(clinchSlot / total) * 100}%`;
      marker.classList.add('passed');
      marker.classList.remove('impossible');
    } else if (requiredSlot > total) {
      // Passing is mathematically impossible now
      marker.style.left = '100%';
      marker.classList.add('impossible');
      marker.classList.remove('passed');
    } else {
      marker.style.left = `${(requiredSlot / total) * 100}%`;
      marker.classList.remove('passed', 'impossible');
    }
  }

  function updateSoloHints() {
    const b50 = $('#hint5050Btn');
    const bEd = $('#hintEditorialBtn');
    b50.textContent = `50:50 (${state.hintsLeft.fiftyFifty})`;
    bEd.textContent = `힌트 (${state.hintsLeft.editorial})`;
    b50.disabled = state.soloAnswered || state.usedHintOnCurrent.fiftyFifty || state.hintsLeft.fiftyFifty <= 0;
    bEd.disabled = state.soloAnswered || state.usedHintOnCurrent.editorial || state.hintsLeft.editorial <= 0;
  }

  function renderSoloQuestion(q) {
    state.soloQuestion = q;
    state.soloAnswered = false;
    state.usedHintOnCurrent = { fiftyFifty: false, editorial: false };
    recordSeenId(q.id);

    $('#stageLabel').textContent = q.stageLabel;
    $('#questionCounter').textContent = `${q.index + 1} / ${q.total}`;
    $('#cutlineTag').textContent = `통과 ${q.passCutline}`;
    $('#categoryTag').textContent = q.categoryName;
    $('#questionText').textContent = q.question;
    renderStagePips(state.stageOutcomes, q.index, q.passCutline, q.total);

    $('#hintText').classList.add('hidden');
    $('#hintText').textContent = '';
    $('#answerReveal').classList.add('hidden');
    updateSoloHints();

    const list = $('#choicesList');
    list.innerHTML = q.choices
      .map((choice, idx) => `
        <button type="button" class="choice-item" data-index="${idx}">
          <span class="choice-idx">${idx + 1}</span>
          <span class="choice-label">${escapeHtml(choice)}</span>
        </button>
      `)
      .join('');

    list.querySelectorAll('.choice-item').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (state.soloAnswered) return;
        submitSoloAnswer(Number(btn.dataset.index), false);
      });
    });

    startTimer(q.timeSec || 35, '#timerDisplay', '#timerFill', () => {
      if (!state.soloAnswered) submitSoloAnswer(-1, true);
    });
  }

  async function startSolo() {
    const raw = $('#soloNameInput').value.trim();
    localStorage.setItem(STORAGE_KEYS.nickname, raw);
    const nickname = raw || '익명';

    try {
      const res = await fetch('/api/quiz/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nickname,
          category: state.soloCategory,
          seenIds: state.seenIds
        })
      });
      const data = await res.json();
      if (!res.ok) return showToast(data.error || '시작 실패');

      state.soloSessionId = data.sessionId;
      state.currentStage = data.stage;
      state.stageOutcomes = [];
      state.hintsLeft = data.hintsLeft;
      state.pendingNextSolo = null;
      state.pendingStageTransition = null;
      state.pendingSoloSummary = null;

      $('#soloScoreDisplay').textContent = '0';
      showView('view-quiz');
      renderSoloQuestion(data.question);
    } catch {
      showToast('서버 연결 실패');
    }
  }

  async function requestSoloHint(type) {
    if (state.soloAnswered) return;
    try {
      const res = await fetch('/api/quiz/hint', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: state.soloSessionId, type })
      });
      const data = await res.json();
      if (!res.ok) return;
      state.hintsLeft = data.hintsLeft;
      if (type === 'fiftyFifty') {
        state.usedHintOnCurrent.fiftyFifty = true;
        (data.removedIndices || []).forEach((idx) => {
          const btn = $(`#choicesList .choice-item[data-index="${idx}"]`);
          if (btn) { btn.classList.add('eliminated'); btn.disabled = true; }
        });
      } else {
        state.usedHintOnCurrent.editorial = true;
        $('#hintText').textContent = data.hintText;
        $('#hintText').classList.remove('hidden');
      }
      updateSoloHints();
    } catch {
      // ignore
    }
  }

  async function submitSoloAnswer(choiceIndex, timedOut) {
    if (state.soloAnswered) return;
    state.soloAnswered = true;
    stopTimer();

    $$('#choicesList .choice-item').forEach((btn) => {
      btn.disabled = true;
      if (!timedOut && Number(btn.dataset.index) === choiceIndex) btn.classList.add('selected');
    });
    updateSoloHints();

    try {
      const res = await fetch('/api/quiz/answer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: state.soloSessionId, choiceIndex, timedOut })
      });
      const data = await res.json();
      if (!res.ok) return;

      const r = data.result;
      state.stageOutcomes = data.stageOutcomes || state.stageOutcomes;
      state.hintsLeft = data.hintsLeft;
      state.pendingNextSolo = data.nextQuestion;
      state.pendingStageTransition = data.stageTransition;
      state.pendingSoloSummary = data.summary;

      $('#soloScoreDisplay').textContent = Number(data.totalScore).toLocaleString();
      renderStagePips(state.stageOutcomes, -1, state.soloQuestion.passCutline, state.soloQuestion.total);

      const correctBtn = $(`#choicesList .choice-item[data-index="${r.answerIndex}"]`);
      if (correctBtn) correctBtn.classList.add('correct');
      if (!r.isCorrect && !r.timedOut) {
        const wrongBtn = $(`#choicesList .choice-item[data-index="${r.selectedIndex}"]`);
        if (wrongBtn) wrongBtn.classList.add('wrong');
      }

      const verdict = $('#revealVerdict');
      verdict.textContent = r.isCorrect ? '정답' : r.timedOut ? '시간 종료' : '오답';
      verdict.className = `reveal-verdict ${r.isCorrect ? 'ok' : 'no'}`;
      $('#revealPoints').textContent = r.pointsEarned > 0 ? `+${r.pointsEarned}` : '';
      $('#revealExplanation').textContent = r.explanation;

      const nextBtn = $('#nextQuestionBtn');
      nextBtn.textContent = data.finished ? '결과' : data.stageTransition?.passed ? '다음 단계' : '다음';
      $('#answerReveal').classList.remove('hidden');
      state.soloRevealAt = Date.now();
    } catch {
      showToast('채점 실패');
    }
  }

  function advanceSolo() {
    if (state.pendingSoloSummary) {
      showSoloResult(state.pendingSoloSummary);
      return;
    }
    if (state.pendingStageTransition?.passed) {
      const tr = state.pendingStageTransition;
      $('#clearedLabel').textContent = `${tr.completedStage.label} 통과`;
      $('#clearedRatio').textContent = `${tr.stageCorrect} / ${tr.completedStage.count}`;
      $('#nextStagePreview').textContent = `${tr.nextStage.label} · ${tr.nextStage.passCutline}개 이상 통과`;
      state.stageOutcomes = [];
      state.currentStage = tr.nextStage;
      state.stageClearAt = Date.now();
      showView('view-stage-clear');
      return;
    }
    if (state.pendingNextSolo) {
      renderSoloQuestion(state.pendingNextSolo);
    }
  }

  function showSoloResult(summary) {
    stopTimer();
    const prefix = summary.category && summary.category !== 'all' ? `${summary.categoryName} · ` : '';
    $('#resultTitle').textContent = `${prefix}${summary.stageLabel} 종료`;
    $('#resultScore').textContent = Number(summary.score).toLocaleString();

    const rankText = summary.rankPosition ? `${summary.rankPosition}위` : '-';
    const bestTag = summary.isPersonalBest ? '최고 기록' : `최고 ${Number(summary.bestScore).toLocaleString()}`;
    $('#resultMetaRow').innerHTML = `
      <span>영역<strong>${escapeHtml(summary.categoryName || '전체')}</strong></span>
      <span>단계<strong>${escapeHtml(summary.stageLabel)}</strong></span>
      <span>정답<strong>${summary.correctCount} / ${summary.totalCount}</strong></span>
      <span>순위<strong>${rankText}</strong></span>
      <span><strong>${bestTag}</strong></span>
    `;

    state.rankingCategory = summary.category || 'all';
    $('#retrySoloBtn').classList.remove('hidden');
    $('#retryDuelBtn').classList.add('hidden');
    $('#resultRankingBtn').classList.remove('hidden');
    showView('view-result');
  }

  // ------------------------------------------------------------
  // LOCAL OFFLINE 2-PLAYER DUEL
  // ------------------------------------------------------------
  async function startLocalDuel() {
    const p1Raw = $('#p1NameInput').value.trim();
    const p2Raw = $('#p2NameInput').value.trim();
    localStorage.setItem(STORAGE_KEYS.p1Name, p1Raw);
    localStorage.setItem(STORAGE_KEYS.p2Name, p2Raw);

    const p1Name = p1Raw || 'P1';
    const p2Name = p2Raw || 'P2';

    try {
      const res = await fetch('/api/duel/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          p1Name,
          p2Name,
          category: state.duelCategory,
          seenIds: state.seenIds
        })
      });
      const data = await res.json();
      if (!res.ok) return showToast(data.error || '시작 실패');

      state.duelId = data.duelId;
      state.p1Name = data.p1.name;
      state.p2Name = data.p2.name;
      state.pendingDuelNext = null;
      state.pendingDuelWinner = null;

      $('#duelP1Label').textContent = state.p1Name;
      $('#duelP2Label').textContent = state.p2Name;
      $('#duelP1ColName').textContent = state.p1Name;
      $('#duelP2ColName').textContent = state.p2Name;
      $('#duelP1Score').textContent = '0';
      $('#duelP2Score').textContent = '0';

      showView('view-duel');
      renderDuelQuestion(data.question);
    } catch {
      showToast('서버 연결 실패');
    }
  }

  function renderDuelQuestion(q) {
    state.duelQuestion = q;
    state.duelP1Choice = null;
    state.duelP2Choice = null;
    state.duelResolved = false;
    recordSeenId(q.id);

    const roundEl = $('#duelRoundLabel');
    if (q.isOvertime) {
      roundEl.textContent = `연장 ${q.overtimeRound}`;
      roundEl.classList.add('overtime');
    } else {
      roundEl.textContent = `${q.roundIndex + 1} / ${q.baseRounds}`;
      roundEl.classList.remove('overtime');
    }

    $('#duelCategoryTag').textContent = q.categoryName;
    $('#duelQuestionText').textContent = q.question;
    $('#duelP1State').textContent = '';
    $('#duelP2State').textContent = '';
    $('#duelP1Col').classList.remove('locked-hidden');
    $('#duelP2Col').classList.remove('locked-hidden');
    $('#duelReveal').classList.add('hidden');

    const renderChoices = (containerSel, playerKey) => {
      const container = $(containerSel);
      container.innerHTML = q.choices
        .map((choice, idx) => `
          <button type="button" class="choice-item" data-player="${playerKey}" data-index="${idx}">
            <span class="choice-idx">${idx + 1}</span>
            <span class="choice-label">${escapeHtml(choice)}</span>
          </button>
        `)
        .join('');

      container.querySelectorAll('.choice-item').forEach((btn) => {
        btn.addEventListener('click', () => {
          selectDuelChoice(playerKey, Number(btn.dataset.index));
        });
      });
    };

    renderChoices('#duelP1Choices', 'p1');
    renderChoices('#duelP2Choices', 'p2');

    startTimer(q.timeSec || 35, '#duelTimerDisplay', '#duelTimerFill', () => {
      if (!state.duelResolved) resolveLocalDuelRound();
    });
  }

  function selectDuelChoice(playerKey, choiceIdx) {
    if (state.duelResolved) return;
    if (playerKey === 'p1') {
      if (state.duelP1Choice !== null) return;
      state.duelP1Choice = choiceIdx;
      $('#duelP1State').textContent = '선택 완료';
      if (state.duelP2Choice === null) $('#duelP1Col').classList.add('locked-hidden');
    } else {
      if (state.duelP2Choice !== null) return;
      state.duelP2Choice = choiceIdx;
      $('#duelP2State').textContent = '선택 완료';
      if (state.duelP1Choice === null) $('#duelP2Col').classList.add('locked-hidden');
    }

    if (state.duelP1Choice !== null && state.duelP2Choice !== null) {
      resolveLocalDuelRound();
    }
  }

  async function resolveLocalDuelRound() {
    if (state.duelResolved) return;
    state.duelResolved = true;
    stopTimer();

    $('#duelP1Col').classList.remove('locked-hidden');
    $('#duelP2Col').classList.remove('locked-hidden');
    $$('#duelP1Choices .choice-item, #duelP2Choices .choice-item').forEach((b) => { b.disabled = true; });

    try {
      const res = await fetch('/api/duel/answer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          duelId: state.duelId,
          p1Choice: state.duelP1Choice === null ? -1 : state.duelP1Choice,
          p2Choice: state.duelP2Choice === null ? -1 : state.duelP2Choice
        })
      });
      const data = await res.json();
      if (!res.ok) return;

      const r = data.result;
      $('#duelP1Score').textContent = Number(data.p1.score).toLocaleString();
      $('#duelP2Score').textContent = Number(data.p2.score).toLocaleString();

      const p1CorrectBtn = $(`#duelP1Choices .choice-item[data-index="${r.answerIndex}"]`);
      if (p1CorrectBtn) p1CorrectBtn.classList.add('correct');
      if (!r.p1.isCorrect && r.p1.choiceIndex >= 0) {
        const p1Wrong = $(`#duelP1Choices .choice-item[data-index="${r.p1.choiceIndex}"]`);
        if (p1Wrong) p1Wrong.classList.add('wrong');
      }
      $('#duelP1State').textContent = r.p1.isCorrect ? `+${r.p1.pointsEarned}` : '오답';

      const p2CorrectBtn = $(`#duelP2Choices .choice-item[data-index="${r.answerIndex}"]`);
      if (p2CorrectBtn) p2CorrectBtn.classList.add('correct');
      if (!r.p2.isCorrect && r.p2.choiceIndex >= 0) {
        const p2Wrong = $(`#duelP2Choices .choice-item[data-index="${r.p2.choiceIndex}"]`);
        if (p2Wrong) p2Wrong.classList.add('wrong');
      }
      $('#duelP2State').textContent = r.p2.isCorrect ? `+${r.p2.pointsEarned}` : '오답';

      $('#duelRevealSummary').innerHTML = `
        <span class="${r.p1.isCorrect ? 'ok' : 'no'}">${escapeHtml(state.p1Name)} ${r.p1.isCorrect ? `+${r.p1.pointsEarned}` : '오답'}</span>
        <span class="${r.p2.isCorrect ? 'ok' : 'no'}">${escapeHtml(state.p2Name)} ${r.p2.isCorrect ? `+${r.p2.pointsEarned}` : '오답'}</span>
      `;
      $('#duelRevealExplanation').textContent = r.explanation;

      state.pendingDuelNext = data.nextQuestion;
      state.pendingDuelWinner = data.finished ? data.winner : null;
      state.duelFinalP1 = data.p1;
      state.duelFinalP2 = data.p2;
      state.duelTotalRounds = data.totalRoundsPlayed;

      const nextBtn = $('#nextDuelBtn');
      if (data.finished) nextBtn.textContent = '결과';
      else if (data.nextQuestion?.isOvertime) nextBtn.textContent = `연장 ${data.nextQuestion.overtimeRound}`;
      else nextBtn.textContent = '다음';

      $('#duelReveal').classList.remove('hidden');
      state.duelRevealAt = Date.now();
    } catch {
      showToast('채점 실패');
    }
  }

  function advanceDuel() {
    if (state.pendingDuelWinner) {
      const winnerName = state.pendingDuelWinner === 'p1' ? state.p1Name : state.p2Name;
      $('#resultTitle').textContent = `${winnerName} 승리`;
      $('#resultScore').textContent = `${Number(state.duelFinalP1.score).toLocaleString()} : ${Number(state.duelFinalP2.score).toLocaleString()}`;
      $('#resultMetaRow').innerHTML = `
        <span>${escapeHtml(state.p1Name)}<strong>${state.duelFinalP1.correct} / ${state.duelTotalRounds}</strong></span>
        <span>${escapeHtml(state.p2Name)}<strong>${state.duelFinalP2.correct} / ${state.duelTotalRounds}</strong></span>
      `;
      $('#retrySoloBtn').classList.add('hidden');
      $('#resultRankingBtn').classList.add('hidden');
      $('#retryDuelBtn').classList.remove('hidden');
      showView('view-result');
      return;
    }
    if (state.pendingDuelNext) {
      renderDuelQuestion(state.pendingDuelNext);
    }
  }

  // ------------------------------------------------------------
  // Events & Keyboard / Left-Click Fast Advance
  // ------------------------------------------------------------
  function bindEvents() {
    $('#goSoloBtn').addEventListener('click', () => {
      showView('view-solo-entry');
      $('#soloNameInput').focus();
    });

    $('#goDuelBtn').addEventListener('click', () => {
      showView('view-duel-entry');
      $('#p1NameInput').focus();
    });

    $('#goRankingBtn').addEventListener('click', () => openRanking('all'));
    $('#resultRankingBtn').addEventListener('click', () => openRanking(state.rankingCategory));

    $$('.back-btn[data-back]').forEach((btn) => {
      btn.addEventListener('click', () => showView(btn.dataset.back));
    });

    $('#startSoloBtn').addEventListener('click', startSolo);
    $('#soloNameInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') startSolo();
    });

    $('#startDuelBtn').addEventListener('click', startLocalDuel);
    $('#p1NameInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('#p2NameInput').focus();
    });
    $('#p2NameInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') startLocalDuel();
    });

    $('#quitSoloBtn').addEventListener('click', () => {
      stopTimer();
      showView('view-home');
    });

    $('#quitDuelBtn').addEventListener('click', () => {
      stopTimer();
      showView('view-home');
    });

    $('#hint5050Btn').addEventListener('click', () => requestSoloHint('fiftyFifty'));
    $('#hintEditorialBtn').addEventListener('click', () => requestSoloHint('editorial'));
    $('#nextQuestionBtn').addEventListener('click', advanceSolo);
    $('#nextDuelBtn').addEventListener('click', advanceDuel);

    $('#continueStageBtn').addEventListener('click', () => {
      state.pendingStageTransition = null;
      showView('view-quiz');
      if (state.pendingNextSolo) renderSoloQuestion(state.pendingNextSolo);
    });

    $('#retrySoloBtn').addEventListener('click', startSolo);
    $('#retryDuelBtn').addEventListener('click', startLocalDuel);
    $('#resultHomeBtn').addEventListener('click', () => showView('view-home'));

    document.addEventListener('keydown', (e) => {
      if (document.activeElement?.tagName === 'INPUT') return;

      if ($('#view-stage-clear').classList.contains('active') && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        if (Date.now() - state.stageClearAt > 120) $('#continueStageBtn').click();
        return;
      }

      if ($('#view-quiz').classList.contains('active')) {
        if (!state.soloAnswered && ['1', '2', '3', '4'].includes(e.key)) {
          const btn = $(`#choicesList .choice-item[data-index="${Number(e.key) - 1}"]`);
          if (btn && !btn.disabled) btn.click();
        } else if (
          state.soloAnswered &&
          (e.key === 'Enter' || e.key === ' ') &&
          !$('#answerReveal').classList.contains('hidden')
        ) {
          e.preventDefault();
          if (Date.now() - state.soloRevealAt > 120) advanceSolo();
        }
        return;
      }

      if ($('#view-duel').classList.contains('active')) {
        if (!state.duelResolved) {
          if (e.code === 'Digit1' || e.code === 'Digit2' || e.code === 'Digit3' || e.code === 'Digit4') {
            selectDuelChoice('p1', Number(e.code.slice(-1)) - 1);
          } else if (e.code === 'Numpad1' || e.code === 'Numpad2' || e.code === 'Numpad3' || e.code === 'Numpad4') {
            selectDuelChoice('p2', Number(e.code.slice(-1)) - 1);
          } else if (e.code === 'Digit7') selectDuelChoice('p2', 0);
          else if (e.code === 'Digit8') selectDuelChoice('p2', 1);
          else if (e.code === 'Digit9') selectDuelChoice('p2', 2);
          else if (e.code === 'Digit0') selectDuelChoice('p2', 3);
        } else if (
          (e.key === 'Enter' || e.key === ' ') &&
          !$('#duelReveal').classList.contains('hidden')
        ) {
          e.preventDefault();
          if (Date.now() - state.duelRevealAt > 120) advanceDuel();
        }
      }
    });

    document.addEventListener('click', (e) => {
      if (e.button !== 0 || e.target.closest('button')) return;

      if ($('#view-stage-clear').classList.contains('active')) {
        if (Date.now() - state.stageClearAt > 150) $('#continueStageBtn').click();
        return;
      }

      if (
        $('#view-quiz').classList.contains('active') &&
        state.soloAnswered &&
        !$('#answerReveal').classList.contains('hidden')
      ) {
        if (Date.now() - state.soloRevealAt > 150) advanceSolo();
        return;
      }

      if (
        $('#view-duel').classList.contains('active') &&
        state.duelResolved &&
        !$('#duelReveal').classList.contains('hidden')
      ) {
        if (Date.now() - state.duelRevealAt > 150) advanceDuel();
      }
    });
  }

  loadLocalPrefs();
  initCategoryBars();
  bindEvents();
  connectWs();
})();
