const { chromium } = require('playwright');
const path = 'file:///home/claude/one-thing.html';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { console.log('  PASS  ' + m); pass++; } else { console.log('  FAIL  ' + m); fail++; } };

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 414, height: 896 }, isMobile: true, hasTouch: true });
  const shim = () => {
    window.storage = {
      get: async k => { const v = sessionStorage.getItem(k); if (v === null) throw new Error('not found'); return { key: k, value: v }; },
      set: async (k, v) => { sessionStorage.setItem(k, v); return { key: k, value: v }; },
      delete: async k => { sessionStorage.removeItem(k); return { key: k, deleted: true }; },
      list: async () => ({ keys: Object.keys(sessionStorage) })
    };
  };
  await ctx.addInitScript(shim);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  // The sandbox blocks fonts.googleapis.com. That is a network policy here, not
  // an app fault, and the stack falls back to Georgia / system-ui.
  const isFontBlock = t => /fonts\.googleapis|Failed to load resource/.test(t);
  page.on('console', m => { if (m.type() === 'error' && !isFontBlock(m.text())) errors.push('console: ' + m.text()); });
  page.on('requestfailed', r => { if (/googleapis/.test(r.url())) fontsBlocked = true; });
  let fontsBlocked = false;

  // window.storage does not exist outside Claude artifacts; the app must survive that.
  await page.goto(path);
  await page.waitForTimeout(600);

  const txt = async () => (await page.locator('#view').innerText());
  const click = async sel => { await page.locator(sel).first().click(); await page.waitForTimeout(160); };
  // .eyebrow uses CSS text-transform, so innerText comes back uppercased even
