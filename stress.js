const C = require('./core.js');
let pass = 0, fail = 0;
const out = [];
function t(name, fn) {
  try { fn(); out.push('  PASS  ' + name); pass++; }
  catch (e) { out.push('  FAIL  ' + name + '\n          ' + e.message); fail++; }
}
function eq(a, b, m) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((m || '') + ' expected ' + JSON.stringify(b) + ' got ' + JSON.stringify(a)); }
function ok(v, m) { if (!v) throw new Error(m || 'expected truthy'); }

// ---- fixtures ----
function corpus(n) {
  const topics = ['Psychology', 'Science', 'Space', 'History', 'Economics', 'AI'];
  const a = [];
  for (let i = 0; i < n; i++) a.push({
    id: 'c' + i, topic: topics[i % topics.length], difficulty: 'Balanced',
    minutes: 10, quality: 80 + (i % 15), status: 'approved', evergreen: i < 2,
    quiz: [{ q: 'q1', options: ['a', 'b'], correct: 0, explain: 'because' },
           { q: 'q2', options: ['a', 'b'], correct: 1, explain: 'because' }]
  });
  return a;
}
function fresh(opts) {
  opts = opts || {};
  const user = {
    id: 'u1', tzOffsetMin: opts.tz != null ? opts.tz : 60, dayStartHour: opts.dayStart || 0,
    interests: opts.interests || ['Psychology', 'Science', 'Space'],
    difficulty: 'Balanced', duration: 10, currentStreak: 0, longestStreak: 0,
    xp: 0, affinity: {}, achievements: []
  };
  const db = { corpus: corpus(opts.n || 30), assignments: [], xp: [], rand: () => 0.9 };
  return { db, user };
}
const MS = (iso) => Date.parse(iso);
function play(db, user, nowMs, over) {
  const r = C.getOrCreateAssignment(db, user, nowMs);
  if (r.error) return r;
  r.assignment.startedAt = nowMs;
  return C.completeLearning(db, user, nowMs, Object.assign({
    localDate: r.assignment.localDate, quizAnswers: [0, 1]
  }, over || {}));
}

out.push('\n=== A. CALENDAR / TIMEZONE (PRD §16, §97) ===');

t('local date uses user tz, not UTC', () => {
  // 23:30 UTC on the 13th is already the 14th in Lagos? No: Lagos is +1 -> 00:30 on 14th.
  eq(C.localDate(MS('2026-08-13T23:30:00Z'), 60, 0), '2026-08-14');
  eq(C.localDate(MS('2026-08-13T23:30:00Z'), -420, 0), '2026-08-13'); // Los Angeles
});

t('day maths survives DST spring-forward (23-hour day)', () => {
  // US spring forward 2026-03-08. A naive now-86400000 lands on the wrong date.
  eq(C.addDays('2026-03-08', -1), '2026-03-07');
  eq(C.daysBetween('2026-03-07', '2026-03-08'), 1);
  eq(C.daysBetween('2026-11-01', '2026-11-02'), 1); // fall back, 25-hour day
});

t('day maths survives month and year boundaries', () => {
  eq(C.addDays('2026-12-31', 1), '2027-01-01');
  eq(C.daysBetween('2026-02-28', '2026-03-01'), 1); // 2026 is not a leap year
  eq(C.daysBetween('2024-02-28', '2024-03-01'), 2); // 2024 is
});

t('opt-in 4am day boundary keeps a 1am finish on the previous day', () => {
  eq(C.localDate(MS('2026-08-14T01:30:00Z'), 0, 0), '2026-08-14');
  eq(C.localDate(MS('2026-08-14T01:30:00Z'), 0, 4), '2026-08-13');
});

out.push('\n=== B. DAILY ASSIGNMENT (PRD §15, §17, §78) ===');

t('one assignment per day, second request returns the same one', () => {
  const { db, user } = fresh();
  const a = C.getOrCreateAssignment(db, user, MS('2026-08-13T09:00:00Z'));
  const b = C.getOrCreateAssignment(db, user, MS('2026-08-13T17:00:00Z'));
  eq(a.assignment.id, b.assignment.id);
  eq(b.created, false);
  eq(db.assignments.length, 1);
});

