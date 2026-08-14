/* =============================================================
   ONE THING, SERVER CORE
   Pure, dependency-free business logic. This module is the ONLY
   place that decides XP, streaks, assignment and eligibility.
   PRD §96: "The frontend displays state. The backend determines state."

   In production every function here runs inside a Postgres RPC or an
   Edge Function. The prototype calls the identical functions so the
   logic is proven once, not twice (PRD §95: no duplicated business logic).
   ============================================================= */

// ---------- date primitives ----------
// All day maths is done on CALENDAR DATE STRINGS, never on epoch deltas.
// FIX (crack #2): epoch arithmetic breaks on DST, a "day" can be 23h or 25h.

function pad(n) { return n < 10 ? '0' + n : '' + n; }

/** Local calendar date for a user, honouring a configurable day-start hour.
 *  dayStartHour = 0 is the literal calendar day the PRD specifies (§16).
 *  dayStartHour = 4 is the opt-in "night owl" boundary (see FIX #3). */
function localDate(utcMs, tzOffsetMin, dayStartHour) {
  dayStartHour = dayStartHour || 0;
  const shifted = utcMs + tzOffsetMin * 60000 - dayStartHour * 3600000;
  const d = new Date(shifted);
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
}

function parseDate(s) {
  const p = s.split('-').map(Number);
  return Date.UTC(p[0], p[1] - 1, p[2], 12, 0, 0); // noon anchor: DST-proof
}

function addDays(s, n) {
  const d = new Date(parseDate(s) + n * 86400000);
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
}

function daysBetween(a, b) { return Math.round((parseDate(b) - parseDate(a)) / 86400000); }

// ---------- level curve ----------
// FIX (crack #13): the PRD names six levels but defines no thresholds and
// no answer for what a 365-day user does at max level. Levels continue past
// Polymath with a repeating band so long-term users still see movement.
const LEVEL_NAMES = ['Curious', 'Explorer', 'Learner', 'Thinker', 'Scholar', 'Polymath'];
const LEVEL_THRESHOLDS = [0, 300, 900, 2000, 4200, 8000];