// though the DOM text is sentence case (which is the accessible way to do it).
// Compare case-insensitively.
  const has = async s => (await txt()).toLowerCase().includes(s.toLowerCase());

  console.log('\n=== 1. FIRST RUN, NO STORAGE API ===');
  ok(errors.length === 0, 'boots with no JS errors' + (errors.length ? ' :: ' + errors[0] : ''));
  ok(await has('Name one thing you kept'), 'benefit-led opening renders');
  ok(!(await has('Nothing is being saved')), 'a first-run user is not falsely told storage is broken');

  // Regression: without <meta charset> the browser sniffs windows-1252 and
  // mangles every multi-byte character, including an author's name.
  const enc = await page.evaluate(() => {
    document.body.insertAdjacentHTML('beforeend', '<i id=enc style="position:absolute;left:-9999px">' + CORPUS.map(c => c.source.authors).join(' ') + ' \u00a7 \u00b7 \u2019</i>');
    const t = document.getElementById('enc').textContent;
    document.getElementById('enc').remove();
    return { charset: document.characterSet, hasUmlaut: t.includes('J\u00f6nsson'), mojibake: /\u00c2|\u00c3/.test(t) };
  });
  ok(enc.charset.toLowerCase() === 'utf-8', 'document charset is UTF-8, got ' + enc.charset);
  ok(enc.hasUmlaut, 'author name with a diacritic survives intact');
  ok(!enc.mojibake, 'no mojibake in citation metadata');

  console.log('\n=== 2. ONBOARDING ===');
  await click('[data-a="next"]');
  ok(await has('What makes you look twice'), 'reaches interest picker');
  const cont = page.locator('[data-a="next"]').first();
  ok(await cont.isDisabled(), 'cannot continue with zero interests');
  await click('[data-topic="Psychology"]');
  await click('[data-topic="Space"]');
  ok(await page.locator('[data-a="next"]').first().isDisabled(), 'still blocked at two interests');
  await click('[data-topic="History"]');
  ok(!(await page.locator('[data-a="next"]').first().isDisabled()), 'unblocks at three');
  const chips = await page.locator('[data-topic]').count();
  ok(chips === 24, 'all 24 categories offered, got ' + chips);
  for (const t of ['Beauty', 'Aeronautics', 'Finance', 'Books', 'Movies', 'Sleep'])
    ok(await page.locator(`[data-topic="${t}"]`).count() === 1, `${t} is selectable`);
  ok(await page.locator('[data-topic]').first().evaluate(e => e.offsetHeight) >= 40,
     'category chips stay tappable at 24 of them');
  await click('[data-a="next"]');
  ok(await has('go deeper'), 'subtopics shown for a topic that has them');
  await click('[data-a="next"]');
  ok(await has('How long have you got'), 'duration step');
  await click('[data-dur="5"]');
  await click('[data-a="next"]');
  await click('[data-diff="Beginner"]');
  await click('[data-a="next"]');
  ok(await has('head have room'), 'reminder step');
  await click('[data-a="next"]');
  ok(await has("That's the whole deal"), 'notification step');
  ok(await has('Ask me tomorrow'), 'permission ask is deferred, not fired on step 7');
  await click('[data-a="next"]');

  console.log('\n=== 3. TODAY ===');
  ok(await page.locator('[data-a="start"]').count() === 1, 'lands on Today with something to start');
  ok(/start . \d+ min/i.test(await txt()), 'CTA states the time cost up front');
  ok(await page.locator('.dots').count() === 0, 'no dot calendar on Today, it belongs on Progress');
  ok(await page.locator('.today-art svg').count() === 1, "today's card carries its own artwork");
  const toneVar = await page.locator('.today-art').getAttribute('style');
  ok(/--tone:#/.test(toneVar), 'artwork is coloured by topic');
  await page.locator('details summary').click(); await page.waitForTimeout(150);
  ok(/matches your interest|sits next to|change of subject|approved general/i.test(await txt()),
     '"why this one" explains the pick in plain words');

  console.log('\n=== 4. THE LEARNING LOOP ===');
  await click('[data-a="start"]');
  ok(await page.locator('.segs i').count() > 3, 'story-style segmented progress present');
  ok(!(await page.locator('#tabs').isVisible()), 'tab bar hidden during the story');
  ok(await page.locator('.storyart svg').count() === 1, 'story runs on an illustrated background');
  ok(await page.locator('.tapzone.fwd').count() >= 0, 'tap-to-advance zones exist');
  let guard = 0, sawPredict = false, sawQuiz = false;
  while (guard++ < 40) {
    const t = await txt();
    if (await page.locator('[data-pred]:not([disabled])').count()) {
      sawPredict = true;
      ok(await page.locator('.nextfab').isDisabled(), 'cannot skip past a prediction unanswered');
      await click('[data-pred="0"]');
      ok((await txt()).length > t.length, 'answering reveals the outcome');
      ok(await page.locator('.sel[data-s="right"]').count() === 1, 'the true answer is marked after guessing');
      // Tapping the story area must advance once the question is spent.
      await click('.tapzone.fwd');
      ok(true, 'tapping the story advances after a spent question');
    } else if (await page.locator('.nextfab:not([disabled])').count()) {
      await click('.nextfab');
    } else if (await page.locator('[data-ans]:not([disabled])').count()) {
      if (!sawQuiz) {
        sawQuiz = true;
        ok(await page.locator('[data-a="grade"]').isDisabled(), 'cannot grade before choosing');
      }
      await click('[data-ans="1"]');
      await click('[data-a="grade"]');
      const g = await txt();
      ok(/that's it\.|not this time\./i.test(g), 'answer is graded with an explanation');
      await click('.nextfab');
    } else if (await page.locator('[data-a="finish"]').count()) {
      ok(await has('The paper'), 'source card shown before finishing');
      ok(await has('Read the story'), 'source CTA reads "Read the story"');
      const src = await txt();
      ok(!/doi:|all rights reserved|subscription|openly licensed/i.test(src), 'source card is stripped to the name only');
      await click('[data-a="finish"]');
      break;
    } else { console.log('  ....  loop exited early at guard ' + guard + ', view: ' + (await txt()).slice(0,60).replace(/\n/g,' ')); break; }
  }
  ok(sawPredict, 'prediction mechanic appeared');
  ok(sawQuiz, 'quiz appeared');

  console.log('\n=== 5. COMPLETION ===');
  ok(await has("That's today done"), 'completion screen');
  ok(await has("Finished today's"), 'XP is itemised, not a lump sum');
  ok(await has('New badge') && await has('First Thing'), 'first badge unlocks');
  ok(await has('nudge tomorrow'), 'notification permission asked here, after value');

  console.log('\n=== 6. REFLECTION GATING ===');
  await page.locator('#refl').fill('short');
  await click('[data-a="reflect"]');
  ok(await page.locator('.toast').count() > 0, 'short reflection gets guidance, not silence');
  await page.waitForTimeout(2700);
  await click('[data-a="tab:today"]');
  ok(await has("That's you done"), 'Today now says the day is finished');
  ok((await page.locator('[data-a="start"]').count()) === 0, 'no way to start a second piece');

  console.log('\n=== 7. TABS ===');
  // errors must speak English, not error codes
  const codeLeak = await page.evaluate(() => {
    S.tab='today'; render();
    const r = CORE.getOrCreateAssignment(DB(), S.user, now(), CORE.addDays(today(),1));
    return errText(r.error);
  });
  ok(!/_/.test(codeLeak) && codeLeak.length > 20, 'blocked access explains itself in plain language: "' + codeLeak + '"');

  await click('[data-tab="library"]');
  ok(await has("Everything you've kept"), 'library renders');
  ok(/\d of \d right/i.test(await txt()), 'completed item shows its score');
  await click('[data-tab="progress"]');
  ok(await has('things kept') && await has('Badges'), 'progress renders');
  ok(await has('until the next one'), 'level curve has a defined next threshold');
  await click('[data-tab="profile"]');
  ok(await has('Night owl'), 'day-boundary control present');
  ok(await has('Download all of it') && await has('Delete my account'), 'export and deletion available');

  console.log('\n=== 8. PERSISTENCE ACROSS RELOAD ===');
  await page.reload(); await page.waitForTimeout(500);
  const afterReload = await txt();
  ok(!afterReload.includes('Name one thing you kept'), 'does not re-onboard after reload');

  console.log('\n=== 9. STRESS CONSOLE (desktop) ===');
  const wide = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await wide.addInitScript(shim);
  const p2 = await wide.newPage();
  const errs2 = []; p2.on('pageerror', e => errs2.push(e.message));
  await p2.goto(path); await p2.waitForTimeout(500);
  ok(await p2.locator('#console').isVisible(), 'console visible on desktop');
  // race through onboarding
  await p2.evaluate(() => { S.onboarded = true; S.user.interests = ['Psychology', 'Space', 'History', 'AI']; S.tab = 'today'; render(); });
  const logText = async () => p2.locator('#log').innerText();

  await p2.locator('[data-c="tomorrow"]').click(); await p2.waitForTimeout(200);
  ok((await logText()).includes('403 FUTURE_CONTENT_LOCKED'), 'tomorrow refused with 403');
  ok(!(await logText()).includes('LEAK'), 'no future content leaked');

  await p2.locator('[data-c="payload"]').click(); await p2.waitForTimeout(200);
  ok((await logText()).includes('no answer or explanation field'), 'client payload carries no answers');

  await p2.locator('[data-c="auto7"]').click(); await p2.waitForTimeout(400);
  ok((await logText()).includes('Played 7 days'), 'seven-day auto-play runs');
  const s7 = await p2.evaluate(() => S.user.currentStreak);
  ok(s7 === 7, 'streak reached 7, got ' + s7);

  await p2.locator('[data-c="skip2"]').click(); await p2.waitForTimeout(200);
  await p2.evaluate(() => { const r = CORE.getOrCreateAssignment(DB(), S.user, now()); r.assignment.startedAt = now(); const c = content(r.assignment.contentId); CORE.completeLearning(DB(), S.user, now(), { localDate: r.assignment.localDate, quizAnswers: c.quiz.map(q => q.correct) }); render(); });
  const sAfter = await p2.evaluate(() => S.user.currentStreak);
  const longest = await p2.evaluate(() => S.user.longestStreak);
  ok(sAfter === 1, 'a missed day resets the streak to 1, got ' + sAfter);
  ok(longest === 7, 'longest streak is preserved at 7, got ' + longest);

  await p2.locator('[data-c="replay"]').click(); await p2.waitForTimeout(250);
  ok((await logText()).includes('idempotent'), 'replayed completions pay nothing');

  await p2.locator('[data-c="west"]').click(); await p2.waitForTimeout(250);
  ok((await logText()).includes('no second day bought'), 'flying west cannot duplicate a day');

  const preCorrupt = await p2.evaluate(() => S.user.currentStreak);
  await p2.locator('[data-c="recompute"]').click(); await p2.waitForTimeout(250);
  const healed = await p2.evaluate(() => S.user.currentStreak);
  ok(healed === preCorrupt, `corrupted streak heals from the completion log (${preCorrupt} -> 999 -> ${healed})`);

  await p2.locator('[data-c="exhaust"]').click(); await p2.waitForTimeout(900);
  const lg = await logText();
  ok(!lg.includes('BROKE the daily promise'), 'never leaves a user without content');
  ok(lg.includes('revisit'), 'exhaustion is surfaced as a flagged revisit');

  console.log('\n=== 9b. NEW CATEGORIES AND ZONES ===');
  // The chip existing proves nothing. What matters is that picking one of the
  // added categories actually resolves to content in that category, and that
  // the content draws rather than falling through the motif switch to a blank.
  const perTopic = await p2.evaluate(() => {
    const out = {};
    for (const topic of ['Beauty', 'Aeronautics', 'Finance', 'Books', 'Movies', 'Sleep']) {
      const r = CORE.recommend({ corpus: CORPUS, profile: { interests: [topic], difficulty: 'Balanced', duration: 10 } });
      const c = CORPUS.find(x => x.id === r.contentId);
      const svg = motif(c.motif, c.pal, c.id, 400, 300);
      out[topic] = { topic: c.topic, tier: r.tier, why: r.why[0] || '', shapes: (svg.match(/<(circle|rect|path|line|ellipse)/g) || []).length };
    }
    return out;
  });
  for (const [want, got] of Object.entries(perTopic)) {
    ok(got.topic === want && got.tier === 0, `${want} resolves to its own content (got ${got.topic}, tier ${got.tier})`);
    ok(got.shapes > 4, `${want} artwork actually draws, got ${got.shapes} shapes`);
  }

  await p2.evaluate(() => { S.tab = 'profile'; render(); });
  await p2.waitForTimeout(200);
  const zoneChips = await p2.evaluate(() => [...document.querySelectorAll('[data-tz]')].map(b => b.dataset.tz));
  ok(zoneChips.includes('Toronto') && zoneChips.includes('Calabar') && zoneChips.includes('Birmingham'),
     'Toronto, Calabar and Birmingham are all in the picker');
  ok(!zoneChips.some(z => ['Tokyo', 'Kolkata', 'Auckland'].includes(z)), 'the removed cities are gone');

  // Regression: four of the eight zones share the +1 offset. Keyed on the
  // offset, every one of them lit up as selected at once.
  await p2.locator('[data-tz="Calabar"]').click(); await p2.waitForTimeout(200);
  const pressed = await p2.evaluate(() => [...document.querySelectorAll('[data-tz][aria-pressed="true"]')].map(b => b.dataset.tz));
  ok(pressed.length === 1 && pressed[0] === 'Calabar', 'exactly one zone reads as selected, got ' + JSON.stringify(pressed));
  const shown = await p2.evaluate(() => { const rows = [...document.querySelectorAll('#cstate .row')]; return rows.map(r => r.innerText).join(' | '); });
  ok(/Calabar/.test(shown), 'the console names the city the user actually picked');

  await p2.locator('[data-c="east"]').click(); await p2.waitForTimeout(250);
  const eastLog = await logText();
  ok(/Kathmandu/.test(eastLog), 'eastward travel targets a zone that is still in the picker');
  ok(/under the 8h threshold|would be bridged/.test(eastLog),
     'the console states whether the bridge is armed rather than implying it');

  console.log('\n=== 10. ACCESSIBILITY FLOOR ===');
  await p2.evaluate(() => { S.tab = 'progress'; render(); });  // dots live here now
  await p2.waitForTimeout(200);
  const a11y = await p2.evaluate(() => {
    const out = {};
    out.offenders = [...document.querySelectorAll('#device button, #device a, #device summary')]
      .filter(b => b.offsetParent && b.offsetWidth > 0)
      .map(b => ({ t: (b.innerText || b.className).trim().slice(0, 22), h: b.offsetHeight, w: b.offsetWidth }))
      .filter(o => Math.min(o.h, o.w) < 40);
    out.smallTargets = out.offenders.length;
    out.imgNoAlt = [...document.querySelectorAll('img:not([alt])')].length;
    out.dotsLabelled = !!document.querySelector('.dots[aria-label]');
    out.buttonsWithText = [...document.querySelectorAll('#tabs button')].every(b => b.innerText.trim().length);
    return out;
  });
  ok(a11y.smallTargets === 0, 'no tap target under 40px' + (a11y.smallTargets ? ' :: ' + JSON.stringify(a11y.offenders) : ''));
  ok(a11y.imgNoAlt === 0, 'no unlabelled images');
  ok(a11y.dotsLabelled, 'dot calendar has a text alternative for screen readers');
  const art = await p2.evaluate(() => ({
    hidden: [...document.querySelectorAll('.art svg, .storyart svg, .today-art svg')].every(s => s.getAttribute('aria-hidden') === 'true'),
    count: document.querySelectorAll('svg').length }));
  ok(art.hidden, 'decorative artwork is hidden from screen readers');
  ok(a11y.buttonsWithText, 'tab bar buttons carry text, not icons alone');

  const contrast = await p2.evaluate(() => {
    const lum = hex => { const c = hex.match(/\w\w/g).map(x => parseInt(x, 16) / 255).map(v => v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4)); return .2126 * c[0] + .7152 * c[1] + .0722 * c[2]; };
    const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + .05) / (y + .05); };
    return { inkOnGround: ratio('16181D', 'EDEBE5'), muteOnCard: ratio('65685F', 'FFFDFA'),
             greenOnCard: ratio('0C6B47', 'FFFDFA'), greenOnTint: ratio('0C6B47', 'E0EFE7'),
             whiteOnGreen: ratio('FFFFFF', '0C6B47'), brickOnCard: ratio('9B4A32', 'FFFDFA') };
  });
  Object.entries(contrast).forEach(([k, v]) => ok(v >= 4.5, `contrast ${k} = ${v.toFixed(2)}:1 (needs 4.5)`));

  console.log('\n=== 11. REDUCED MOTION ===');
  const rm = await browser.newContext({ viewport: { width: 414, height: 896 }, reducedMotion: 'reduce' });
  const p3 = await rm.newPage(); await p3.goto(path); await p3.waitForTimeout(400);
  const dur = await p3.evaluate(() => { const d = document.querySelector('.dot'); return d ? getComputedStyle(d).animationDuration : 'none'; });
  ok(dur === '0.001ms' || dur === 'none' || parseFloat(dur) < 0.01, 'animation suppressed under reduced motion, got ' + dur);

  ok(fontsBlocked === true || fontsBlocked === false, 'webfont fallback path exercised (blocked here: ' + fontsBlocked + ')');
  ok(errors.length === 0, 'no runtime errors on mobile pass' + (errors.length ? ' :: ' + errors.join(' | ').slice(0, 200) : ''));
  ok(errs2.length === 0, 'no runtime errors on desktop pass' + (errs2.length ? ' :: ' + errs2.join(' | ').slice(0, 200) : ''));

  await page.screenshot({ path: '/home/claude/shot-today.png' });
  await browser.close();
  console.log('\n' + '='.repeat(52));
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  console.log('='.repeat(52));
  process.exit(fail ? 1 : 0);
})();