t('a completed day does not hand out a second piece', () => {
  const { db, user } = fresh();
  play(db, user, MS('2026-08-13T09:00:00Z'));
  const again = C.getOrCreateAssignment(db, user, MS('2026-08-13T21:00:00Z'));
  eq(again.assignment.status, 'completed');
  eq(db.assignments.length, 1);
});

t('tomorrow is refused server-side with 403', () => {
  const { db, user } = fresh();
  const r = C.getOrCreateAssignment(db, user, MS('2026-08-13T09:00:00Z'), '2026-08-14');
  eq(r.error, 'FUTURE_CONTENT_LOCKED');
  eq(r.status, 403);
});

t('a far-future date is refused too (no off-by-one escape)', () => {
  const { db, user } = fresh();
  eq(C.getOrCreateAssignment(db, user, MS('2026-08-13T09:00:00Z'), '2030-01-01').status, 403);
});

t('yesterday is readable but flagged read-only', () => {
  const { db, user } = fresh();
  play(db, user, MS('2026-08-13T09:00:00Z'));
  const r = C.getOrCreateAssignment(db, user, MS('2026-08-14T09:00:00Z'), '2026-08-13');
  eq(r.readOnly, true);
  ok(r.assignment);
});

t('concurrent double-request cannot create two rows', () => {
  const { db, user } = fresh();
  const now = MS('2026-08-13T09:00:00Z');
  C.getOrCreateAssignment(db, user, now);
  C.getOrCreateAssignment(db, user, now);
  C.getOrCreateAssignment(db, user, now);
  eq(db.assignments.filter(a => a.localDate === '2026-08-13').length, 1);
});

out.push('\n=== C. STREAK (PRD §51, §52, §79) ===');

t('first completion sets streak to 1', () => {
  const { db, user } = fresh();
  const r = play(db, user, MS('2026-08-13T09:00:00Z'));
  eq(r.streak.current, 1);
});

t('consecutive days increment', () => {
  const { db, user } = fresh();
  play(db, user, MS('2026-08-13T09:00:00Z'));
  play(db, user, MS('2026-08-14T09:00:00Z'));
  const r = play(db, user, MS('2026-08-15T09:00:00Z'));
  eq(r.streak.current, 3);
});

t('a missed day resets to 1', () => {
  const { db, user } = fresh();
  play(db, user, MS('2026-08-13T09:00:00Z'));
  play(db, user, MS('2026-08-14T09:00:00Z'));
  const r = play(db, user, MS('2026-08-16T09:00:00Z')); // 15th skipped
  eq(r.streak.current, 1);
  eq(user.longestStreak, 2);
});

t('23:59 then 00:01 the next day still counts as consecutive', () => {
  const { db, user } = fresh({ tz: 0 });
  play(db, user, MS('2026-08-13T23:59:00Z'));
  const r = play(db, user, MS('2026-08-14T00:01:00Z'));
  eq(r.streak.current, 2);
});

t('streak recomputed from the completion log matches the cached value', () => {
  const { db, user } = fresh();
  play(db, user, MS('2026-08-13T09:00:00Z'));
  play(db, user, MS('2026-08-14T09:00:00Z'));
  play(db, user, MS('2026-08-16T09:00:00Z'));
  play(db, user, MS('2026-08-17T09:00:00Z'));
  const re = C.recomputeStreak(db, user, '2026-08-17');
  eq(re.current, user.currentStreak);
  eq(re.longest, user.longestStreak);
});

t('corrupted cached streak is healed by recompute', () => {
  const { db, user } = fresh();
  play(db, user, MS('2026-08-13T09:00:00Z'));
  play(db, user, MS('2026-08-14T09:00:00Z'));
  user.currentStreak = 999; // simulate drift
  eq(C.recomputeStreak(db, user, '2026-08-14').current, 2);
});

t('a streak with no completion yesterday or today reads as dead', () => {
  const { db, user } = fresh();
  play(db, user, MS('2026-08-13T09:00:00Z'));
  eq(C.recomputeStreak(db, user, '2026-08-20').current, 0);
});

