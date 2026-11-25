/**
 * Korean particle/typo polisher + strict 4-tier difficulty rebalancer.
 * Guarantees that:
 *   1. 'intro' (입문) contains ONLY genuinely simple, everyday household-name questions
 *   2. 'beginner' (초급) contains accessible everyday / school-level general knowledge
 *   3. 'intermediate' (중급) contains solid adult trivia & textbook fundamentals
 *   4. 'advanced' (고급) contains specialized / deep knowledge
 *   5. All clunky Korean particles like 을(를), 은(는), 이(가), 과(와) are resolved cleanly.
 */

function hasBatchim(str) {
  if (!str) return false;
  // Find the last meaningful Hangul / alphanumeric char ignoring closing brackets/quotes
  const cleaned = str.replace(/[\s'"`’”)\]>》」』.,?!~]+$/g, '');
  if (!cleaned) return false;
  const ch = cleaned[cleaned.length - 1];
  const code = ch.charCodeAt(0);
  // Hangul syllable block
  if (code >= 0xac00 && code <= 0xd7a3) {
    return (code - 0xac00) % 28 !== 0;
  }
  // Digits: 0(영), 1(일), 3(삼), 6(육), 7(칠), 8(팔) have batchim; 2,4,5,9 do not
  if (/[013678]/.test(ch)) return true;
  if (/[2459]/.test(ch)) return false;
  // Common English final consonants pronounced with coda in Korean loanwords
  if (/[lmnrLMNR]/.test(ch)) return true;
  return false;
}

function polishKoreanText(text) {
  if (!text) return '';
  let s = String(text);

  // Fix clunky paired particles with accurate Hangul jongseong detection
  s = s.replace(/([^\s]+?)을\(를\)/g, (_, prev) => prev + (hasBatchim(prev) ? '을' : '를'));
  s = s.replace(/([^\s]+?)를\(을\)/g, (_, prev) => prev + (hasBatchim(prev) ? '을' : '를'));
  s = s.replace(/([^\s]+?)은\(는\)/g, (_, prev) => prev + (hasBatchim(prev) ? '은' : '는'));
  s = s.replace(/([^\s]+?)는\(은\)/g, (_, prev) => prev + (hasBatchim(prev) ? '은' : '는'));
  s = s.replace(/([^\s]+?)이\(가\)/g, (_, prev) => prev + (hasBatchim(prev) ? '이' : '가'));
  s = s.replace(/([^\s]+?)가\(이\)/g, (_, prev) => prev + (hasBatchim(prev) ? '이' : '가'));
  s = s.replace(/([^\s]+?)과\(와\)/g, (_, prev) => prev + (hasBatchim(prev) ? '과' : '와'));
  s = s.replace(/([^\s]+?)와\(과\)/g, (_, prev) => prev + (hasBatchim(prev) ? '과' : '와'));
  s = s.replace(/([^\s]+?)\(으\)로/g, (_, prev) => {
    const cleaned = prev.replace(/[\s'"`’”)\]>》」』.,?!~]+$/g, '');
    const last = cleaned[cleaned.length - 1] || '';
    const code = last.charCodeAt(0);
    const jong = code >= 0xac00 && code <= 0xd7a3 ? (code - 0xac00) % 28 : 0;
    // ㄹ 받침 (jong === 8) or no batchim uses '로'
    if (!hasBatchim(prev) || jong === 8) return prev + '로';
    return prev + '으로';
  });

  // Fix minor generator typos found during audit
  s = s.replace(/영화\s+한국\s+영화/g, '한국 영화');
  s = s.replace(/영화\s+영화/g, '영화');
  s = s.replace(/피겨 여왕로/g, '피겨 여왕으로');
  s = s.replace(/\s{2,}/g, ' ').trim();
  return s;
}

// ---------------------------------------------------------------------------
// Strict Domain-Aware Difficulty Calibration
// ---------------------------------------------------------------------------
const ALWAYS_HARD_RE = /원자번호|ISO\s*4217|통화\s*코드|포트\s*번호|상태\s*코드|상태코드|HTTP|TCP|UDP|DNS|VPN|EUV|FinFET|GAA|HBM|DRAM|NAND|양자역학|불확정성|불완전성|상대성\s*이론|슈뢰딩거|하이젠베르크|미토콘드리아|소포체|리보솜|골지체|추간판|어문\s*규범|표준\s*용언|음운\s*변동|형태소|어족|방법적\s*회의|정언\s*명령|정언명령|변증법|현상학|실존주의|구조주의|공리주의|인식론|존재론|형이상학|원천징수|결정세액|파생상품|공매도|지니계수|베블런|스노브|밴드왜건|필리버스터|일사부재리|죄형법정|소멸시효|공소시효|몬트리올|람사르|바젤\s*협약|교토\s*의정서|성부|판소리\s*5마당|토리|바로크|로코코|인상주의|입체주의|초현실주의|야수파|표현주의|네오리얼리즘|누벨바그|미장센|몽타주|맥거핀|시네마토그래피|라그랑주|토카막|CCUS|알고리즘|복잡도|빅오|트랜스포머|강화학습|역전파|과적합/;

const NEVER_INTRO_RE = /연도|몇\s*년|년대|세기|원소|주기율표|화합물|화학식|법칙|정리|SI\s*단위|단위\s*기호|물리량|중력\s*가속도|생물학적으로|몇\s*번째\s*행성|호르몬|효소|질환|증후군|신화\s*체계|문학\s*사조|저서|명제|철학자|사상가|학파|사자성어|고사성어|순우리말|맞춤법|외래어\s*표기|한자\s*음훈|훈민정음|조약|협약|의정서|헌법|형사|민법|행정법|공직선거법|거시경제|미시경제|경제·무역|경제·금융|금융·증권|국제기구|약어|통화\s*단위|화폐\s*단위|수도.*어디|수도로\s*두고|도청\s*소재지|발원지|해협|운하|해구|고봉|국립공원|수중릉|군주|국왕|절대왕정|시대와\s*관련|대성당|재위|군포|대표적인\s*업적|베른|캔버라|오타와|제\d+회|작곡한\s*음악가|그린\s*화가|조각\s*대표작|건축\s*양식|식문화|향신료|파이토케미컬|절기|올림픽이\s*개최된|롱코스|에\s*대한\s*설명으로\s*가장\s*알맞은|감독|연기한\s*배우|개봉한|제작\s*국가|출신국|수상작|영화제|대표\s*캐릭터\s*이름/;

// Household-name mega-popular entities allowed in intro for short clean prompts
const INTRO_MEGA_MOVIE_RE = /기생충|겨울왕국|라이온\s*킹|해리\s*포터|타이타닉|어벤져스|아이언맨|스파이더맨|토이\s*스토리|인사이드\s*아웃|아바타|알라딘|신데렐라|미녀와\s*야수|인어공주|슈렉|쿵푸팬더|이웃집\s*토토로|센과\s*치히로|명량|극한직업|부산행|범죄도시|주토피아|코코|미니언즈|나\s*홀로\s*집에|쥬라기\s*공원|스타워즈|쿠키\s*영상|스포일러|카메오|팝콘|예고편|자막|더빙|뽀로로|둘리|도라에몽|톰과\s*제리|미키\s*마우스|곰돌이\s*푸/;

const INTRO_TOP_COUNTRIES_RE = /대한민국|한국|일본|중국|미국|영국|프랑스|이탈리아|독일|호주|브라질|이집트|인도|러시아|스위스/;

const BEGINNER_PROMOTE_TO_INT_RE = /원자번호\s*(?:2[1-9]|[3-9]\d|1\d\d)|희토류|란타넘|악티늄|ISO|포트|프로토콜|협약|의정서|조약|법정\s*통화|통화\s*코드|어문\s*규범|음운|성부|장단|토리|국립공원|발원지|해구|연대|몇\s*년|개봉|출신국|사조|학파|저서|중심\s*인물/;

const INT_PROMOTE_TO_ADV_RE = /원자번호\s*(?:3[7-9]|[4-9]\d|1\d\d)|희토류|란타넘|악티늄|초우라늄|ISO\s*4217|불완전성|불확정성|에미\s*뇌터|갈루아|라마누잔|리만\s*가설|푸앵카레|허준이|미르자하니|괴델|베르그송|하이데거|데리다|푸코|비트겐슈타인|아렌트|롤스|스피노자|라이프니츠|쇼펜하우어|키르케고르|네오리얼리즘|누벨바그|미장센|트뤼포|고다르|펠리니|타르코프스키|베르히만|구로사와|오즈\s*야스지로|왕가위|키에슬로프스키|바젤|람사르|몬트리올|브레턴우즈|플라자\s*합의|파생상품|스왑|옵션|선물\s*거래|공매도|PER|PBR|ROE|EPS|EBITDA|양적완화|테이퍼링|스태그플레이션|죄형법정|일사부재리|기판력|소멸시효|행정심판|국악\s*이론|정악|시나위|산조|판소리|오페라|교향곡\s*제\d+번/;

function rebalanceDifficulty({ id, category, difficulty, question, answer }) {
  // 1. Hand-curated anchor datasets keep their exact intentional tier!
  if (id.startsWith('cur-intro-') || id.startsWith('intro-extra-')) {
    return 'intro';
  }
  if (id.startsWith('cur-beg-')) {
    return 'beginner';
  }

  const text = `${question} ${answer}`;
  let diff = difficulty;

  // 2. Enforce strict 'intro' (입문) purity on generated questions
  if (diff === 'intro') {
    const tooLong = question.length > 56 || answer.length > 16;
    const hasHardTerms = ALWAYS_HARD_RE.test(text);
    const hasNonIntroTerms = NEVER_INTRO_RE.test(text);

    if (hasHardTerms) {
      diff = 'intermediate';
    } else if (tooLong || hasNonIntroTerms) {
      // Exceptions: ultra-famous simple questions (e.g. "도쿄를 수도로 두고 있는 나라는?" or "일본의 수도는?")
      const isSimpleTopCountryCapital =
        category === 'history_geo' &&
        question.length <= 32 &&
        INTRO_TOP_COUNTRIES_RE.test(text) &&
        /(수도|도쿄|베이징|파리|런던|로마|서울|에펠탑|만리장성|피라미드|후지산)/.test(text) &&
        !/화폐|통화|대륙|지역/.test(question);

      const isSimpleProverbBlank =
        category === 'philosophy_lang' &&
        question.length <= 45 &&
        /속담.*빈칸|빈칸.*속담/.test(question) &&
        answer.length <= 6;

      const isSimpleMegaMovie =
        category === 'movie' &&
        question.length <= 54 &&
        INTRO_MEGA_MOVIE_RE.test(text) &&
        !/감독|배우|연도|년대|수상|영화제|국가/.test(question);

      if (isSimpleTopCountryCapital || isSimpleProverbBlank || isSimpleMegaMovie) {
        diff = 'intro';
      } else if (question.length > 68 || answer.length > 22 || /에\s*대한\s*설명으로/.test(question)) {
        diff = 'intermediate';
      } else {
        diff = 'beginner';
      }
    } else {
      // Even if short, generated questions in philosophy_lang / society / science_tech / movie / arts_life
      // must be genuinely everyday to stay in 'intro'
      if (category === 'movie' && !INTRO_MEGA_MOVIE_RE.test(text)) {
        diff = 'beginner';
      } else if (category === 'philosophy_lang' && !/속담|빈칸|동화|신데렐라|백설공주|피노키오|흥부|심청|춘향|홍길동|소크라테스|공자|어린\s*왕자/.test(text)) {
        diff = 'beginner';
      } else if (category === 'society' && !/112|119|어린이날|어버이날|스승의\s*날|크리스마스|식목일|은행|우체국|도서관|병원|약국|여권|영수증|경찰|소방|대통령|국회의원|유엔|UN/.test(text)) {
        diff = 'beginner';
      } else if (category === 'science_tech' && !/태양|달|지구|물|얼음|수증기|산소|봄|여름|가을|겨울|동쪽|서쪽|북쪽|남쪽|무지개|공룡|고래|코끼리|기린|판다|캥거루|개구리|나비|스마트폰|유튜브|노트북|마우스|키보드|와이파이|블루투스|인공지능|AI|Ctrl/.test(text)) {
        diff = 'beginner';
      } else if (category === 'arts_life' && !/피아노|바이올린|드럼|기타|하모니카|아리랑|김치|비빔밥|떡국|송편|떡볶이|김밥|라면|피자|초밥|축구|야구|농구|배구|탁구|수영|양궁|스키|볼링|금메달|올림픽|모나리자|베토벤|모차르트|김연아/.test(text)) {
        diff = 'beginner';
      } else if (category === 'history_geo' && !INTRO_TOP_COUNTRIES_RE.test(text) && !/세종대왕|이순신|거북선|태극기|애국가|한글|경복궁|한복|한옥|제주도|한라산|백두산|독도|한강|부산|서울|광복절|삼일절|개천절|고조선|고구려|백제|신라|고려|조선/.test(text)) {
        diff = 'beginner';
      }
    }
  }

  // 3. Calibrate 'beginner' (초급) — push technical/obscure/long definitions up to intermediate/advanced
  if (diff === 'beginner') {
    if (ALWAYS_HARD_RE.test(text)) {
      diff = INT_PROMOTE_TO_ADV_RE.test(text) ? 'advanced' : 'intermediate';
    } else if (
      question.length > 68 ||
      answer.length > 22 ||
      BEGINNER_PROMOTE_TO_INT_RE.test(text) ||
      /에\s*대한\s*설명으로\s*가장\s*알맞은/.test(question)
    ) {
      diff = 'intermediate';
    }
  }

  // 4. Calibrate 'intermediate' (중급) — push deeply specialized items up to advanced
  if (diff === 'intermediate' && INT_PROMOTE_TO_ADV_RE.test(text)) {
    diff = 'advanced';
  }

  return diff;
}

const BORING_CLONE_RE = /처음\s*개봉한\s*연대는|어느\s*나라를\s*대표하는\s*영화|어느\s*대륙에\s*속한|어느\s*시대와\s*관련|어느\s*신화\s*체계에\s*등장|어느\s*예술\s*사조에\s*속하|에\s*대한\s*설명으로\s*가장\s*알맞은|올바른\s*뜻풀이는\s*무엇인가요|올바른\s*뜻은\s*무엇인가요|대표적인\s*업적이나\s*저서로\s*옳은|대표적인\s*업적\s*또는\s*관련\s*사건으로\s*옳은|원자번호\s*\d+번에\s*해당하는|원소\s*기호\s*[A-Za-z]+\s*[이가]\s*나타내는/;

function isBoringClone(id, question, answer) {
  const isCurated = id.startsWith('cur-') || id.startsWith('intro-extra-');
  if (isCurated) return false;
  if (BORING_CLONE_RE.test(question)) return true;
  if (answer.length > 24) return true;
  // Drop tautological language giveaways like "인도네시아의 공용어는? -> 인도네시아어"
  if (/공용어/.test(question) && answer.endsWith('어')) {
    const stem = answer.slice(0, -1).trim();
    if (stem.length >= 2 && question.includes(stem)) return true;
  }
  return false;
}

function normalizeAnswerKey(category, answer) {
  return `${category}::${String(answer || '').replace(/\s*\(.*?\)/g, '').replace(/\s+/g, '').toLowerCase()}`;
}

function extractSubjectKey(category, question) {
  const m = String(question || '').match(/'([^']{2,25})'|《([^》]{2,25})》|<([^>]{2,25})>/);
  if (!m) return null;
  const raw = (m[1] || m[2] || m[3]).replace(/\s+/g, '').toLowerCase();
  return `${category}::${raw}`;
}

function getTemplateSignature(question) {
  const txt = String(question || '');
  if (/연출한\s*감독|감독은/.test(txt)) return 'tpl:movie-dir';
  if (/연기한\s*배우|배우\s/.test(txt)) return 'tpl:movie-actor';
  if (/대표\s*캐릭터/.test(txt)) return 'tpl:movie-char';
  if (/영화\s*용어/.test(txt)) return 'tpl:movie-term';
  if (/OST|주제가|영화음악/.test(txt)) return 'tpl:ost';
  if (/명대사/.test(txt)) return 'tpl:quote';
  if (/영화제|시상식|수상/.test(txt)) return 'tpl:award';
  if (/원작/.test(txt)) return 'tpl:adapt';
  if (/사자성어|고사성어/.test(txt)) return 'tpl:idiom';
  if (/속담|관용구/.test(txt)) return 'tpl:proverb';
  if (/순우리말/.test(txt)) return 'tpl:pure-kr';
  if (/맞춤법|표준어|어문\s*규범/.test(txt)) return 'tpl:spelling';
  if (/수도/.test(txt)) return 'tpl:capital';
  if (/화폐|통화/.test(txt)) return 'tpl:currency';
  if (/원소|주기율표/.test(txt)) return 'tpl:element';
  if (/그린\s*화가|명화/.test(txt)) return 'tpl:painting';
  if (/작곡한/.test(txt)) return 'tpl:composer';
  if (/올림픽/.test(txt)) return 'tpl:olympic';
  if (/국제기구|협약|의정서/.test(txt)) return 'tpl:intl';
  if (/절기/.test(txt)) return 'tpl:solar-term';
  if (/단축키/.test(txt)) return 'tpl:shortcut';
  if (/수학자/.test(txt)) return 'tpl:math';
  if (/철학자|사상가/.test(txt)) return 'tpl:philosopher';
  if (/문학|소설|희곡/.test(txt)) return 'tpl:literature';
  if (/음식|요리/.test(txt)) return 'tpl:food';
  return 'tpl:free:' + txt.replace(/'[^']+'|《[^》]+》|<[^>]+>|"[^"]+"/g, 'X').replace(/\d+/g, 'N').slice(0, 12);
}

module.exports = {
  polishKoreanText,
  rebalanceDifficulty,
  isBoringClone,
  normalizeAnswerKey,
  extractSubjectKey,
  getTemplateSignature
};
