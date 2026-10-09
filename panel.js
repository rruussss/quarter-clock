// Quarter Clock — live NFL + college football games sorted by time left in the quarter.
// Data: ESPN's public scoreboard JSON (site.api.espn.com), polled while the page is open.
(() => {
  'use strict';

  const FEEDS = [
    { league: 'NFL', key: 'nfl', url: 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard' },
    { league: 'CFB', key: 'cfb', url: 'https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?groups=80&limit=300' },
  ];
  const LIVE_POLL_MS = 8000;
  const IDLE_POLL_MS = 60000;
  const UPCOMING_WINDOW_H = 12;
  const UPCOMING_MAX = 20;

  const hasChrome = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id;

  // ---------- settings (per-browser convenience; safe if storage is unavailable) ----------
  const DEFAULTS = { nfl: true, cfb: true, halfOnly: false, alertAt: 120, sound: true, compact: false, awake: true, upOpen: true };
  const settings = (() => {
    try { return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem('qc.settings') || '{}')); }
    catch { return Object.assign({}, DEFAULTS); }
  })();
  const save = () => { try { localStorage.setItem('qc.settings', JSON.stringify(settings)); } catch {} };

  // ---------- state ----------
  let games = [];              // parsed games from all feeds
  let feedErrors = {};         // league -> message
  let lastOk = 0;              // timestamp of last successful fetch
  let timer = null;
  const prevClock = new Map(); // gameId -> {period, clock}
  const alerted = new Set();   // `${id}:${period}`
  const flashing = new Set();  // gameIds to flash on next render

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- parsing ----------
  const ord = (n) => (n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`);
  const periodLabel = (p) => (p <= 4 ? ord(p) : p === 5 ? 'OT' : `${p - 4}OT`);
  // "11:33" -> 693, "0:33" -> 33, "33.0" -> 33
  const parseClockText = (s) => {
    if (typeof s !== 'string') return null;
    let m = s.trim().match(/^(\d{1,2}):(\d{2})(?:\.\d+)?$/);
    if (m) return Number(m[1]) * 60 + Number(m[2]);
    m = s.trim().match(/^(\d{1,2})(?:\.\d+)?$/);
    return m ? Number(m[1]) : null;
  };
  const fmtClock = (sec) => {
    const s = Math.max(0, Math.round(sec));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  function parseEvent(ev, league) {
    const comp = (ev.competitions || [])[0] || {};
    const st = ev.status || comp.status || {};
    const type = st.type || {};
    const sit = comp.situation || {};
    const possId = sit.possession ? String(sit.possession) : null;

    const team = (c) => {
      const t = c.team || {};
      const rank = c.curatedRank && c.curatedRank.current;
      return {
        id: String(t.id || c.id || ''),
        abbr: t.abbreviation || t.shortDisplayName || '?',
        name: t.shortDisplayName || t.displayName || t.abbreviation || '?',
        logo: t.logo || '',
        score: c.score != null && c.score !== '' ? Number(c.score) : null,
        rank: rank && rank <= 25 ? rank : null,
        ball: possId && String(t.id) === possId,
      };
    };
    const cs = comp.competitors || [];
    const away = team(cs.find((c) => c.homeAway === 'away') || cs[1] || {});
    const home = team(cs.find((c) => c.homeAway === 'home') || cs[0] || {});

    const links = ev.links || [];
    const live = links.find((l) => (l.rel || []).includes('summary') || (l.rel || []).includes('live')) || links[0];
    const net = comp.broadcast || ((comp.broadcasts || [])[0] || {}).names?.[0] || '';

    // e.g. "3rd & 4 at MIA 38"
    let sitText = sit.downDistanceText || '';
    if (!sitText && sit.shortDownDistanceText) {
      sitText = sit.shortDownDistanceText + (sit.possessionText ? ` at ${sit.possessionText}` : '');
    }

    const period = Number(st.period) || 0;
    // Read the clock from ESPN's display text first; its numeric "clock" field has been seen
    // dropping the minutes (e.g. 33 for "11:33").
    const rawClock = typeof st.clock === 'number' ? st.clock : null;
    const textClock = parseClockText(st.displayClock);
    const clock = textClock != null ? textClock : rawClock;
    // CFB overtime has no game clock; NFL OT does (10:00 regular season).
    const hasClock = clock != null && !(league === 'CFB' && period > 4);

    return {
      id: `${league}-${ev.id}`,
      eventId: String(ev.id),
      compId: String(comp.id || ev.id),
      league,
      rawClock,
      state: type.state || 'pre',        // pre | in | post
      statusName: type.name || '',
      shortDetail: type.shortDetail || type.detail || '',
      period, clock, hasClock,
      displayClock: st.displayClock || (clock != null ? fmtClock(clock) : ''),
      away, home,
      sit: sitText,
      redZone: !!sit.isRedZone,
      net,
      href: (live && live.href) || `https://www.espn.com/${league === 'NFL' ? 'nfl' : 'college-football'}/game/_/gameId/${ev.id}`,
      start: new Date(ev.date || comp.date || 0),
    };
  }

  const BREAK_STATUSES = new Set(['STATUS_HALFTIME', 'STATUS_END_PERIOD']);
  function classify(g) {
    if (g.state === 'post') return 'final';
    if (g.state === 'pre') return 'pre';
    if (BREAK_STATUSES.has(g.statusName)) return 'break';
    if (/DELAY|SUSPEND/i.test(g.statusName)) return 'break';
    return 'live';
  }

  // ---------- fetching ----------
  async function getJSON(url, ms) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), ms);
    try {
      const r = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } finally { clearTimeout(to); }
  }

  async function fetchFeed(feed) {
    const j = await getJSON(feed.url, 9000);
    return (j.events || []).map((e) => parseEvent(e, feed.league));
  }

  // ---------- clock cross-check ----------
  // ESPN's scoreboard occasionally sends a bad clock (or lags a few minutes). For live games we also
  // read ESPN's small per-game status feed and only show a clock that is physically possible:
  // a game clock can't run down faster than real time.
  const CORE_LEAGUE = { NFL: 'nfl', CFB: 'college-football' };
  const seen = new Map(); // gameId -> { period, clock, since, bad }
  let pollCount = 0;

  async function fetchCore(g) {
    const url = `https://sports.core.api.espn.com/v2/sports/football/leagues/${CORE_LEAGUE[g.league]}/events/${g.eventId}/competitions/${g.compId}/status`;
    const j = await getJSON(url, 6000);
    const t = j.type || {};
    const text = parseClockText(j.displayClock);
    return {
      src: 'game feed', period: Number(j.period) || 0,
      clock: text != null ? text : (typeof j.clock === 'number' ? j.clock : null),
      statusName: t.name || '', state: t.state || '', shortDetail: t.shortDetail || '',
    };
  }

  async function mapLimit(items, n, fn) {
    const out = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) { const k = next++; try { out[k] = await fn(items[k]); } catch { out[k] = null; } }
    }));
    return out;
  }

  const ahead = (a, b) => a.period > b.period || (a.period === b.period && a.clock < b.clock);

  async function reconcile(list) {
    const now = Date.now();
    pollCount++;
    const live = list.filter((g) => g.state === 'in' && g.hasClock);
    const liveIds = new Set(live.map((g) => g.id));
    for (const id of seen.keys()) if (!liveIds.has(id)) seen.delete(id);

    // Games near the end of a quarter (or acting up) get checked every poll; the rest every 4th poll.
    const due = live.filter((g) => {
      const s = seen.get(g.id);
      return g.clock <= 420 || (s && (s.clock <= 420 || s.bad)) || pollCount % 4 === 1;
    }).sort((a, b) => a.clock - b.clock).slice(0, 24);
    const cores = await mapLimit(due, 8, fetchCore);
    const coreById = new Map();
    due.forEach((g, i) => { const c = cores[i]; if (c && c.clock != null && c.state === 'in' && c.period) coreById.set(g.id, c); });

    for (const g of live) {
      const sb = { src: 'scoreboard', period: g.period, clock: g.clock, statusName: g.statusName, shortDetail: g.shortDetail };
      const core = coreById.get(g.id);
      const prev = seen.get(g.id);
      if (g.rawClock != null && Math.abs(g.rawClock - g.clock) > 2) {
        console.warn('[Quarter Clock] ESPN numeric clock disagrees with its display text', g.id, g.rawClock, g.displayClock);
      }
      // Possible = not running backwards a period, and not dropping more than the real time that has
      // passed since the clock last changed, plus 3 min of slack for ESPN catching up after a lag.
      const SLACK = 180;
      const possible = (r) => !prev || r.period > prev.period ||
        (r.period === prev.period && (r.clock >= prev.clock || prev.clock - r.clock <= (now - prev.since) / 1000 + SLACK));

      let pick = sb;
      g.glitch = '';
      if (core && core.period === sb.period && Math.abs(core.clock - sb.clock) > SLACK) {
        // The two feeds are minutes apart, so one is wrong: go with the one closer to what we last
        // showed (or the later clock on first sight), and flag it if the other claimed less time left.
        pick = prev && prev.period === sb.period
          ? (Math.abs(core.clock - prev.clock) <= Math.abs(sb.clock - prev.clock) ? core : sb)
          : (core.clock >= sb.clock ? core : sb);
        const other = pick === core ? sb : core;
        if (other.clock < pick.clock) g.glitch = `ESPN ${other.src} said ${fmtClock(other.clock)}; ${pick.src} says ${fmtClock(pick.clock)}`;
      } else if (core) {
        pick = ahead(sb, core) ? sb : core; // otherwise just use whichever feed is further along
      }

      if (prev && pick.period === prev.period && pick.clock > prev.clock && pick.src !== prev.src) {
        // A staler feed showing more time left than we already know about: keep the fresher clock.
        g.clock = prev.clock; g.period = prev.period;
        continue;
      }
      if (prev && !possible(pick) && (prev.bad || 0) + 1 < 3) {
        // Hold the last good clock; if ESPN keeps saying it for 3 polls in a row, believe it.
        prev.bad = (prev.bad || 0) + 1;
        g.glitch = `ESPN sent ${fmtClock(pick.clock)} (${periodLabel(pick.period)}), which isn't possible yet. Showing last good clock.`;
        console.warn('[Quarter Clock] held implausible clock', g.id, { scoreboard: sb, core, prev });
        g.clock = prev.clock; g.period = prev.period;
        continue;
      }

      if (pick.src !== 'scoreboard') {
        if (pick.statusName) g.statusName = pick.statusName;
        if (pick.shortDetail) g.shortDetail = pick.shortDetail;
      }
      g.clock = pick.clock; g.period = pick.period;
      const changed = !prev || prev.period !== pick.period || prev.clock !== pick.clock;
      seen.set(g.id, { period: pick.period, clock: pick.clock, src: pick.src, since: changed ? now : prev.since, bad: 0 });
    }
  }

  async function refresh() {
    clearTimeout(timer);
    const results = await Promise.allSettled(FEEDS.map(fetchFeed));
    const next = [];
    let anyOk = false;
    results.forEach((res, i) => {
      const lg = FEEDS[i].league;
      if (res.status === 'fulfilled') { anyOk = true; delete feedErrors[lg]; next.push(...res.value); }
      else {
        feedErrors[lg] = res.reason && res.reason.name === 'AbortError' ? 'timed out' : String(res.reason && res.reason.message || res.reason);
        next.push(...games.filter((g) => g.league === lg)); // keep last known data for that league
      }
    });
    if (anyOk) lastOk = Date.now();
    try { await reconcile(next); } catch (e) { console.warn('[Quarter Clock] cross-check failed', e); }
    games = next;
    checkAlerts();
    render();
    const anyLive = games.some((g) => g.state === 'in');
    timer = setTimeout(refresh, anyLive ? LIVE_POLL_MS : IDLE_POLL_MS);
  }

  // ---------- filtering / sorting ----------
  const leagueOn = (g) => (g.league === 'NFL' ? settings.nfl : settings.cfb);
  const periodOn = (g) => !settings.halfOnly || g.period === 2 || g.period >= 4;
  const quarterLen = (g) => (g.period > 4 ? (g.league === 'NFL' ? 600 : 900) : 900);

  function liveSortKey(g) {
    if (!g.hasClock) return 1e6 + g.period; // CFB OT to the bottom of live
    return g.clock;
  }

  // ---------- alerts ----------
  let audioCtx = null;
  function beep() {
    if (!settings.sound) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const t0 = audioCtx.currentTime;
      [0, 0.22].forEach((dt, i) => {
        const o = audioCtx.createOscillator(); const gn = audioCtx.createGain();
        o.type = 'sine'; o.frequency.value = i ? 1175 : 880;
        gn.gain.setValueAtTime(0.0001, t0 + dt);
        gn.gain.exponentialRampToValueAtTime(0.25, t0 + dt + 0.02);
        gn.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.18);
        o.connect(gn).connect(audioCtx.destination); o.start(t0 + dt); o.stop(t0 + dt + 0.2);
      });
    } catch {}
  }

  function notify(g) {
    const title = `${fmtClock(g.clock)} left in ${periodLabel(g.period)}${g.period === 2 ? ' (half)' : g.period === 4 ? ' (game)' : ''}`;
    const body = `${g.away.abbr} ${g.away.score ?? ''} @ ${g.home.abbr} ${g.home.score ?? ''} · ${g.league}${g.net ? ' · ' + g.net : ''}`;
    try {
      if ('Notification' in window && Notification.permission === 'granted') {
        const n = new Notification(title, { body, icon: 'icon-180.png', tag: g.id, silent: true });
        n.onclick = () => { window.open(g.href, '_blank'); n.close(); };
      }
    } catch {}
  }

  function fireAlert(g) { flashing.add(g.id); beep(); notify(g); }

  function checkAlerts() {
    const th = Number(settings.alertAt) || 0;
    for (const g of games) {
      if (classify(g) !== 'live' || !g.hasClock) { prevClock.delete(g.id); continue; }
      const prev = prevClock.get(g.id);
      prevClock.set(g.id, { period: g.period, clock: g.clock });
      if (!th || !leagueOn(g) || !periodOn(g)) continue;
      const key = `${g.id}:${g.period}`;
      if (alerted.has(key)) continue;
      // Fire only when we watched it cross the line (not for games already under it when the panel opened).
      if (prev && prev.period === g.period && prev.clock > th && g.clock <= th) {
        alerted.add(key);
        fireAlert(g);
      }
    }
  }

  // ---------- rendering ----------
  function teamRow(t, other, showScore) {
    const lead = showScore && t.score != null && other.score != null && t.score > other.score;
    return `<div class="tm${lead ? ' lead' : ''}${t.ball ? ' hasball' : ''}">
      ${t.logo ? `<img src="${esc(t.logo)}" alt="" loading="lazy">` : ''}
      <span class="nm">${t.rank ? `<span class="rk">${t.rank}</span>` : ''}${esc(t.abbr)}</span>
      <span class="poss" title="Possession"></span>
      ${showScore ? `<span class="sc">${t.score ?? ''}</span>` : ''}
    </div>`;
  }

  function liveCard(g) {
    const th = Number(settings.alertAt) || 120;
    let heat = '';
    if (g.hasClock) heat = g.clock <= Math.max(th, 120) ? 'hot' : g.clock <= 300 ? 'warm' : '';
    const pct = g.hasClock ? Math.min(100, Math.max(0, (1 - g.clock / quarterLen(g)) * 100)) : 100;
    const badge = g.period === 2 ? '<span class="badge" title="Clock runs to halftime">HALF</span>'
      : g.period === 4 ? '<span class="badge" title="Clock runs to end of regulation">END</span>' : '';
    const t = g.hasClock ? fmtClock(g.clock) : periodLabel(g.period);
    const gl = g.glitch ? `<span class="gl" title="${esc(g.glitch)}">⚠</span>` : '';
    const p = g.hasClock ? `${periodLabel(g.period)}${badge}${gl}` : 'overtime';
    return `<a class="game ${heat}${flashing.has(g.id) ? ' flash' : ''}" href="${esc(g.href)}" target="_blank" rel="noopener" data-id="${esc(g.id)}">
      <div class="clk"><span class="t">${t}</span><span class="p">${p}</span></div>
      <div class="teams">${teamRow(g.away, g.home, true)}${teamRow(g.home, g.away, true)}</div>
      <div class="meta"><span class="lg">${g.league}</span>
        ${g.redZone ? '<span class="rz">RZ</span>' : ''}
        ${g.glitch ? `<span class="glt">${esc(g.glitch)}</span>` : g.sit ? `<span class="sit">${esc(g.sit)}</span>` : ''}
        ${g.net ? `<span class="net">${esc(g.net)}</span>` : ''}</div>
      <div class="bar"><i style="width:${pct.toFixed(1)}%"></i></div>
    </a>`;
  }

  function breakCard(g) {
    let label = g.shortDetail || 'Break';
    let sub = '';
    if (g.statusName === 'STATUS_HALFTIME') { label = 'Half'; sub = 'next: 3rd'; }
    else if (g.statusName === 'STATUS_END_PERIOD') {
      label = `End ${periodLabel(g.period)}`;
      sub = g.period < 4 ? `next: ${periodLabel(g.period + 1)}` : 'to OT';
    } else if (/DELAY/i.test(g.statusName)) { label = 'Delay'; sub = periodLabel(g.period); }
    return `<a class="game brk" href="${esc(g.href)}" target="_blank" rel="noopener">
      <div class="clk"><span class="t">${esc(label)}</span><span class="p">${esc(sub)}</span></div>
      <div class="teams">${teamRow(g.away, g.home, true)}${teamRow(g.home, g.away, true)}</div>
      <div class="meta"><span class="lg">${g.league}</span>${g.net ? `<span class="net">${esc(g.net)}</span>` : ''}</div>
    </a>`;
  }

  function untilText(d) {
    const m = Math.round((d - Date.now()) / 60000);
    if (m <= 0) return 'starting';
    if (m < 60) return `in ${m}m`;
    return `in ${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
  }

  function preCard(g) {
    const time = g.start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return `<a class="game pre" href="${esc(g.href)}" target="_blank" rel="noopener">
      <div class="clk"><span class="t">${esc(time)}</span><span class="p">${untilText(g.start)}</span></div>
      <div class="teams">${teamRow(g.away, g.home, false)}${teamRow(g.home, g.away, false)}</div>
      <div class="meta"><span class="lg">${g.league}</span>${g.net ? `<span class="net">${esc(g.net)}</span>` : ''}</div>
    </a>`;
  }

  function render() {
    const vis = games.filter(leagueOn);
    const live = vis.filter((g) => classify(g) === 'live' && periodOn(g)).sort((a, b) => liveSortKey(a) - liveSortKey(b) || a.league.localeCompare(b.league));
    const hiddenByQ = vis.filter((g) => classify(g) === 'live' && !periodOn(g)).length;
    const brk = vis.filter((g) => classify(g) === 'break').sort((a, b) => b.period - a.period);
    const horizon = Date.now() + UPCOMING_WINDOW_H * 3600e3;
    const pre = vis.filter((g) => classify(g) === 'pre' && g.start.getTime() < horizon && g.start.getTime() > Date.now() - 3 * 3600e3)
      .sort((a, b) => a.start - b.start);
    const finals = vis.filter((g) => classify(g) === 'final').length;

    let html = '';
    const errs = Object.entries(feedErrors);
    if (errs.length) html += `<div class="err">Couldn't refresh ${errs.map(([k, v]) => `${k} (${esc(v)})`).join(', ')} — showing last data.</div>`;

    html += `<div class="sec">Live — by time left in quarter <span class="n">${live.length}${hiddenByQ ? ` · ${hiddenByQ} hidden (Q1/Q3)` : ''}</span></div>`;
    html += live.length ? live.map(liveCard).join('') : `<div class="empty">No live games${hiddenByQ ? ' in Q2/Q4 right now' : ' right now'}.</div>`;

    if (brk.length) {
      html += `<div class="sec">At a break <span class="n">${brk.length}</span></div>`;
      html += brk.map(breakCard).join('');
    }

    if (pre.length) {
      const shown = pre.slice(0, UPCOMING_MAX);
      html += `<details class="up"${settings.upOpen ? ' open' : ''}><summary><div class="sec">Up next <span class="n">${pre.length}${pre.length > shown.length ? ` · first ${shown.length}` : ''}</span></div></summary>`;
      html += shown.map(preCard).join('') + '</details>';
    }
    if (finals) html += `<div class="sec">Final <span class="n">${finals} game${finals === 1 ? '' : 's'} (hidden)</span></div>`;

    $('main').innerHTML = html;
    const det = document.querySelector('details.up');
    if (det) det.addEventListener('toggle', () => { settings.upOpen = det.open; save(); });
    flashing.clear();

    // Toolbar badge = number of live games under 2:00 (or the alert threshold, if higher)
    const th = Math.max(Number(settings.alertAt) || 0, 120);
    const hot = live.filter((g) => g.hasClock && g.clock <= th).length;
    document.title = hot ? `(${hot}) Quarter Clock` : 'Quarter Clock';
    if (hasChrome && chrome.action && chrome.action.setBadgeText) {
      try {
        chrome.action.setBadgeText({ text: hot ? String(hot) : '' });
        chrome.action.setBadgeBackgroundColor({ color: '#d1242f' });
      } catch {}
    }
    updateStatus();
  }

  function updateStatus() {
    const dot = $('dot');
    const errs = Object.keys(feedErrors).length;
    if (!lastOk) { $('updated').textContent = errs ? 'Offline' : 'Loading…'; dot.className = errs ? 'dot err' : 'dot'; return; }
    const s = Math.round((Date.now() - lastOk) / 1000);
    $('updated').textContent = s < 5 ? 'Updated just now' : s < 90 ? `Updated ${s}s ago` : `Updated ${Math.round(s / 60)}m ago`;
    dot.className = 'dot ' + (errs || s > 45 ? 'err' : 'ok');
  }

  // ---------- controls ----------
  function bindChip(id, key, after) {
    const el = $(id);
    const sync = () => el.setAttribute('aria-pressed', String(!!settings[key]));
    sync();
    el.addEventListener('click', () => { settings[key] = !settings[key]; sync(); save(); if (after) after(); render(); });
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click(); } });
    el.tabIndex = 0;
  }
  function ensureNotifyPermission() {
    try {
      if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
    } catch {}
    // Unlock audio on a user gesture so later beeps are allowed.
    try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); audioCtx.resume(); } catch {}
  }

  bindChip('f-nfl', 'nfl');
  bindChip('f-cfb', 'cfb');
  bindChip('f-half', 'halfOnly');
  bindChip('f-sound', 'sound', ensureNotifyPermission);
  const applyCompact = () => document.body.classList.toggle('compact', !!settings.compact);
  bindChip('f-compact', 'compact', applyCompact);
  applyCompact();
  // Hide team logos that fail to load (no inline handlers allowed in extension pages).
  $('main').addEventListener('error', (e) => { if (e.target && e.target.tagName === 'IMG') e.target.classList.add('gone'); }, true);
  $('alertAt').value = String(settings.alertAt);
  $('alertAt').addEventListener('change', (e) => { settings.alertAt = Number(e.target.value); save(); ensureNotifyPermission(); render(); });
  $('refresh').addEventListener('click', () => { ensureNotifyPermission(); refresh(); });
  $('testAlert').addEventListener('click', () => {
    ensureNotifyPermission();
    const g = games.find((x) => classify(x) === 'live' && x.hasClock) || {
      id: 'test', league: 'NFL', period: 2, clock: 118, net: 'TEST', href: 'https://www.espn.com/nfl/scoreboard',
      away: { abbr: 'AWY', score: 10 }, home: { abbr: 'HME', score: 14 },
    };
    setTimeout(() => { flashing.add(g.id); beep(); notify(Object.assign({}, g, { clock: g.clock })); render(); }, 150);
  });
  $('popout').addEventListener('click', () => {
    const url = hasChrome ? chrome.runtime.getURL('panel.html') : location.href;
    if (hasChrome && chrome.windows && chrome.windows.create) {
      chrome.windows.create({ url, type: 'popup', width: 380, height: 820 });
    } else {
      window.open(url, 'quarterclock', 'popup,width=380,height=820');
    }
  });
  // iPad/iPhone: audio only plays after a tap, so unlock it on the first touch anywhere.
  function unlockAudio() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const buf = audioCtx.createBuffer(1, 1, 22050); const src = audioCtx.createBufferSource();
      src.buffer = buf; src.connect(audioCtx.destination); src.start(0);
    } catch {}
  }
  document.addEventListener('pointerdown', () => { unlockAudio(); syncWake(); }, { once: true });

  // Keep the screen awake (web page only; the Chrome extension doesn't need it).
  let wakeLock = null;
  const wakeSupported = !hasChrome && 'wakeLock' in navigator;
  async function syncWake() {
    if (!wakeSupported) return;
    try {
      if (settings.awake && document.visibilityState === 'visible') {
        if (!wakeLock) {
          wakeLock = await navigator.wakeLock.request('screen');
          wakeLock.addEventListener('release', () => { wakeLock = null; });
        }
      } else if (wakeLock) { await wakeLock.release(); wakeLock = null; }
    } catch {}
  }
  if (wakeSupported) { $('f-awake').hidden = false; bindChip('f-awake', 'awake', syncWake); syncWake(); }

  // Timers pause while a tab/app is in the background (iPad especially) — catch up as soon as it's visible again.
  document.addEventListener('visibilitychange', () => {
    syncWake();
    if (document.visibilityState === 'visible' && Date.now() - lastOk > 5000) refresh();
  });

  // Pop-out only makes sense on desktop.
  if (!hasChrome && window.matchMedia && matchMedia('(pointer: coarse)').matches) $('popout').hidden = true;

  // In extension pages, the "notifications" permission pre-grants web notifications.
  setInterval(updateStatus, 1000);
  // Keep "in 42m" countdowns fresh between slow idle polls.
  setInterval(() => { if (!games.some((g) => g.state === 'in')) render(); }, 30000);
  refresh();

  // Test hook (used only by automated tests)
  window.__qc = { parseEvent, classify, get games() { return games; }, set games(v) { games = v; }, render, checkAlerts, settings };
})();