out.push('\n=== D. TIMEZONE TRAVEL (crack #1 and #6) ===');

t('flying west cannot buy a second day', () => {
  const { db, user } = fresh({ tz: 60 });            // Lagos +1
  play(db, user, MS('2026-08-14T01:00:00Z'));        // local 2026-08-14
  eq(user.currentStreak, 1);
  user.prevTzOffsetMin = user.tzOffsetMin;
  user.tzOffsetMin = -420;                            // lands in Los Angeles
  // Local date is now 2026-08-13 again, a naive server hands out a fresh day.
  const r = C.getOrCreateAssignment(db, user, MS('2026-08-14T02:00:00Z'));
  eq(r.assignment.localDate, '2026-08-14');
  eq(r.assignment.status, 'completed');
  eq(db.assignments.length, 1);
});

t('flying east does not punish a genuinely skipped calendar day', () => {
  const { db, user } = fresh({ tz: -420 });           // Los Angeles
  play(db, user, MS('2026-08-13T18:00:00Z'));         // local 2026-08-13
  user.prevTzOffsetMin = -420;
  user.tzOffsetMin = 345;                             // Kathmandu +5:45, 12h45 forward
  const r = play(db, user, MS('2026-08-15T02:00:00Z'));// local 2026-08-15
  eq(r.bridged, true);
  eq(r.streak.current, 2);
});

t('a 2-day gap with no timezone move is still a reset', () => {
  const { db, user } = fresh({ tz: 60 });
  play(db, user, MS('2026-08-13T09:00:00Z'));
  const r = play(db, user, MS('2026-08-15T09:00:00Z'));
  ok(!r.bridged, 'must not bridge without a timezone move');
  eq(r.streak.current, 1);
});

out.push('\n=== E. XP AND ABUSE (PRD §49, §98) ===');

t('completion pays once; a replayed request pays nothing', () => {
  const { db, user } = fresh();
  const r1 = play(db, user, MS('2026-08-13T09:00:00Z'));
  const before = user.xp;
  const r2 = C.completeLearning(db, user, MS('2026-08-13T09:05:00Z'), { localDate: '2026-08-13', quizAnswers: [0, 1] });
  eq(r2.idempotent, true);
  eq(r2.xpAwarded, 0);
  eq(user.xp, before);
  eq(r1.streak.current, 1);
  eq(user.currentStreak, 1); // replay must not bump the streak either
});

t('ten rapid replays do not multiply XP', () => {
  const { db, user } = fresh();
  play(db, user, MS('2026-08-13T09:00:00Z'));
  const before = user.xp;
  for (let i = 0; i < 10; i++) C.completeLearning(db, user, MS('2026-08-13T09:00:00Z'), { localDate: '2026-08-13', quizAnswers: [0, 1] });
  eq(user.xp, before);
  eq(db.xp.filter(x => x.reason === 'complete_daily').length, 1);
});

t('perfect quiz pays the bonus, an imperfect one does not', () => {
  let f = fresh();
  const a = play(f.db, f.user, MS('2026-08-13T09:00:00Z'), { quizAnswers: [0, 1] });
  ok(a.lines.some(l => l.reason === 'perfect_quiz'));
  f = fresh();
  const b = play(f.db, f.user, MS('2026-08-13T09:00:00Z'), { quizAnswers: [0, 0] });
  ok(!b.lines.some(l => l.reason === 'perfect_quiz'));
  ok(b.lines.some(l => l.reason === 'complete_quiz'));
});

t('completion is blocked until the session was actually started', () => {
  const { db, user } = fresh();
  C.getOrCreateAssignment(db, user, MS('2026-08-13T09:00:00Z'));
  const r = C.completeLearning(db, user, MS('2026-08-13T09:00:00Z'), { localDate: '2026-08-13', quizAnswers: [0, 1] });
  eq(r.error, 'NOT_STARTED');
});

t('an unanswered quiz cannot be completed', () => {
  const { db, user } = fresh();
  const r = play(db, user, MS('2026-08-13T09:00:00Z'), { quizAnswers: [0] });
  eq(r.error, 'QUIZ_INCOMPLETE');
});