function levelFor(xp) {
  let i = 0;
  while (i + 1 < LEVEL_THRESHOLDS.length && xp >= LEVEL_THRESHOLDS[i + 1]) i++;
  if (i === LEVEL_THRESHOLDS.length - 1) {
    // Polymath II, III … every 6000 XP beyond the last threshold.
    const over = Math.floor((xp - LEVEL_THRESHOLDS[i]) / 6000);
    const next = LEVEL_THRESHOLDS[i] + (over + 1) * 6000;
    const prev = LEVEL_THRESHOLDS[i] + over * 6000;
    return {
      level: 6 + over,
      name: LEVEL_NAMES[5] + (over ? ' ' + roman(over + 1) : ''),
      floor: prev, ceiling: next,
      progress: (xp - prev) / (next - prev)
    };
  }
  const prev = LEVEL_THRESHOLDS[i], next = LEVEL_THRESHOLDS[i + 1];
  return {
    level: i + 1, name: LEVEL_NAMES[i], floor: prev, ceiling: next,
    progress: (xp - prev) / (next - prev)
  };
}
function roman(n) { return ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'][n] || ('x' + n); }

// ---------- recommendation ----------
// FIX (crack #22): the PRD scores "- Previously Seen" as a penalty. On a
// one-item-per-day product a repeat is 100% of that day, so seen content is
// a HARD FILTER, not a subtraction. Score only ranks eligible candidates.

// Adjacency is the tier-1 fallback, so every topic offered in onboarding MUST
// appear here, and every name used here MUST be a real topic. A topic missing
// from this map silently collapses to the global tier and the user stops being
// personalised at all. Both invariants are asserted in the test suite
// ("every topic offered in onboarding has an adjacency entry", "adjacency is
// symmetric", "no topic is an island"), because the failure is invisible at
// runtime: the user simply stops being personalised and nothing errors.
// Edges are UNDIRECTED. The original map was one-way in sixteen places, so
// Science listed nothing of Technology while Technology listed Science, and a
// Science-only reader never saw the adjacent tier the other side offered.
const ADJACENT = {
  Science:     ['Technology', 'Space', 'Nature', 'Environment', 'Health', 'Sleep'],
  Technology:  ['Science', 'AI', 'Engineering', 'Aeronautics', 'Education', 'Business'],
  AI:          ['Technology', 'Engineering', 'Philosophy', 'Movies'],
  Engineering: ['Technology', 'AI', 'Aeronautics', 'Space', 'Design'],
  Aeronautics: ['Technology', 'Engineering', 'Space', 'Design'],
  Space:       ['Science', 'Engineering', 'Aeronautics', 'Nature'],
  Nature:      ['Science', 'Space', 'Environment', 'Health', 'Sleep'],
  Environment: ['Science', 'Nature', 'Society'],
  Health:      ['Science', 'Nature', 'Sleep', 'Beauty', 'Psychology'],
  Sleep:       ['Science', 'Nature', 'Health', 'Psychology'],
  Beauty:      ['Health', 'Culture', 'Design'],
  Psychology:  ['Health', 'Sleep', 'Philosophy', 'Society', 'Education', 'Finance'],
  Philosophy:  ['AI', 'Psychology', 'Society', 'History', 'Books'],
  Society:     ['Environment', 'Psychology', 'Philosophy', 'History', 'Economics', 'Finance'],
  History:     ['Philosophy', 'Society', 'Culture', 'Arts', 'Books', 'Economics'],
  Culture:     ['Beauty', 'History', 'Arts', 'Books', 'Movies'],
  Arts:        ['History', 'Culture', 'Books', 'Movies', 'Design'],
  Books:       ['Philosophy', 'History', 'Culture', 'Arts', 'Education'],
  Movies:      ['AI', 'Culture', 'Arts', 'Design'],
  Design:      ['Engineering', 'Aeronautics', 'Beauty', 'Arts', 'Movies'],
  Education:   ['Technology', 'Psychology', 'Books'],
  Business:    ['Technology', 'Economics', 'Finance'],
  Economics:   ['Society', 'History', 'Business', 'Finance'],
  Finance:     ['Psychology', 'Society', 'Business', 'Economics']
};

const DIFF_RANK = { Beginner: 1, Balanced: 2, Challenging: 3 };

/** Returns { contentId, tier, confidence, why[] } and NEVER null while the
 *  corpus is non-empty (PRD §47/§80). tier 0=interest 1=adjacent 2=global
 *  3=evergreen emergency 4=revisit. */
function recommend(opts) {
  const corpus = opts.corpus, profile = opts.profile;
  const seen = new Set(opts.seenIds || []);
  const recentTopics = opts.recentTopics || []; // newest first
  const skipped = new Set(opts.skippedIds || []);
  const rand = opts.rand || (() => 0.5);

  const interests = new Set(profile.interests || []);
  const adjacent = new Set();
  interests.forEach(t => (ADJACENT[t] || []).forEach(a => { if (!interests.has(a)) adjacent.add(a); }));

  // Consecutive-topic run drives the diversity term (PRD §40).
  let run = 0;
  if (recentTopics.length) {
    const head = recentTopics[0];
    while (run < recentTopics.length && recentTopics[run] === head) run++;
  }
  const staleTopic = run >= 2 ? recentTopics[0] : null;

  const wantRank = DIFF_RANK[profile.difficulty] || 2;
  const approved = corpus.filter(c => c.status === 'approved');

  function score(c) {
    const why = [];
    let s = 0;
    if (interests.has(c.topic)) { s += 40; why.push('matches your interest in ' + c.topic); }
    else if (adjacent.has(c.topic)) { s += 18; why.push(c.topic + ' sits next to what you follow'); }

    // Affinity is suppressed for the subject the user is stuck on. Otherwise
    // the behavioural loop that §41 creates directly defeats the diversity
    // rule §40 asks for: liking Psychology makes you see only Psychology,
    // which raises your Psychology affinity, and so on.
    if (c.topic !== staleTopic) {
      const affinity = (profile.affinity && profile.affinity[c.topic]) || 0;
      s += Math.max(-15, Math.min(20, affinity * 4));
      if (affinity >= 3) why.push('you finish ' + c.topic + ' pieces');
    }

    s += (c.quality - 70) * 0.6;
    if (c.quality >= 88) why.push('unusually strong source');

    const gap = Math.abs((DIFF_RANK[c.difficulty] || 2) - wantRank);
    s += gap === 0 ? 14 : gap === 1 ? 4 : -12;

    if (c.minutes === profile.duration) s += 8;
    else if (Math.abs(c.minutes - profile.duration) <= 5) s += 3;
    else s -= 6;

    // Escalating, so a longer rut is harder to stay in.
    if (staleTopic && c.topic === staleTopic) { s -= (20 + run * 10); }
    else if (staleTopic) { s += 14; why.push('a change of subject'); }

    if (skipped.has(c.id)) s -= 25;

    // Exploration. FIX (crack #24): on a one-a-day product a bad exploration
    // day costs the user 100% of their day, so it is throttled and never
    // fires during the fragile first week.
    if ((opts.streak || 0) >= 7 && !interests.has(c.topic) && rand() < 0.14) {
      s += 22; why.push('a deliberate detour outside your usual topics');
    }
    return { s, why };
  }

  function best(pool, tier) {
    if (!pool.length) return null;
    const ranked = pool.map(c => {
      const r = score(c);
      return { c, s: r.s, why: r.why };
    }).sort((a, b) => b.s - a.s);
    const top = ranked[0];
    const spread = ranked.length > 1 ? top.s - ranked[ranked.length - 1].s : 1;
    return {
      contentId: top.c.id, tier: tier,
      confidence: Math.max(0.05, Math.min(0.99, 0.45 + (top.s / 120) * 0.5)),
      why: top.why.length ? top.why : ['picked from approved general content'],
      margin: spread
    };
  }

  const unseen = approved.filter(c => !seen.has(c.id));

  // PRD §40. After a run of the same subject the candidate pool widens so the
  // diversity term can actually outrank interest match. Without this the tiers
  // are a strict cascade and a single-interest user is served that one subject
  // forever, which is precisely the failure §40 exists to prevent.
  if (staleTopic) {
    const widened = best(unseen, 0);
    if (widened) return widened;
  }

  return best(unseen.filter(c => interests.has(c.topic)), 0)
    || best(unseen.filter(c => adjacent.has(c.topic)), 1)
    || best(unseen, 2)
    // The emergency pool must still respect "not seen", otherwise it silently
    // re-serves old content without telling the user it is a revisit.
    || best(approved.filter(c => c.evergreen && !seen.has(c.id)), 3)
    // FIX (crack #7): the PRD has no answer for a user who has seen
    // everything eligible. Rather than break the daily promise, the oldest
    // completed item returns explicitly flagged as a revisit.
    || best(approved.slice().sort((a, b) =>
        (opts.lastSeenAt?.[a.id] || 0) - (opts.lastSeenAt?.[b.id] || 0)).slice(0, 1), 4);
}

// ---------- daily assignment ----------
/** PRD §15/§17. Server decides the date; the client's opinion is ignored. */
function getOrCreateAssignment(db, user, nowMs, requestedDate) {
  const today = localDate(nowMs, user.tzOffsetMin, user.dayStartHour);

  // FIX (crack #1): a user flying west can move their local date BACKWARDS.
  // Without this the same person gets a second "fresh" day and a second
  // streak increment. The effective day never regresses below the last day
  // the server already opened for them.
  let effective = today;
  if (user.lastActiveLocalDate && daysBetween(user.lastActiveLocalDate, today) < 0) {
    effective = user.lastActiveLocalDate;
  }

  if (requestedDate && requestedDate !== effective) {
    if (daysBetween(effective, requestedDate) > 0) {
      return { error: 'FUTURE_CONTENT_LOCKED', status: 403, date: effective };
    }
    const past = db.assignments.find(a => a.userId === user.id && a.localDate === requestedDate);
    return past ? { assignment: past, readOnly: true } : { error: 'NOT_FOUND', status: 404 };
  }

  const existing = db.assignments.find(a => a.userId === user.id && a.localDate === effective);
  if (existing) return { assignment: existing, created: false };

  const mine = db.assignments.filter(a => a.userId === user.id);
  const seenIds = mine.map(a => a.contentId);
  const lastSeenAt = {};
  mine.forEach(a => { lastSeenAt[a.contentId] = parseDate(a.localDate); });
  const recentTopics = mine.slice()
    .sort((x, y) => (x.localDate < y.localDate ? 1 : x.localDate > y.localDate ? -1 : 0)) // newest first
    .map(a => (db.corpus.find(c => c.id === a.contentId) || {}).topic);

  const rec = recommend({
    corpus: db.corpus, profile: user, seenIds, recentTopics, lastSeenAt,
    skippedIds: user.skippedIds, streak: user.currentStreak, rand: db.rand
  });
  if (!rec) return { error: 'NO_CONTENT', status: 503 };

  const a = {
    id: 'dl_' + user.id + '_' + effective,
    userId: user.id, contentId: rec.contentId, localDate: effective,
    tzOffsetMin: user.tzOffsetMin,        // frozen at assignment time
    dayStartHour: user.dayStartHour || 0, // frozen at assignment time
    status: 'assigned', assignedAt: nowMs, startedAt: null, completedAt: null,
    tier: rec.tier, confidence: rec.confidence, why: rec.why,
    quizScore: null, xpEarned: 0, revisit: rec.tier === 4
  };
  // Simulates the ON CONFLICT DO NOTHING guard behind UNIQUE(user_id, local_date).
  if (db.assignments.some(x => x.userId === user.id && x.localDate === effective)) {
    return { assignment: db.assignments.find(x => x.userId === user.id && x.localDate === effective), created: false };
  }
  db.assignments.push(a);
  user.lastActiveLocalDate = effective;
  return { assignment: a, created: true };
}

// ---------- completion ----------
const XP = {
  complete: 100, quiz: 25, perfectQuiz: 25, reflection: 10, firstTopic: 20,
  firstTopicCap: 6 // FIX (crack #12): "+20 per first-time topic" x 24 topics
                   // is farmable by picking every interest. Capped.
};

/** Grades server-side from the server's copy of the answers.
 *  FIX (crack #36): correct answers must never reach the client. */
function gradeQuiz(content, answers) {
  const qs = content.quiz || [];
  let correct = 0;
  const detail = qs.map((q, i) => {
    const ok = answers && answers[i] === q.correct;
    if (ok) correct++;
    return { i, ok: !!ok, correct: q.correct, explain: q.explain };
  });
  return { correct, total: qs.length, detail, perfect: qs.length > 0 && correct === qs.length };
}

/** PRD §23/§49/§51/§98. Idempotent: safe to call twice with the same key. */
function completeLearning(db, user, nowMs, payload) {
  const a = db.assignments.find(x => x.userId === user.id && x.localDate === payload.localDate);
  if (!a) return { error: 'NO_ASSIGNMENT', status: 404 };
  if (!a.startedAt) return { error: 'NOT_STARTED', status: 409 };

  // ---- idempotency (PRD §98) ----
  if (a.status === 'completed') {
    return {
      idempotent: true, assignment: a, xpAwarded: 0,
      streak: { current: user.currentStreak, longest: user.longestStreak, changed: false },
      grade: a.grade, receipt: a.receipt
    };
  }

  // ---- late / offline sync window ----
  // FIX (crack #9): the PRD says server timestamps are authoritative AND that
  // offline completions are queued for later sync. Those contradict: an honest
  // offline finisher loses the streak. A client-claimed finish time is honoured
  // only if the session start was witnessed by the server on that same local
  // day and the claim is inside a bounded window.
  const serverDate = localDate(nowMs, a.tzOffsetMin, a.dayStartHour);
  let acceptedAsOfflineSync = false;
  if (serverDate !== a.localDate) {
    const claimed = payload.clientCompletedAt;
    const graceMs = 12 * 3600000;  // covers 'finished before bed, synced on waking'
    const dayEnd = parseDate(addDays(a.localDate, 1)) - 12 * 3600000
      - a.tzOffsetMin * 60000 + (a.dayStartHour || 0) * 3600000;
    const withinGrace = nowMs - dayEnd <= graceMs;
    const claimInDay = claimed && localDate(claimed, a.tzOffsetMin, a.dayStartHour) === a.localDate;
    if (payload.offlineSync && claimed && claimInDay && withinGrace && daysBetween(a.localDate, serverDate) === 1) {
      acceptedAsOfflineSync = true;
    } else {
      return { error: 'DAY_CLOSED', status: 410, date: a.localDate };
    }
  }

  const content = db.corpus.find(c => c.id === a.contentId);
  const grade = gradeQuiz(content, payload.quizAnswers);
  if (grade.total > 0 && (!payload.quizAnswers || payload.quizAnswers.filter(x => x !== null && x !== undefined).length < grade.total)) {
    return { error: 'QUIZ_INCOMPLETE', status: 409 };
  }

  // ---- XP, written as transactions (PRD §72) ----
  const lines = [];
  const push = (reason, amount) => {
    const key = user.id + ':' + a.id + ':' + reason;
    if (db.xp.some(t => t.key === key)) return;      // replay guard
    db.xp.push({ key, userId: user.id, amount, reason, ref: a.id, at: nowMs });
    lines.push({ reason, amount });
  };

  push('complete_daily', XP.complete);
  // FIX (crack #8 follow-on): a revisit is content this user has already
  // completed once, so its quiz is a test they have already been given the
  // answers to. Paying quiz and perfect-quiz XP again makes the ceiling
  // permanently farmable the moment the library is exhausted, which §49
  // forbids. Completing still pays in full, because the daily habit is the
  // product and the streak must survive an exhausted library.
  if (grade.total > 0 && !a.revisit) {
    push('complete_quiz', XP.quiz);
    if (grade.perfect) push('perfect_quiz', XP.perfectQuiz);
  }
  // FIX (crack #11): the PRD awards XP for a "meaningful" reflection. Nothing
  // can judge meaning cheaply or fairly, and an LLM gate would reject honest
  // short answers. A low objective floor, and the UI never says "meaningful".
  if (payload.reflection && payload.reflection.trim().length >= 40 &&
      new Set(payload.reflection.replace(/\s/g, '')).size >= 8) {
    push('reflection', XP.reflection);
  }
  const priorTopics = new Set(db.assignments
    .filter(x => x.userId === user.id && x.status === 'completed' && x.id !== a.id)
    .map(x => (db.corpus.find(c => c.id === x.contentId) || {}).topic));
  const firstTopicAwards = db.xp.filter(t => t.userId === user.id && t.reason === 'first_topic').length;
  if (content && !priorTopics.has(content.topic) && firstTopicAwards < XP.firstTopicCap) {
    push('first_topic', XP.firstTopic);
  }

  const xpAwarded = lines.reduce((s, l) => s + l.amount, 0);
  user.xp = db.xp.filter(t => t.userId === user.id).reduce((s, t) => s + t.amount, 0);

  // ---- streak ----
  const prev = user.lastCompletedLocalDate;
  const before = user.currentStreak || 0;
  let gap = prev ? daysBetween(prev, a.localDate) : null;

  // FIX (crack #6): flying EAST skips a calendar date through no fault of the
  // user. If the timezone moved forward enough to explain exactly one lost
  // day, that day is bridged rather than punished.
  let bridged = false;
  if (gap === 2 && user.prevTzOffsetMin != null &&
      (user.tzOffsetMin - user.prevTzOffsetMin) >= 8 * 60) { gap = 1; bridged = true; }

  if (gap === 0) { /* unreachable: idempotency catches it */ }
  else if (gap === 1) user.currentStreak = before + 1;
  else user.currentStreak = 1;
  user.longestStreak = Math.max(user.longestStreak || 0, user.currentStreak);
  user.lastCompletedLocalDate = a.localDate;

  a.status = 'completed';
  a.completedAt = acceptedAsOfflineSync ? payload.clientCompletedAt : nowMs;
  a.quizScore = grade.total ? grade.correct / grade.total : null;
  a.xpEarned = xpAwarded;
  a.grade = grade;
  a.reflection = payload.reflection || null;

  // affinity update (PRD §41)
  if (content) {
    user.affinity = user.affinity || {};
    const bump = 1 + (grade.perfect ? 0.5 : 0) + (payload.bookmarked ? 0.5 : 0);
    user.affinity[content.topic] = (user.affinity[content.topic] || 0) + bump;
  }

  const unlocked = checkAchievements(db, user);
  a.receipt = {
    lines, xpAwarded, streak: user.currentStreak, bridged,
    offlineSync: acceptedAsOfflineSync, unlocked, level: levelFor(user.xp)
  };
  return {
    assignment: a, xpAwarded, lines, grade, unlocked, bridged,
    offlineSync: acceptedAsOfflineSync,
    streak: { current: user.currentStreak, longest: user.longestStreak, changed: true, previous: before },
    level: levelFor(user.xp), receipt: a.receipt
  };
}

/** FIX (crack #33): the PRD keeps current_streak as mutable state with no
 *  repair path. Completions are the source of truth; this recomputes and is
 *  run nightly to heal drift. */
function recomputeStreak(db, user, todayLocal) {
  const days = db.assignments
    .filter(a => a.userId === user.id && a.status === 'completed')
    .map(a => a.localDate).sort();
  if (!days.length) return { current: 0, longest: 0, last: null };
  let longest = 1, run = 1;
  for (let i = 1; i < days.length; i++) {
    if (daysBetween(days[i - 1], days[i]) === 1) run++; else run = 1;
    longest = Math.max(longest, run);
  }
  const last = days[days.length - 1];
  let current = 1;
  for (let i = days.length - 1; i > 0; i--) {
    if (daysBetween(days[i - 1], days[i]) === 1) current++; else break;
  }
  // A streak is only alive if the last completion was today or yesterday.
  const alive = todayLocal ? daysBetween(last, todayLocal) <= 1 : true;
  return { current: alive ? current : 0, longest, last };
}

// ---------- achievements ----------
const ACHIEVEMENTS = [
  { id: 'first_thing', name: 'First Thing', desc: 'Finish your first one.', test: s => s.completed >= 1 },
  { id: 'week_one', name: 'Week One', desc: 'Seven days in a row.', test: s => s.longest >= 7 },
  { id: 'deep_diver', name: 'Deep Diver', desc: 'Ten pieces in a single subject.', test: s => s.maxTopic >= 10 },
  { id: 'explorer', name: 'Explorer', desc: 'Five different subjects.', test: s => s.topics >= 5 },
  { id: 'polymath', name: 'Polymath', desc: 'Ten different subjects.', test: s => s.topics >= 10 },
  { id: 'critical_thinker', name: 'Critical Thinker', desc: 'Full marks, five times.', test: s => s.perfects >= 5 },
  { id: 'century', name: 'Century', desc: 'A hundred things kept.', test: s => s.completed >= 100 }
];

function statsFor(db, user) {
  const done = db.assignments.filter(a => a.userId === user.id && a.status === 'completed');
  const byTopic = {};
  done.forEach(a => {
    const c = db.corpus.find(x => x.id === a.contentId);
    if (c) byTopic[c.topic] = (byTopic[c.topic] || 0) + 1;
  });
  return {
    completed: done.length,
    topics: Object.keys(byTopic).length,
    maxTopic: Object.values(byTopic).reduce((m, v) => Math.max(m, v), 0),
    perfects: done.filter(a => a.grade && a.grade.perfect).length,
    longest: user.longestStreak || 0,
    byTopic
  };
}

function checkAchievements(db, user) {
  const s = statsFor(db, user);
  user.achievements = user.achievements || [];
  const newly = [];
  ACHIEVEMENTS.forEach(a => {
    if (!user.achievements.includes(a.id) && a.test(s)) { user.achievements.push(a.id); newly.push(a); }
  });
  return newly;
}

/** FIX (crack #36, client half): what the browser is allowed to receive. */
function toClientPayload(content) {
  if (!content) return null;
  const out = JSON.parse(JSON.stringify(content));
  (out.quiz || []).forEach(q => { delete q.correct; delete q.explain; });
  return out;
}

const CORE = {
  localDate, addDays, daysBetween, parseDate, levelFor, LEVEL_NAMES, LEVEL_THRESHOLDS,
  recommend, getOrCreateAssignment, completeLearning, recomputeStreak, gradeQuiz,
  toClientPayload, checkAchievements, statsFor, ACHIEVEMENTS, ADJACENT, XP
};
if (typeof module !== 'undefined') module.exports = CORE;
if (typeof window !== 'undefined') window.CORE = CORE;