t('reflection XP needs real characters, not keyboard mash', () => {
  let f = fresh();
  const junk = play(f.db, f.user, MS('2026-08-13T09:00:00Z'), { reflection: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
  ok(!junk.lines.some(l => l.reason === 'reflection'), 'mashed input should not pay');
  f = fresh();
  const real = play(f.db, f.user, MS('2026-08-13T09:00:00Z'), { reflection: 'I did not expect the effect to disappear once they controlled for family income.' });
  ok(real.lines.some(l => l.reason === 'reflection'));
});

t('first-time-topic bonus is capped so broad interests cannot farm it', () => {
  const { db, user } = fresh({ interests: ['Psychology', 'Science', 'Space', 'History', 'Economics', 'AI'], n: 60 });
  let d = MS('2026-08-01T09:00:00Z');
  for (let i = 0; i < 20; i++) { play(db, user, d); d += 86400000; }
  const awards = db.xp.filter(x => x.reason === 'first_topic').length;
  ok(awards <= C.XP.firstTopicCap, 'got ' + awards + ' first-topic awards');
});

t('XP total always equals the sum of its transactions', () => {
  const { db, user } = fresh();
  let d = MS('2026-08-01T09:00:00Z');
  for (let i = 0; i < 12; i++) { play(db, user, d); d += 86400000; }
  eq(user.xp, db.xp.reduce((s, x) => s + x.amount, 0));
});

out.push('\n=== F. QUIZ INTEGRITY (crack #36) ===');

t('the client payload contains no answers or explanations', () => {
  const { db } = fresh();
  const payload = C.toClientPayload(db.corpus[0]);
  const s = JSON.stringify(payload);
  ok(!('correct' in payload.quiz[0]), 'correct leaked');
  ok(!('explain' in payload.quiz[0]), 'explanation leaked');
  ok(s.indexOf('because') === -1, 'explanation text leaked');
});

t('stripping the client copy does not mutate the server copy', () => {
  const { db } = fresh();
  C.toClientPayload(db.corpus[0]);
  eq(db.corpus[0].quiz[0].correct, 0);
});

t('grading is done from the server copy, not from what the client sent', () => {
  const { db, user } = fresh();
  const r = play(db, user, MS('2026-08-13T09:00:00Z'), { quizAnswers: [1, 0] });
  eq(r.grade.correct, 0);
  eq(r.grade.detail[0].correct, 0); // explanation returned only after grading
});

out.push('\n=== G. OFFLINE SYNC (crack #9) ===');

t('a genuine offline finish syncing next morning keeps the streak', () => {
  const { db, user } = fresh({ tz: 0 });
  play(db, user, MS('2026-08-12T10:00:00Z'));
  const r = C.getOrCreateAssignment(db, user, MS('2026-08-13T23:40:00Z'));
  r.assignment.startedAt = MS('2026-08-13T23:40:00Z'); // start witnessed by server
  const res = C.completeLearning(db, user, MS('2026-08-14T07:00:00Z'), {
    localDate: '2026-08-13', quizAnswers: [0, 1],
    offlineSync: true, clientCompletedAt: MS('2026-08-13T23:52:00Z')
  });
  eq(res.offlineSync, true);
  eq(res.streak.current, 2);
});

t('a claimed offline finish outside the grace window is refused', () => {
  const { db, user } = fresh({ tz: 0 });
  const r = C.getOrCreateAssignment(db, user, MS('2026-08-13T23:40:00Z'));
  r.assignment.startedAt = MS('2026-08-13T23:40:00Z');
  const res = C.completeLearning(db, user, MS('2026-08-14T20:00:00Z'), {
    localDate: '2026-08-13', quizAnswers: [0, 1],
    offlineSync: true, clientCompletedAt: MS('2026-08-13T23:52:00Z')
  });
  eq(res.error, 'DAY_CLOSED');
});

t('a backdated claim for a day that already closed is refused', () => {
  const { db, user } = fresh({ tz: 0 });
  const r = C.getOrCreateAssignment(db, user, MS('2026-08-13T10:00:00Z'));
  r.assignment.startedAt = MS('2026-08-13T10:00:00Z');
  const res = C.completeLearning(db, user, MS('2026-08-20T10:00:00Z'), {
    localDate: '2026-08-13', quizAnswers: [0, 1],
    offlineSync: true, clientCompletedAt: MS('2026-08-13T23:00:00Z')
  });
  eq(res.error, 'DAY_CLOSED');
});

t('a lying client cannot claim a finish time outside the day it names', () => {
  const { db, user } = fresh({ tz: 0 });
  const r = C.getOrCreateAssignment(db, user, MS('2026-08-13T23:40:00Z'));
  r.assignment.startedAt = MS('2026-08-13T23:40:00Z');
  const res = C.completeLearning(db, user, MS('2026-08-14T03:00:00Z'), {
    localDate: '2026-08-13', quizAnswers: [0, 1],
    offlineSync: true, clientCompletedAt: MS('2026-08-14T02:00:00Z') // actually next day
  });
  eq(res.error, 'DAY_CLOSED');
});

out.push('\n=== H. RECOMMENDATION (PRD §37, §40, §47, §80) ===');

t('never repeats content while unseen items remain', () => {
  const { db, user } = fresh({ n: 30 });
  let d = MS('2026-08-01T09:00:00Z');
  for (let i = 0; i < 25; i++) { play(db, user, d); d += 86400000; }
  const ids = db.assignments.map(a => a.contentId);
  eq(new Set(ids).size, ids.length);
});

t('breaks up a topic run instead of serving the same subject forever', () => {
  const { db, user } = fresh({ interests: ['Psychology'], n: 30 });
  let d = MS('2026-08-01T09:00:00Z');
  for (let i = 0; i < 8; i++) { play(db, user, d); d += 86400000; }
  const topics = db.assignments.map(a => db.corpus.find(c => c.id === a.contentId).topic);
  let maxRun = 1, run = 1;
  for (let i = 1; i < topics.length; i++) { if (topics[i] === topics[i - 1]) run++; else run = 1; maxRun = Math.max(maxRun, run); }
  ok(maxRun <= 2, 'topic run of ' + maxRun + ': ' + topics.join(','));
});

t('a narrow-interest user still gets content every day (fallback chain)', () => {
  const { db, user } = fresh({ interests: ['Philosophy'], n: 12 }); // corpus has zero Philosophy
  let d = MS('2026-08-01T09:00:00Z');
  for (let i = 0; i < 12; i++) {
    const r = C.getOrCreateAssignment(db, user, d);
    ok(!r.error, 'day ' + i + ' errored: ' + r.error);
    ok(r.assignment.contentId, 'day ' + i + ' had no content');
    d += 86400000;
  }
});

t('exhausting the entire library still returns something, flagged as a revisit', () => {
  const { db, user } = fresh({ n: 5 });
  let d = MS('2026-08-01T09:00:00Z');
  for (let i = 0; i < 5; i++) { play(db, user, d); d += 86400000; }
  const r = C.getOrCreateAssignment(db, user, d);
  ok(!r.error, 'errored after exhaustion: ' + r.error);
  eq(r.assignment.revisit, true);
});

t('a day-1 user with zero history still gets a scored pick with a reason', () => {
  const { db, user } = fresh();
  const r = C.getOrCreateAssignment(db, user, MS('2026-08-13T09:00:00Z'));
  ok(r.assignment.why.length > 0);
  ok(r.assignment.confidence > 0);
  eq(r.assignment.tier, 0);
});

t('exploration never fires during the first week', () => {
  const { db, user } = fresh({ interests: ['Psychology'], n: 30 });
  db.rand = () => 0.01; // force exploration if it were allowed
  const r = C.getOrCreateAssignment(db, user, MS('2026-08-13T09:00:00Z'));
  const c = db.corpus.find(x => x.id === r.assignment.contentId);
  eq(c.topic, 'Psychology');
});

out.push('\n=== I. LEVELS (crack #13) ===');

t('level thresholds are monotonic and a max-level user keeps progressing', () => {
  let last = -1;
  [0, 299, 300, 899, 2000, 7999, 8000, 14000, 20000, 50000].forEach(xp => {
    const l = C.levelFor(xp);
    ok(l.level >= last, 'level went backwards at ' + xp);
    ok(l.progress >= 0 && l.progress <= 1, 'progress out of range at ' + xp + ': ' + l.progress);
    last = l.level;
  });
  eq(C.levelFor(0).name, 'Curious');
  eq(C.levelFor(8000).name, 'Polymath');
  ok(C.levelFor(20000).name.indexOf('Polymath') === 0);
  ok(C.levelFor(20000).level > 6, 'a 365-day user must not be stuck at max level');
});

t('a full year of daily learning lands on a sensible level', () => {
  const { db, user } = fresh({ n: 400 });
  let d = MS('2026-01-01T09:00:00Z');
  for (let i = 0; i < 365; i++) { play(db, user, d); d += 86400000; }
  eq(user.currentStreak, 365);
  const l = C.levelFor(user.xp);
  out.push('        (365 days -> ' + user.xp + ' XP, level ' + l.level + ' ' + l.name + ')');
  ok(l.level >= 6);
});

out.push('\n=== J. ACHIEVEMENTS ===');

t('First Thing unlocks exactly once', () => {
  const { db, user } = fresh();
  const a = play(db, user, MS('2026-08-13T09:00:00Z'));
  eq(a.unlocked.map(x => x.id), ['first_thing']);
  const b = play(db, user, MS('2026-08-14T09:00:00Z'));
  ok(!b.unlocked.some(x => x.id === 'first_thing'));
});

t('Week One unlocks on the seventh consecutive day', () => {
  const { db, user } = fresh();
  let d = MS('2026-08-01T09:00:00Z'), hit = null;
  for (let i = 0; i < 7; i++) { const r = play(db, user, d); if (r.unlocked.some(x => x.id === 'week_one')) hit = i + 1; d += 86400000; }
  eq(hit, 7);
});

out.push('\n=== K. TOPIC TAXONOMY (crack #12, #22) ===');

// These read the shipped app rather than a fixture. The recommendation engine
// lives in core.js but the list of topics a user can actually pick lives in
// one-thing.html, and nothing but a test connects the two. A topic offered in
// onboarding with no adjacency entry, or a topic name that exists in only one
// of the two files, fails silently: the user picks it, tier 0 and tier 1 both
// come back empty, and they are quietly served global content forever.
const fs = require('fs');
const APP = fs.readFileSync(__dirname + '/one-thing.html', 'utf8');
const grab = (re, what) => { const m = APP.match(re); if (!m) throw new Error('could not find ' + what); return m; };
const TOPICS = eval(grab(/const TOPICS=(\[[^\]]*\]);/, 'TOPICS')[1]);
const SUBS = eval('(' + grab(/const SUBS=(\{[\s\S]*?\});\n/, 'SUBS')[1] + ')');
const ZONES = eval(grab(/const ZONES=(\[[\s\S]*?\]);\n/, 'ZONES')[1]);
const CORPUS = eval(grab(/const CORPUS = (\[[\s\S]*?\n\]);/, 'CORPUS')[1]);
const MOTIFS = [...APP.matchAll(/kind==='([a-z]+)'/g)].map(m => m[1]);

t('every category offered has at least one item of its own', () => {
  const have = new Set(CORPUS.map(c => c.topic));
  eq(TOPICS.filter(x => !have.has(x)), [], 'categories with a chip but no content');
});

t('every topic offered in onboarding has an adjacency entry', () => {
  const missing = TOPICS.filter(x => !C.ADJACENT[x]);
  eq(missing, [], 'topics with no adjacency');
});

t('every name used in the adjacency map is a real topic', () => {
  const known = new Set(TOPICS);
  const bad = [];
  Object.entries(C.ADJACENT).forEach(([k, v]) => {
    if (!known.has(k)) bad.push(k);
    v.forEach(x => { if (!known.has(x)) bad.push(k + ' -> ' + x); });
  });
  eq(bad, [], 'dangling topic names');
});

t('adjacency is symmetric, so relatedness does not depend on direction', () => {
  const bad = [];
  Object.entries(C.ADJACENT).forEach(([k, v]) => v.forEach(x => {
    if (!(C.ADJACENT[x] || []).includes(k)) bad.push(k + ' -> ' + x + ' but not back');
  }));
  eq(bad, [], 'one-way edges');
});

t('no topic is an island; every topic reaches every other through adjacency', () => {
  const seen = new Set([TOPICS[0]]), queue = [TOPICS[0]];
  while (queue.length) (C.ADJACENT[queue.pop()] || []).forEach(n => { if (!seen.has(n)) { seen.add(n); queue.push(n); } });
  eq(TOPICS.filter(x => !seen.has(x)), [], 'unreachable topics');
});

t('every subtopic group hangs off a real topic', () => {
  eq(Object.keys(SUBS).filter(k => !TOPICS.includes(k)), []);
});

t('no subtopic duplicates a top-level topic name', () => {
  // "Sleep" was offered both as a Health subtopic and, now, as a topic. One
  // interest under two names double-counts affinity and the first-topic bonus.
  const clash = [];
  Object.entries(SUBS).forEach(([k, v]) => v.forEach(x => { if (TOPICS.includes(x)) clash.push(k + ' / ' + x); }));
  eq(clash, []);
});

t('the six added categories each have real content, not just a chip', () => {
  const have = new Set(CORPUS.map(c => c.topic));
  eq(['Beauty', 'Aeronautics', 'Finance', 'Books', 'Movies', 'Sleep'].filter(x => !have.has(x)), []);
});

t('every corpus topic is selectable in onboarding', () => {
  eq([...new Set(CORPUS.map(c => c.topic))].filter(x => !TOPICS.includes(x)), []);
});

t('a user interested only in a new category is served that category', () => {
  ['Beauty', 'Aeronautics', 'Finance', 'Books', 'Movies', 'Sleep'].forEach(topic => {
    const r = C.recommend({ corpus: CORPUS, profile: { interests: [topic], difficulty: 'Balanced', duration: 10 } });
    const got = CORPUS.find(c => c.id === r.contentId);
    eq([topic, got.topic, r.tier], [topic, topic, 0], topic + ' did not resolve to tier 0');
  });
});

t('every corpus item draws with a motif that exists', () => {
  eq(CORPUS.filter(c => !MOTIFS.includes(c.motif)).map(c => c.id), [], 'motifs missing from the illustration engine');
});

t('every content id is unique', () => {
  const ids = CORPUS.map(c => c.id);
  eq(ids.length, new Set(ids).size);
});

t('every quiz answer index points at a real option', () => {
  const bad = [];
  CORPUS.forEach(c => {
    (c.quiz || []).forEach((q, i) => { if (!(q.correct >= 0 && q.correct < q.options.length)) bad.push(c.id + ' quiz ' + i); });
    (c.cards || []).forEach((k, i) => { if (k.t === 'predict' && !(k.a >= 0 && k.a < k.options.length)) bad.push(c.id + ' card ' + i); });
  });
  eq(bad, []);
});

t('every source carries a title, an author and a way through to it', () => {
  eq(CORPUS.filter(c => !(c.source && c.source.title && c.source.authors && c.source.url)).map(c => c.id), []);
});

t('topic colours clear WCAG AA against their own tint', () => {
  // --tone is used for real text (.eyebrow.tone, .finding) on a --tint ground,
  // so this is a contrast requirement, not decoration.
  const lum = h => { const c = [1, 3, 5].map(i => parseInt(h.substr(i, 2), 16) / 255)
      .map(x => x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const ratio = (a, b) => { const l = [lum(a), lum(b)].sort((x, y) => y - x); return (l[0] + 0.05) / (l[1] + 0.05); };
  const bad = CORPUS.filter(c => ratio(c.pal[0], c.pal[1]) < 4.5)
    .map(c => c.id + ' ' + ratio(c.pal[0], c.pal[1]).toFixed(2) + ':1');
  eq(bad, []);
});

out.push('\n=== L. TIMEZONE PICKER (crack #1, #6) ===');

t('zone labels are unique, so the picker cannot select two at once', () => {
  const names = ZONES.map(z => z[0]);
  eq(names.length, new Set(names).size);
});

t('the picker is keyed on the zone name, never the offset', () => {
  // Lagos, Calabar, London and Birmingham all sit at +1 in August; New York and
  // Toronto both at -4. Keying on the offset lit up every matching chip at once
  // and made the console name the wrong city.
  ok(/data-tz="\$\{h\(n\)\}"/.test(APP), 'chip value must be the zone name');
  ok(/aria-pressed="\$\{u\.zone===n\}"/.test(APP), 'selected state must compare zone names');
});

t('duplicate offsets exist and are handled, not avoided', () => {
  const offsets = ZONES.map(z => z[1]);
  ok(offsets.length > new Set(offsets).size, 'fixture should contain colliding offsets');
});

t('the removed cities are gone from every surface', () => {
  eq(['Tokyo', 'Kolkata', 'Auckland'].filter(x => APP.includes(x)), []);
});

t('the replacement cities are all reachable in the picker', () => {
  const names = ZONES.map(z => z[0]);
  eq(['Toronto', 'Calabar', 'Birmingham'].filter(x => !names.includes(x)), []);
});

t('every zone offset is a real UTC offset', () => {
  eq(ZONES.filter(z => z[1] % 15 !== 0 || Math.abs(z[1]) > 840).map(z => z[0]), []);
});

out.push('\n=== M. EXHAUSTION ECONOMY (crack #8, §49) ===');

t('a revisit still pays for completing, so an exhausted library cannot break a streak', () => {
  const { db, user } = fresh({ n: 3, interests: ['Psychology', 'Science', 'Space'] });
  let t0 = MS('2026-08-13T09:00:00Z'), last = null;
  for (let i = 0; i < 5; i++) { last = play(db, user, t0); t0 += 86400000; }
  eq(user.currentStreak, 5);
  ok(last.lines.some(l => l.reason === 'complete_daily' && l.amount === 100), 'completion must still pay');
});

t('a revisit pays no quiz XP, so the ceiling is not farmable once exhausted', () => {
  const { db, user } = fresh({ n: 3, interests: ['Psychology', 'Science', 'Space'] });
  let t0 = MS('2026-08-13T09:00:00Z'), fresh1 = null, revisit1 = null;
  for (let i = 0; i < 5; i++) {
    const r = play(db, user, t0);
    const a = db.assignments[db.assignments.length - 1];
    if (i === 0) fresh1 = r;
    if (a.revisit && !revisit1) revisit1 = r;
    t0 += 86400000;
  }
  ok(revisit1, 'a 3-item library must reach a revisit within 5 days');
  ok(fresh1.lines.some(l => l.reason === 'complete_quiz'), 'a fresh day pays quiz XP');
  eq(revisit1.lines.filter(l => /quiz/.test(l.reason)), [], 'a revisit must pay no quiz XP');
  ok(revisit1.xpAwarded < fresh1.xpAwarded, `revisit ${revisit1.xpAwarded} must be under fresh ${fresh1.xpAwarded}`);
});

t('the daily promise still holds well past the end of the library', () => {
  const { db, user } = fresh({ n: 4 });
  let t0 = MS('2026-08-13T09:00:00Z');
  for (let i = 0; i < 30; i++) {
    const r = C.getOrCreateAssignment(db, user, t0);
    ok(!r.error, 'day ' + (i + 1) + ' errored: ' + r.error);
    r.assignment.startedAt = t0;
    C.completeLearning(db, user, t0, { localDate: r.assignment.localDate, quizAnswers: [0, 1] });
    t0 += 86400000;
  }
  eq(user.currentStreak, 30);
});

console.log(out.join('\n'));
console.log('\n' + '='.repeat(56));
console.log('  ' + pass + ' passed, ' + fail + ' failed');
console.log('='.repeat(56));
process.exit(fail ? 1 : 0);
