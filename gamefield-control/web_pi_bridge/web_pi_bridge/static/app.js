// Robotics Dojo control page - all front-end logic in one file.
// One continuous page (no hidden sections). Sections: helpers, run state, timer (full screen + keys),
// competition (teams, navbar scoreboard for nav2 / behaviour trees),
// screen + detection, dispenser, obstacles, barrier (automatic sequence + manual gate), map requests (judges),
// finish run, shell (sidebar / theme / pollers) - the shell must stay last.
// Anything that comes from teams (names, labels) is inserted with textContent.

// ======================================================================
// HELPERS
// ======================================================================
const $ = (id) => document.getElementById(id);

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
}

function icon(name) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', 'ic');
    const use = document.createElementNS(ns, 'use');
    use.setAttribute('href', '#i-' + name);
    svg.appendChild(use);
    return svg;
}

async function api(path, body, method) {
    const res = await fetch(path, {
        method: method || (body === undefined ? 'GET' : 'POST'),
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    return res.json();
}

const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
};

function fmt(ms) {
    if (ms === null || ms === undefined) return '—';
    const t = Math.max(0, Math.floor(ms / 100));
    const m = Math.floor(t / 600), s = Math.floor(t / 10) % 60, d = t % 10;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${d}`;
}

// Screen categories are folder names on the Pi (screen_images/test_images/<name>).
// Metal tries 'metal' first and falls back to the old folder name 'other', so the page works
// both before and after the Pi's folder is renamed.
const CLASS_LABEL = { metal: 'Metal', organic: 'Organic', plastic: 'Plastic' };
const SCREEN_CATEGORY = { metal: ['metal', 'other'], organic: ['organic'], plastic: ['plastic'] };
function normClass(s) {
    s = (s || '').toLowerCase();
    if (s === 'other' || s === 'metal') return 'metal';
    return s === 'organic' || s === 'plastic' ? s : '';
}
const classLabel = (c) => CLASS_LABEL[c] || '—';

// Challenges that get a time on the scoreboard. Runs saved before this existed have no category = autonomy.
// (SLAM was removed as a challenge: runs already saved as 'slam' stay in the data file but are not shown.)
const CATS = [['nav2', 'Nav2'], ['autonomy', 'Behaviour Trees']];
const catLabel = (c) => (CATS.find((x) => x[0] === c) || CATS[1])[1];
const NEXT_CHALLENGE = { nav2: 'autonomy' };       // order each team plays them in; Behaviour Trees is last
const catOf = (r) => (r && r.category === 'nav2' ? 'nav2' : 'autonomy');
const isShown = (r) => !!r && r.category !== 'slam';

// Fit a box of a fixed shape (width / height = ratio) into the biggest size its stage allows, and keep it that
// size as the window changes. The stage is position:relative and the box is position:absolute (see .stage / .fit),
// so the box never changes the size of the stage it is measured against.
function fitBox(stage, box, ratio) {
    const fit = () => {
        const w = stage.clientWidth, h = stage.clientHeight;
        if (!w || !h) return;
        let bw = w, bh = w / ratio;
        if (bh > h) { bh = h; bw = h * ratio; }
        box.style.width = Math.floor(bw) + 'px';
        box.style.height = Math.floor(bh) + 'px';
    };
    if (window.ResizeObserver) new ResizeObserver(fit).observe(stage);
    window.addEventListener('resize', fit);
    fit();
}

// A collapsible log (<details class="logbox">): remembers whether it was left open, and keeps the count and the
// newest line visible in the bar so a closed log still says what is going on.
function logBox(detailsId, boxId, countId, lastId, clearId, emptyText) {
    const det = $(detailsId), box = $(boxId);
    det.open = store.get('dojoLogOpen_' + detailsId, false);
    det.addEventListener('toggle', () => store.set('dojoLogOpen_' + detailsId, det.open));
    const meta = (text, cls) => {
        $(countId).textContent = String(box.querySelectorAll('div:not(.empty)').length);
        $(lastId).textContent = text;
        $(lastId).dataset.kind = cls || '';
    };
    const clear = () => { box.replaceChildren(el('div', 'empty', emptyText)); meta(emptyText, ''); };
    // the Clear button sits inside the <summary>: do not let that click open / close the log
    $(clearId).addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); clear(); });
    clear();
    return {
        add(text, cls, stamp) {
            const empty = box.querySelector('.empty');
            if (empty) empty.remove();
            const line = el('div', cls || '');
            line.appendChild(el('span', 't', stamp));
            line.appendChild(document.createTextNode(text));
            box.appendChild(line);
            box.scrollTop = box.scrollHeight;
            meta(text, cls);
        },
    };
}

// true while the user is typing / choosing in a form control (keyboard timer shortcuts stay out of the way)
function isTyping(t) {
    return !!t && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');
}

function toast(title, msg, actionLabel, action, ms, tag) {
    if (tag) document.querySelectorAll(`.toast[data-tag="${tag}"]`).forEach((x) => x.remove());
    const t = el('div', 'toast');
    if (tag) t.dataset.tag = tag;
    const body = el('div', 'toast-body');
    body.appendChild(el('div', 'toast-title', title));
    if (msg) body.appendChild(el('div', 'toast-msg', msg));
    t.appendChild(body);
    const close = () => { t.classList.add('bye'); setTimeout(() => t.remove(), 200); };
    if (actionLabel) {
        const b = el('button', 'btn btn-accent btn-sm', actionLabel);
        b.addEventListener('click', () => { action(); close(); });
        t.appendChild(b);
    }
    const x = el('button', 'x');
    x.setAttribute('aria-label', 'Dismiss');
    x.appendChild(icon('x'));
    x.addEventListener('click', close);
    t.appendChild(x);
    $('toasts').appendChild(t);
    setTimeout(close, ms || 2000);
}

// ======================================================================
// RUN STATE
// ======================================================================
// The run being tracked lives in this browser (localStorage), so a refresh mid-run
// loses nothing. It is sent to the server only when finalised.
function newRun(team, category) {
    return { team: team || '', category: category || 'nav2', running: false, startedAt: 0, elapsedMs: 0, epochStart: 0,
             displayed: '',
             loadedMs: null, stoppedMs: null, notes: '' };
}
let run = Object.assign(newRun(), store.get('dojoRun', {}));
if (run.category !== 'nav2' && run.category !== 'autonomy') run.category = 'nav2';      // a run saved while SLAM existed
const runListeners = [];
function onRun(fn) { runListeners.push(fn); }
function saveRun() { store.set('dojoRun', run); runListeners.forEach((fn) => fn()); }
const elapsed = () => (run.running ? Date.now() - run.startedAt : run.elapsedMs);


// ======================================================================
// TIMER (full screen, keyboard controlled)
// ======================================================================
(function () {
    const fsEl = $('timer-fs');
    let fsOpen = false;
    const STAGE_NAME = { home: 'Setup', screen: 'Gamefield screen', loading: 'Loading station',
                         obstacles: 'Dynamic obstacles', barrier: 'Barrier', end: 'End run' };

    function tick() {
        const t = fmt(elapsed());
        $('timer-display').textContent = t;
        $('tfs-display').textContent = t;
        $('timer').classList.toggle('running', run.running);
        fsEl.classList.toggle('running', run.running);
    }
    setInterval(() => { if (run.running) tick(); }, 100);

    // ---- full screen timer: collapses back to the compact timer in the top bar
    window.setTimerFs = (open) => {
        fsOpen = !!open;
        fsEl.hidden = !fsOpen;
        document.body.classList.toggle('fs-open', fsOpen);
        $('timer-expand').classList.toggle('active', fsOpen);
        if (!fsOpen && document.fullscreenElement) document.exitFullscreen().catch(() => {});
    };
    window.setStageLabel = (name) => { $('tfs-stage').textContent = STAGE_NAME[name] || ''; };

    window.startRun = () => {
        if (run.running) return;
        if (!run.team) {
            window.go('home');
            return;
        }
        const resuming = run.elapsedMs > 0;
        run.startedAt = Date.now() - run.elapsedMs;
        if (!resuming) run.epochStart = Date.now();
        run.running = true;
        run.stoppedMs = null;
        saveRun();
        window.pushCurrent();
        // the only notification left: an offer (not an automatic switch) to open the big timer
        if (!fsOpen) toast('Full screen timer', 'Press F, or open it here.', 'Full screen', () => window.setTimerFs(true), 2000, 'fs');
    };

    window.stopRun = () => {
        if (!run.running) return;
        run.elapsedMs = Date.now() - run.startedAt;
        run.running = false;
        run.stoppedMs = run.elapsedMs;
        saveRun();
        window.pushCurrent();
    };

    window.resetTimer = () => {
        if (run.running) return;                 // stop the timer first
        if (!run.elapsedMs) return;
        if (!confirm('Reset the timer to 00:00.0?')) return;
        Object.assign(run, { running: false, startedAt: 0, elapsedMs: 0, epochStart: 0,
                             stoppedMs: null, loadedMs: null });
        saveRun();
        window.pushCurrent();
    };

    window.timerFsOpen = () => fsOpen;
    const toggleRun = () => (run.running ? window.stopRun() : window.startRun());

    $('timer-start').addEventListener('click', window.startRun);
    $('timer-stop').addEventListener('click', window.stopRun);
    $('home-start').addEventListener('click', window.startRun);
    $('timer').addEventListener('click', () => window.setTimerFs(!fsOpen));
    $('timer-expand').addEventListener('click', () => window.setTimerFs(!fsOpen));
    $('tfs-toggle').addEventListener('click', toggleRun);
    $('tfs-reset').addEventListener('click', window.resetTimer);
    $('timer-end').addEventListener('click', () => window.endRun());
    $('tfs-end').addEventListener('click', () => window.endRun());
    $('tfs-collapse').addEventListener('click', () => window.setTimerFs(false));
    $('tfs-screen').addEventListener('click', () => {
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        else if (fsEl.requestFullscreen) fsEl.requestFullscreen().catch(() => {});
    });

    // ---- keyboard, like a normal timer
    //   Space  start / stop (resume)      R  reset (when stopped)
    //   F      full screen on / off       Esc  close scoreboard, then collapse the timer
    //   S      scoreboard
    document.addEventListener('keydown', (e) => {
        if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
        const k = e.key;
        if (k === ' ' || k === 'Spacebar') {
            e.preventDefault();                  // also stops Space from "clicking" a focused button
            if (!e.repeat) toggleRun();
            return;
        }
        if (e.repeat) return;
        if (k === 'r' || k === 'R') window.resetTimer();
        else if (k === 'f' || k === 'F') window.setTimerFs(!fsOpen);
        else if (k === 's' || k === 'S') window.toggleScoreboard();
        else if (k === 'Escape') {
            if (!$('sb-panel').hidden) window.toggleScoreboard(false);
            else if (fsOpen) window.setTimerFs(false);
        }
    });
    document.addEventListener('keyup', (e) => {
        if ((e.key === ' ' || e.key === 'Spacebar') && !isTyping(e.target)) e.preventDefault();
    });
    // a select / checkbox that keeps focus would swallow Space, so let go of it after a change
    document.addEventListener('change', (e) => {
        if (e.target.tagName === 'SELECT' || e.target.type === 'checkbox') e.target.blur();
    });

    onRun(() => {
        tick();
        const resume = !run.running && run.elapsedMs > 0;
        $('timer-start').disabled = run.running;
        $('timer-stop').disabled = !run.running;
        $('timer-start').querySelector('span').textContent = resume ? 'Resume' : 'Start';
        $('timer-start').title = resume ? 'Resume' : 'Start';          // hover labels: Start / Pause / End run
        $('timer-stop').title = 'Pause';
        $('home-start').disabled = run.running;
        const canEnd = !!run.team && (run.running || run.elapsedMs > 0);       // something has been timed
        $('timer-end').disabled = !canEnd;
        $('tfs-end').disabled = !canEnd;

        const who = run.team ? `${run.team} · ${catLabel(run.category)}` : 'No team';
        $('team-chip').textContent = who;
        $('tfs-team').textContent = run.team || 'No team';
        $('tfs-cat').textContent = catLabel(run.category);

        const tg = $('tfs-toggle');
        tg.className = 'btn tfs-btn ' + (run.running ? 'btn-stop' : 'btn-go');
        tg.querySelector('use').setAttribute('href', run.running ? '#i-stop' : '#i-play');
        tg.querySelector('span').textContent = run.running ? 'Stop' : resume ? 'Resume' : 'Start';
        tg.dataset.tip = run.running ? 'Pause' : resume ? 'Resume' : 'Start';           // hover labels
        $('timer-start').dataset.tip = resume ? 'Resume' : 'Start';
        tg.title = run.running ? 'Pause' : resume ? 'Resume' : 'Start';
        fsEl.classList.toggle('stopped', resume);

        $('tfs-splits').replaceChildren(...[['Loaded', run.loadedMs], ['Stopped', run.stoppedMs]]
            .map(([name, v]) => {
                const d = el('div', 'tfs-split');
                d.append(el('span', '', name), el('b', '', fmt(v)));
                return d;
            }));
    });
})();

// ======================================================================
// COMPETITION: teams, challenge, navbar scoreboard, setup (talks to /api/competition)
// ======================================================================
(function () {
    let comp = { teams: [], runs: [], current: null };
    let sortKey = store.get('dojoSbSort', 'autonomy');      // 'team' | 'nav2' | 'autonomy'
    if (!['team', 'nav2', 'autonomy'].includes(sortKey)) sortKey = 'autonomy';     // was 'slam'

    window.pushCurrent = () => {
        api('/api/competition/current', { team: run.team, running: run.running, category: run.category,
            elapsed_ms: Math.round(elapsed()), section: window.currentSection || '' }).catch(() => {});
    };

    async function load() {
        try { comp = await api('/api/competition'); } catch (e) { return; }
        comp.runs = (comp.runs || []).filter(isShown);          // SLAM runs saved earlier stay in the data file, hidden here
        render();
    }
    window.competitionRefresh = load;

    // teams listed in index.html (data-teams), plus any added through "Manage teams",
    // the team playing now and (for the scoreboard) every team that has a finished run
    function allTeams(withRuns) {
        const names = ($('team-select').dataset.teams || '').split(';').map((n) => n.trim()).filter(Boolean);
        const add = (n) => { if (n && !names.some((x) => x.toLowerCase() === n.toLowerCase())) names.push(n); };
        comp.teams.forEach(add);
        add(run.team);
        if (withRuns) comp.runs.forEach((r) => add(r.team));
        return names;
    }

    function renderTeams() {
        const sel = $('team-select');
        sel.replaceChildren(el('option', '', 'Select a team…'));
        sel.firstChild.value = '';
        allTeams(false).forEach((n) => { const o = el('option', '', n); o.value = n; sel.appendChild(o); });
        sel.value = run.team;
        sel.disabled = run.running;

        const list = $('team-list');
        list.replaceChildren();
        if (!comp.teams.length) list.appendChild(el('span', 'muted small', 'No teams yet.'));
        comp.teams.forEach((n) => {
            const tag = el('span', 'team-tag', n);
            const b = el('button');
            b.title = `Remove ${n}`;
            b.appendChild(icon('x'));
            b.addEventListener('click', async () => {
                if (!confirm(`Remove team ${n}? Its finished runs stay on the scoreboard.`)) return;
                await api('/api/competition/teams/' + encodeURIComponent(n), undefined, 'DELETE');
                load();
            });
            tag.appendChild(b);
            list.appendChild(tag);
        });
    }

    // ---- scoreboard (top bar): fastest time per team for each challenge
    function renderScoreboard() {
        const rows = new Map();
        allTeams(true).forEach((n) => rows.set(n.toLowerCase(), { team: n, best: {}, count: {} }));
        comp.runs.forEach((r) => {
            const row = rows.get(r.team.toLowerCase());
            const c = catOf(r);
            row.count[c] = (row.count[c] || 0) + 1;
            if (row.best[c] === undefined || r.elapsed_ms < row.best[c]) row.best[c] = r.elapsed_ms;
        });

        const list = [...rows.values()];
        const val = (row) => (row.best[sortKey] === undefined ? Infinity : row.best[sortKey]);
        list.sort(sortKey === 'team'
            ? (a, b) => a.team.localeCompare(b.team)
            : (a, b) => (val(a) - val(b)) || a.team.localeCompare(b.team));      // NaN (both empty) falls through to the name

        const colBest = {};
        CATS.forEach(([k]) => {
            const v = list.map((r) => r.best[k]).filter((x) => x !== undefined);
            colBest[k] = v.length ? Math.min(...v) : null;
        });

        $('scoreboard').querySelectorAll('.sort').forEach((b) => b.classList.toggle('on', b.dataset.sort === sortKey));
        const tb = $('scoreboard').querySelector('tbody');
        tb.replaceChildren();
        if (!list.length) {
            const td = el('td', 'empty', 'No teams yet.');
            td.colSpan = 3;
            tb.appendChild(el('tr')).appendChild(td);
        }
        list.forEach((row) => {
            const tr = el('tr');
            if (run.team && row.team.toLowerCase() === run.team.toLowerCase()) tr.classList.add('playing');
            tr.appendChild(el('td', '', row.team));
            CATS.forEach(([k]) => {
                const v = row.best[k];
                const td = el('td', 'num' + (v === undefined ? ' dim' : v === colBest[k] ? ' best' : ''), v === undefined ? '—' : fmt(v));
                if (v !== undefined) td.title = `${row.count[k]} run${row.count[k] > 1 ? 's' : ''}`;
                tr.appendChild(td);
            });
            tb.appendChild(tr);
        });

        // ---- full run log (Setup section), newest first
        const rb = $('runs-table').querySelector('tbody');
        rb.replaceChildren();
        if (!comp.runs.length) {
            const td = el('td', 'empty', 'Nothing yet.');
            td.colSpan = 6;
            rb.appendChild(el('tr')).appendChild(td);
        }
        [...comp.runs].reverse().forEach((r) => {
            const tr = el('tr');
            const det = !r.displayed ? '—' : classLabel(normClass(r.displayed)) +
                (r.detected ? ` → ${classLabel(normClass(r.detected))}` : '');       // old runs only
            const del = el('button', 'del');
            del.title = 'Delete this run';
            del.appendChild(icon('x'));
            del.addEventListener('click', async () => {
                if (!confirm(`Delete ${r.team}'s ${catLabel(catOf(r))} run (${fmt(r.elapsed_ms)})?`)) return;
                await api('/api/competition/runs/' + r.id, undefined, 'DELETE');
                load();
            });
            const td = el('td');
            td.appendChild(del);
            tr.append(el('td', '', new Date(r.time * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })),
                      el('td', '', r.team), el('td', '', catLabel(catOf(r))), el('td', 'num', fmt(r.elapsed_ms)),
                      el('td', 'small', det), td);
            rb.appendChild(tr);
        });
    }

    $('scoreboard').querySelectorAll('.sort').forEach((b) => b.addEventListener('click', () => {
        sortKey = b.dataset.sort;
        store.set('dojoSbSort', sortKey);
        renderScoreboard();
    }));

    // ---- scoreboard panel open / close (button, S key, Esc, click outside)
    window.toggleScoreboard = (open) => {
        const show = open === undefined ? $('sb-panel').hidden : open;
        $('sb-panel').hidden = !show;
        $('sb-toggle').classList.toggle('active', show);
        $('sb-toggle').setAttribute('aria-expanded', String(show));
        if (show) load();
    };
    $('sb-toggle').addEventListener('click', () => window.toggleScoreboard());
    $('sb-close').addEventListener('click', () => window.toggleScoreboard(false));
    document.addEventListener('mousedown', (e) => {
        if (!$('sb-panel').hidden && !e.target.closest('#sb-panel, #sb-toggle')) window.toggleScoreboard(false);
    });

    function renderNowPlaying() {
        const box = $('now-playing');
        box.replaceChildren();
        box.classList.toggle('empty', !run.team);
        if (!run.team) {
            box.appendChild(el('div', 'now-team', 'No team selected'));
            box.appendChild(el('div', 'now-meta', 'Pick a team above to get ready'));
            return;
        }
        box.appendChild(el('div', 'now-team', run.team));
        const state = run.running ? 'Running' : run.elapsedMs ? `Stopped at ${fmt(run.elapsedMs)}` : 'Ready to start';
        box.appendChild(el('div', 'now-meta', `${catLabel(run.category)} · ${state}`));
    }

    function renderCat() {
        $('cat-seg').querySelectorAll('.seg-btn').forEach((b) => {
            const on = b.dataset.cat === run.category;
            b.classList.toggle('active', on);
            b.setAttribute('aria-checked', String(on));
            b.disabled = run.running;
        });
        $('cat-hint').hidden = !run.running;       // the buttons are locked while timing, so say so
    }

    function render() { renderTeams(); renderScoreboard(); renderNowPlaying(); renderCat(); }
    onRun(() => {
        renderNowPlaying(); renderCat(); renderScoreboard();
        $('team-select').disabled = run.running;
    });

    $('cat-seg').addEventListener('click', (e) => {
        const b = e.target.closest('.seg-btn');
        if (!b || run.running || run.category === b.dataset.cat) return;
        run.category = b.dataset.cat;
        saveRun();
        window.pushCurrent();
    });

    $('team-select').addEventListener('change', () => {
        const t = $('team-select').value;
        const hasData = run.elapsedMs > 0 || run.displayed;
        if (hasData && t !== run.team && !confirm(`Discard the run in progress for ${run.team}?`)) {
            $('team-select').value = run.team;
            return;
        }
        run = hasData && t !== run.team ? newRun(t, run.category) : Object.assign(run, { team: t });
        saveRun();
        window.pushCurrent();
    });

    $('team-add').addEventListener('click', async () => {
        const name = $('team-new').value.trim();
        if (!name) return;
        const r = await api('/api/competition/teams', { name });
        $('team-new').value = '';
        load();
    });
    $('team-new').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('team-add').click(); });

    $('home-reset').addEventListener('click', () => {
        if (!confirm('Discard the run in progress? The timer and detection are cleared.')) return;
        run = newRun(run.team, run.category);
        saveRun();
        window.pushCurrent();
    });

    // the scoreboard lives in the top bar, so it refreshes on every section (started by the shell)
    let timer = null;
    window.competitionStart = () => { if (!timer) { load(); timer = setInterval(load, 5000); } };
    window.competitionStop = () => { clearInterval(timer); timer = null; };
    render();       // preset teams show up even if the server is slow
})();

// ======================================================================
// GAMEFIELD SCREEN + JUDGED ITEM
// ======================================================================
(function () {
    let screenShown = 'logo';

    function setStatus(t) { $('status').textContent = t; }
    fitBox($('stream-stage'), $('stream-box'), 1024 / 600);       // the Pi screen is 1024 x 600

    // ---- live feed of the Pi screen.
    // The feed stays connected the whole time (no black flash when you scroll back). It comes through this
    // server's relay (/api/screen_stream: newest frame only, so it cannot fall behind) and falls back to the
    // Pi's own stream if the relay keeps failing. A fresh connection is opened (and swapped in once its first
    // frame is there) after every screen change and whenever the feed drops, so it never needs a page refresh.
    let feed = $('live-stream');
    const feedBox = $('stream-box');
    const feedUp = (up) => feedBox.classList.toggle('down', !up);       // hides the browser's broken-image icon while the feed is down
    feedUp(false);                                                       // until the first frame arrives
    const FEED_RELAY = feed.dataset.src;
    const FEED_DIRECT = feed.dataset.fallback;
    let feedUrl = FEED_RELAY, feedFails = 0, feedGen = 0, feedTimer = null;

    function reconnectFeed() {
        const gen = ++feedGen;
        clearTimeout(feedTimer);
        const next = new Image();
        next.alt = feed.alt;
        let swapped = false;
        const swap = () => {
            if (swapped || gen !== feedGen) return;
            swapped = true;
            feedFails = 0;
            const old = feed;
            next.onload = next.onerror = null;
            next.id = 'live-stream';
            next.dataset.src = FEED_RELAY;
            next.dataset.fallback = FEED_DIRECT;
            old.replaceWith(next);
            old.onload = old.onerror = null;
            old.src = '';                               // drops the old connection (removing the attribute can leave it open)
            feed = next;
            feedUp(next.naturalWidth > 0);
            feed.addEventListener('load', () => feedUp(true));
            feed.addEventListener('error', onFeedError);
        };
        next.onload = swap;                             // first frame is in
        next.onerror = () => {
            if (swapped || gen !== feedGen) return;
            onFeedError();
        };
        setTimeout(swap, 5000);                         // some browsers never fire load for a live stream
        // The browser shares one image connection per URL, so asking for the same URL again would just
        // reuse the stuck one. The relay is ours and ignores the query, so give each connection its own URL.
        // The Pi's own stream is left untouched: drop the old connection first, then open a new one.
        if (feedUrl === FEED_RELAY) next.src = FEED_RELAY + '?t=' + Date.now();
        else { feed.src = ''; setTimeout(() => { if (gen === feedGen) next.src = FEED_DIRECT; }, 50); }
    }
    function onFeedError() {
        feedUp(false);
        feedFails += 1;
        if (feedFails >= 3) { feedUrl = feedUrl === FEED_RELAY ? FEED_DIRECT : FEED_RELAY; feedFails = 0; }   // relay down: try the Pi directly, and back
        clearTimeout(feedTimer);
        feedTimer = setTimeout(reconnectFeed, 2000);
    }
    window.reconnectScreenFeed = reconnectFeed;
    reconnectFeed();

    async function sendClass(cls) {
        setStatus(`Requesting '${classLabel(cls)}' image…`);
        try {
            let data = null;
            for (const name of SCREEN_CATEGORY[cls]) {
                data = await api('/api/set_display_class', { category: name });
                // only try the next folder name when this one does not exist on the Pi
                if (data.success || !/unknown or empty category/i.test(data.message || '')) break;
            }
            setStatus(data.message);
            if (data.success) {
                screenShown = cls;
                run.displayed = cls;
                saveRun();
                setTimeout(reconnectFeed, 600);         // let the Pi redraw, then show the new picture here
            }
        } catch (e) { setStatus('Error connecting to web bridge'); }
    }

    $('class-buttons').querySelectorAll('.class-btn').forEach((b) => {
        b.addEventListener('click', () => sendClass(normClass(b.dataset.cat)));
    });
    $('screen-random').addEventListener('click', () => {
        const all = Object.keys(CLASS_LABEL);
        sendClass(all[Math.floor(Math.random() * all.length)]);
    });
    $('screen-logo').addEventListener('click', async () => {
        setStatus('Reverting to logo…');
        try {
            const data = await api('/api/set_display', { state: false });
            setStatus(data.message);
            if (data.success) { screenShown = 'logo'; render(); setTimeout(reconnectFeed, 600); }
        } catch (e) { setStatus('Error connecting to web bridge'); }
    });

    function render() {
        $('screen-shown').textContent = 'Screen: ' + (screenShown === 'logo' ? 'logo' : classLabel(screenShown));
        $('class-buttons').querySelectorAll('.class-btn').forEach((b) => {
            b.classList.toggle('active', normClass(b.dataset.cat) === screenShown);
        });
    }
    onRun(render);
})();

// ======================================================================
// LOADING STATION (dispenser) - talks to /api/dispenser/*
// ======================================================================
(function () {
    let enabled = true;
    let prev = null;             // previous snapshot, to log changes
    let stationClass = store.get('dojoStationMap', { 1: 'metal', 2: 'organic', 3: 'plastic' });

    // ---- build the 3 station cards once
    document.querySelectorAll('.station').forEach((card) => {
        const n = card.dataset.station;
        card.innerHTML = `
            <h3><span>STATION ${n}</span><span class="st-class"><select aria-label="Waste class of station ${n}">
                <option value="metal">Metal</option><option value="organic">Organic</option><option value="plastic">Plastic</option>
            </select></span></h3>
            <div class="station-actions">
                <button class="btn btn-primary">Dispense</button>
            </div>`;
        const clsSel = card.querySelector('select');
        clsSel.value = stationClass[n];
        clsSel.addEventListener('change', () => {
            stationClass[n] = clsSel.value;
            store.set('dojoStationMap', stationClass);
            renderExpected();
        });
        card.querySelector('button').addEventListener('click', () => dispense(+n, 1));
    });

    function renderExpected() {
        const want = run.displayed;
        document.querySelectorAll('.station').forEach((card) => {
            const n = card.dataset.station;
            const tag = card.querySelector('.st-class');
            tag.style.background = `var(--${stationClass[n]})`;
            card.classList.toggle('expected', !!want && stationClass[n] === want);
        });
        const match = Object.keys(stationClass).find((k) => stationClass[k] === want);
        $('disp-expected').textContent = want
            ? `Screen showed ${classLabel(want)}: the robot should load at station ${match || '?'}.`
            : 'No class shown on the screen yet: the expected station is highlighted once one is displayed.';
    }
    onRun(renderExpected);

    function setStatus(text) { $('disp-status').textContent = text; }

    const logger = logBox('disp-logbox', 'disp-log', 'disp-log-count', 'disp-log-last', 'disp-log-clear', 'Station events appear here.');
    function log(text, cls) { logger.add(text, cls, run.running ? fmt(elapsed()) : new Date().toLocaleTimeString()); }

    async function act(label, path, body) {
        setStatus(label);
        try {
            const data = await api('/api/dispenser/' + path, body);
            setStatus(data.message);
            log(data.message, data.success ? '' : 'err');
        } catch (e) {
            setStatus('Error connecting to web bridge');
        }
        poll();
    }

    function dispense(station, count) {
        return act(`Dispensing ${count} from station ${station}…`, 'dispense', { station_id: station, count });
    }
    $('disp-enable').addEventListener('click', () => act(enabled ? 'Disabling…' : 'Enabling…', 'enable', { enabled: !enabled }));
    $('disp-home').addEventListener('click', () => act('Homing (takes a few seconds)…', 'home', {}));
    $('disp-reset').addEventListener('click', () => act('Resetting (takes a few seconds)…', 'reset', {}));
    $('disp-cancel').addEventListener('click', () => act('Cancelling…', 'cancel', {}));

    function loaded(text) {
        log(text, 'ok');
        if (run.running && run.loadedMs === null) {
            run.loadedMs = elapsed();
            saveRun();
        }
    }

    // ---- log what changed since the last poll; works whether the web page or the robot sent the goal
    function diff(snap) {
        const st = snap.online ? snap.status : null;
        const p = prev && prev.online ? prev.status : null;
        if (prev === null) { prev = snap; return; }
        if (!!st !== !!p) log(st ? 'Loading station online' : 'Loading station offline', st ? 'ok' : 'err');
        if (st && p) {
            if (st.state !== p.state) log(`State ${p.state} → ${st.state}`, st.state === 'ERROR' ? 'err' : '');
            if (st.serial_connected !== p.serial_connected) log(st.serial_connected ? 'Arduino connected' : 'Arduino disconnected', st.serial_connected ? 'ok' : 'err');
            if (st.last_message && st.last_message !== p.last_message) log(st.last_message, 'warn');
            st.remaining.forEach((r, i) => {
                const was = p.remaining[i];
                if (was !== undefined && r < was) loaded(`Station ${i + 1} dispensed ${was - r} piece${was - r > 1 ? 's' : ''}`);
                else if (was !== undefined && r > was) log(`Station ${i + 1} refilled`);
            });
        }
        const g = snap.goal, pg = prev.goal;
        if (g && (!pg || g.state !== pg.state || g.pieces !== pg.pieces)) {
            if (g.state === 'SUCCEEDED') log(`Goal done: station ${g.station}, ${g.pieces}/${g.count}${g.message ? ' – ' + g.message : ''}`, 'ok');
            else if (['ABORTED', 'REJECTED', 'CANCELED'].includes(g.state)) log(`Goal ${g.state}: ${g.message || ''}`, 'err');
            else log(`Station ${g.station}: ${g.operation || g.state} (${g.pieces}/${g.count})`);
        }
        prev = snap;
    }

    function render(snap) {
        const st = snap.online && snap.status ? snap.status : null;
        const state = st ? st.state : 'OFFLINE';
        enabled = st ? st.enabled : enabled;

        const badge = $('disp-badge');
        badge.textContent = state;
        badge.className = 'badge badge-' + state.toLowerCase();
        $('disp-conn').textContent = !st
            ? (snap.error || 'waiting for loading station…')
            : (st.serial_connected ? 'Arduino connected' : 'Arduino NOT connected');

        const idle = state === 'IDLE';
        const busy = state === 'DISPENSING' || state === 'HOMING';
        document.querySelectorAll('.station').forEach((card) => {
            card.querySelector('.station-actions button').disabled = !idle;
        });

        $('disp-enable').textContent = enabled ? 'Disable' : 'Enable';
        $('disp-enable').disabled = !st;
        $('disp-home').disabled = !st || !st.serial_connected || busy;
        $('disp-reset').disabled = !st;

        const g = snap.goal;
        const active = g && (g.state === 'SENDING' || g.state === 'RUNNING');
        $('disp-cancel').disabled = !active;
        if (!g) $('disp-goal').textContent = 'No dispense yet';
        else if (active) $('disp-goal').textContent = `Station ${g.station}: ${g.operation || 'starting…'} (${g.pieces}/${g.count})`;
        else $('disp-goal').textContent = `Last dispense – station ${g.station}: ${g.state}, ${g.pieces}/${g.count}` + (g.message ? ` (${g.message})` : '');
    }

    async function poll() {
        let snap;
        try { snap = await api('/api/dispenser/status'); }
        catch (e) { snap = { online: false, status: null, goal: null, error: 'web bridge unreachable' }; }
        diff(snap);
        render(snap);
    }

    let timer = null;
    window.dispenserStart = () => { if (!timer) { poll(); timer = setInterval(poll, 1000); } };
    window.dispenserStop = () => { clearInterval(timer); timer = null; };
})();

// ======================================================================
// DYNAMIC OBSTACLES - front-end only, tells the field crew where to put the blocks
// ======================================================================
(function () {
    // ---- grid geometry (from Gamefield.stl: the largest free area on the field) ----
    // To flip the grid to 2 columns x 3 rows, swap COLS/ROWS (cell sizes follow).
    const COLS = 3, ROWS = 2, OBSTACLES = 3;
    const AREA = { x0: -151, x1: 1489, y0: 845, y1: 2265 };   // mm, STL coordinates

    const grid = $('obs-grid');
    const cellW = (AREA.x1 - AREA.x0) / COLS;
    const cellH = (AREA.y1 - AREA.y0) / ROWS;

    // Cell names: columns A,B,C left->right, rows 1,2 top->bottom (top = larger y).
    const cells = [];
    for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
            cells.push({
                name: String.fromCharCode(65 + c) + (r + 1),
                cx: Math.round(AREA.x0 + (c + 0.5) * cellW),
                cy: Math.round(AREA.y1 - (r + 0.5) * cellH),
            });
        }
    }

    grid.style.gridTemplateColumns = `repeat(${COLS}, 1fr)`;
    grid.style.gridTemplateRows = `repeat(${ROWS}, 1fr)`;
    fitBox($('obs-stage'), grid, (AREA.x1 - AREA.x0) / (AREA.y1 - AREA.y0));
    const els = cells.map((cell) => {
        const e = el('div', 'obs-cell');
        e.append(el('span', 'obs-name', cell.name), el('span', 'obs-block'), el('span', 'obs-coord', `x${cell.cx} y${cell.cy}`));
        grid.appendChild(e);
        return e;
    });

    let current = [];   // indices of cells holding an obstacle, sorted

    function pick() {
        // Fisher-Yates shuffle, take the first OBSTACLES; retry so we never repeat the last layout
        let next;
        do {
            const idx = cells.map((_, i) => i);
            for (let i = idx.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [idx[i], idx[j]] = [idx[j], idx[i]];
            }
            next = idx.slice(0, OBSTACLES).sort((a, b) => a - b);
        } while (next.join() === current.join());
        return next;
    }

    const describe = () => current.map((i) => cells[i].name).join(', ');

    function randomize() {
        current = pick();
        els.forEach((e, i) => e.classList.toggle('has-obstacle', current.includes(i)));
        $('obs-status').textContent = `Obstacles at: ${describe()}` + (run.running ? ` (set at ${fmt(elapsed())})` : '');
    }
    $('obs-random').addEventListener('click', randomize);


    randomize();   // start with a layout already shown
})();

// ======================================================================
// BARRIER - Automatic (ultrasonic detect -> close -> open) + Manual fallback - talks to /api/barrier/*
// ======================================================================
// /api/barrier/status mirrors the gamefield_barrier ROS node (see fastapi_node.py, BARRIER BRIDGE):
//   { online, status: { connected, state, angle, pot, distance_cm, sequence, fault }, events: [{id, time, text}] }
//   online       the barrier ROS node is publishing; status.connected = the Arduino is plugged in and answering
//   state        UNKNOWN | INITIALIZING | OPENING | OPEN | CLOSING | CLOSED | FAULT
//   distance_cm  HC-SR04 reading, -1 = no echo
//   sequence     'RUN' while the Arduino runs its own detect sequence, else 'IDLE'
//   events       'SEQ:START (from OPEN)', 'SEQ:DONE', 'SEQ:ABORT', 'SEQ:CANCELLED', 'MANUAL:OPEN', ... (increasing id)
//
// What the Arduino does when the ultrasonic detects a robot (firmware detect_sequence.cpp):
//   from OPEN   : close -> hold closed -> open          (the usual case: detect, close, open)
//   from CLOSED : wait  -> open -> hold open -> close
// so the two action steps are shown in the order the barrier will really run them, and they light up as the
// gate state changes.
(function () {
    const DETECT_CM = 30;       // firmware DEFAULT_DETECT_CM (changed over serial with d<cm>); only used to label an echo "in range"
    const POLL_MS = 500;        // the node publishes status at about 2 Hz
    const RESULT_MS = 4000;     // how long "complete" / "aborted" stays up after a sequence ends

    const ACTION = { OPEN: { title: 'Open', target: 'OPEN', moving: 'OPENING', ing: 'Opening…', at: 'Open' },
                     CLOSE: { title: 'Close', target: 'CLOSED', moving: 'CLOSING', ing: 'Closing…', at: 'Closed' } };
    // [first move, second move] by where the sequence starts from
    const ORDER = { OPEN: ['CLOSE', 'OPEN'], CLOSED: ['OPEN', 'CLOSE'] };

    // ---- state
    let pending = false;        // a manual open / close / reset request is in flight
    let last = { online: false, status: null, events: [] };
    let prev = null;            // previous reading, to log changes
    let lastEvent = 0;          // highest event id already handled
    let seq = null;             // { origin: 'OPEN'|'CLOSED', reachedFirst } while the Arduino runs its sequence
    let result = null;          // { kind: 'done'|'fail', text, until } shown for a few seconds after it ends
    let pose = 'extended';      // gate drawing: 'extended' (CLOSED) or 'retracted' (OPEN); kept while FAULT / UNKNOWN

    // ---- log (collapsible, same look as the station log)
    const logger = logBox('barrier-logbox', 'barrier-log', 'barrier-log-count', 'barrier-log-last', 'barrier-log-clear', 'Barrier events appear here.');
    function log(text, cls) { logger.add(text, cls, run.running ? fmt(elapsed()) : new Date().toLocaleTimeString()); }

    function setStatus(text) { $('barrier-status').textContent = text; }

    // ---- what the Arduino says right now, reduced to what the page needs
    function reading(snap) {
        const st = snap.online && snap.status ? snap.status : null;
        const connected = !!(st && st.connected);
        return {
            st, connected,
            state: connected ? String(st.state || 'UNKNOWN') : 'UNKNOWN',
            distance: connected && Number.isFinite(st.distance_cm) && st.distance_cm >= 0 ? st.distance_cm : null,
            running: connected && st.sequence === 'RUN',
            fault: connected && st.fault && st.fault !== 'NONE' ? st.fault : '',
        };
    }

    // ================================================================ AUTOMATIC
    function setStep(id, status, title, sub) {
        const e = $(id);
        e.dataset.status = status;
        if (title !== null) e.querySelector('b').textContent = title;
        e.querySelector('.sub').textContent = sub;
        e.querySelector('.num').textContent = status === 'done' ? '✓' : e.dataset.n;
    }
    ['step-detect', 'step-a', 'step-b'].forEach((id, i) => { $(id).dataset.n = String(i + 1); });

    function setBanner(kind, text) { $('auto-banner').dataset.kind = kind; $('auto-banner').textContent = text; }
    function setBadge(text, cls) { $('auto-badge').textContent = text; $('auto-badge').className = 'badge ' + cls; }

    function renderAuto(r) {
        // order of the two moves: while a sequence runs use where it started; otherwise predict from the gate
        const origin = seq ? seq.origin : (r.state === 'CLOSED' || r.state === 'CLOSING') ? 'CLOSED' : 'OPEN';
        const [A, B] = [ACTION[ORDER[origin][0]], ACTION[ORDER[origin][1]]];
        const echo = r.distance === null ? 'No echo' : `${r.distance} cm${r.distance <= DETECT_CM ? ' (in range)' : ''}`;

        if (!r.connected) {
            setBadge(r.st ? 'DISCONNECTED' : 'OFFLINE', r.st ? 'badge-disconnected' : 'badge-offline');
            setStep('step-detect', 'off', null, 'Sensor offline');
            setStep('step-a', 'pending', A.title, '');
            setStep('step-b', 'pending', B.title, '');
            setBanner('offline', r.st ? 'Arduino not connected. Use Manual if you need the barrier.' : (last.error || 'Waiting for the barrier controller…'));
            return;
        }
        if (r.state === 'FAULT') {
            setBadge('FAULT', 'badge-gate-fault');
            setStep('step-detect', 'off', null, 'Paused');
            setStep('step-a', 'pending', A.title, '');
            setStep('step-b', 'pending', B.title, '');
            setBanner('fail', 'Barrier fault. Press Reset in Manual to recover.');
            return;
        }

        if (r.running) {
            setBadge('RUNNING', 'badge-gate-opening');
            // first move is done once the gate has left its target; the second move is then the active one
            const firstDone = seq && seq.reachedFirst && r.state !== A.target;
            const holding = seq && seq.reachedFirst && r.state === A.target;
            setStep('step-detect', 'done', null, r.distance === null ? 'Robot detected' : `Robot detected · ${r.distance} cm`);
            setStep('step-a', firstDone ? 'done' : 'active', A.title,
                    firstDone ? A.at : holding ? `${A.at} · holding` : r.state === A.moving ? A.ing : 'Starting…');
            setStep('step-b', firstDone ? 'active' : 'pending', B.title,
                    firstDone ? (r.state === B.moving ? B.ing : r.state === B.target ? B.at : 'Starting…') : '');
            setBanner('running', 'Automatic sequence running…');
            return;
        }

        if (result && Date.now() < result.until) {
            setBadge(result.kind === 'done' ? 'DONE' : 'STOPPED', result.kind === 'done' ? 'badge-live' : 'badge-gate-fault');
            if (result.kind === 'done') {
                setStep('step-detect', 'done', null, 'Robot detected');
                setStep('step-a', 'done', A.title, '');
                setStep('step-b', 'done', B.title, '');
            } else {
                setStep('step-detect', 'pending', null, '');
                setStep('step-a', 'pending', A.title, '');
                setStep('step-b', 'pending', B.title, '');
            }
            setBanner(result.kind === 'done' ? 'done' : 'fail', result.text);
            return;
        }

        // idle: armed and watching for a robot
        setBadge('ARMED', 'badge-live');
        setStep('step-detect', 'watching', null, `Watching · ${echo}`);
        setStep('step-a', 'pending', A.title, '');
        setStep('step-b', 'pending', B.title, '');
        setBanner('armed', `Waiting for a robot (detects within ${DETECT_CM} cm)`);
    }

    // ================================================================ MANUAL
    function renderGate(r) {
        const { st, connected, state } = r;
        const label = !st ? 'OFFLINE' : !connected ? 'DISCONNECTED' : state;
        $('gate-badge').textContent = label;
        $('gate-badge').className = 'badge ' + (!st ? 'badge-offline' : !connected ? 'badge-disconnected' : 'badge-gate-' + state.toLowerCase());

        if (state === 'OPEN' || state === 'OPENING') pose = 'retracted';
        else if (state === 'CLOSED' || state === 'CLOSING' || state === 'INITIALIZING') pose = 'extended';
        $('gate').dataset.pose = pose;
        $('gate').dataset.known = String(connected && state !== 'UNKNOWN' && state !== 'FAULT');

        // commands are refused by the Arduino while INITIALIZING or in FAULT (Reset clears a fault)
        const ready = connected && !pending && !['UNKNOWN', 'INITIALIZING', 'FAULT'].includes(state);
        $('barrier-open').disabled = !ready || state === 'OPEN' || state === 'OPENING';
        $('barrier-close').disabled = !ready || state === 'CLOSED' || state === 'CLOSING';
        $('barrier-reset').disabled = !connected || pending;

        $('gate-angle').textContent = connected && st.angle >= 0 ? `${st.angle}°` : '—';
        $('gate-pot').textContent = connected && st.pot >= 0 ? String(st.pot) : '—';
        $('gate-fault').textContent = connected ? (r.fault || 'None') : '—';
        $('gate-fault').parentElement.classList.toggle('bad', !!r.fault);
        $('gate-hint').hidden = !r.fault;
        if (r.fault) $('gate-hint').textContent = `Fault: ${r.fault}. Press Reset to clear it and re-initialise the barrier.`;
    }

    // ================================================================ events, log, polling
    // handle one barrier event; `silent` = replaying history on the first poll (no log, no result banner)
    function handleEvent(e, silent) {
        const m = /^SEQ:START \(from (OPEN|CLOSED)\)/.exec(e.text);
        if (m) { seq = { origin: m[1], reachedFirst: false }; result = null; }
        else if (e.text === 'SEQ:DONE') { seq = null; if (!silent) result = { kind: 'done', text: 'Sequence complete', until: Date.now() + RESULT_MS }; }
        else if (e.text === 'SEQ:ABORT') { seq = null; if (!silent) result = { kind: 'fail', text: 'Sequence aborted (the barrier did not reach its target)', until: Date.now() + RESULT_MS }; }
        else if (e.text === 'SEQ:CANCELLED') { seq = null; if (!silent) result = { kind: 'fail', text: 'Sequence cancelled by a manual command', until: Date.now() + RESULT_MS }; }
        if (!silent) log(e.text, /^SEQ:(ABORT|CANCELLED)/.test(e.text) ? 'err' : /^MANUAL:/.test(e.text) ? 'warn' : '');
    }

    function diff(snap) {
        const cur = reading(snap);
        const evs = snap.events || [];
        if (prev === null) {                      // first snapshot: sync to the current situation, do not replay history
            evs.forEach((e) => handleEvent(e, true));
            lastEvent = evs.reduce((m, e) => Math.max(m, e.id), 0);
        } else {
            if (cur.connected !== prev.connected) log(cur.connected ? 'Barrier controller connected' : 'Barrier controller disconnected', cur.connected ? 'ok' : 'err');
            if (cur.connected && prev.connected && cur.state !== prev.state) log(`State ${prev.state} → ${cur.state}`, cur.state === 'FAULT' ? 'err' : '');
            if (cur.connected && cur.fault && cur.fault !== prev.fault) log(`Fault: ${cur.fault}`, 'err');
            evs.filter((e) => e.id > lastEvent).forEach((e) => { handleEvent(e, false); lastEvent = e.id; });
        }
        // keep our picture of the sequence in step with what the Arduino reports
        if (!cur.running) seq = null;
        else if (!seq) seq = { origin: 'OPEN', reachedFirst: false };       // joined mid-sequence and the start event is gone
        if (seq && !seq.reachedFirst && cur.state === ACTION[ORDER[seq.origin][0]].target) seq.reachedFirst = true;
        prev = cur;
    }

    function render() {
        const r = reading(last);
        renderAuto(r);
        renderGate(r);
    }

    async function poll() {
        try { last = await api('/api/barrier/status'); }
        catch (e) { last = { online: false, status: null, events: [], error: 'Web bridge unreachable' }; }
        diff(last);
        render();
    }

    // manual open / close / reset: the node answers once the gate has arrived (a few seconds), so lock the buttons meanwhile
    async function act(cmd, label) {
        if (pending) return;
        pending = true;
        render();
        setStatus(label);
        try {
            const data = await api('/api/barrier/' + cmd, {});
            setStatus(data.message);
            log(data.message, data.success ? 'ok' : 'err');
        } catch (e) {
            setStatus('Error connecting to web bridge');
        }
        pending = false;
        poll();
    }
    $('barrier-open').addEventListener('click', () => act('open', 'Opening…'));
    $('barrier-close').addEventListener('click', () => act('close', 'Closing…'));
    $('barrier-reset').addEventListener('click', () => act('reset', 'Resetting (takes a few seconds)…'));

    let timer = null;
    window.barrierStart = () => { if (!timer) { poll(); timer = setInterval(poll, POLL_MS); } };
    window.barrierStop = () => { clearInterval(timer); timer = null; };
    render();       // drawn offline until the first poll answers
})();

// ======================================================================
// FINISH RUN
// ======================================================================
(function () {
    window.endRun = async () => {
        if (!run.team) return;
        if (!run.running && run.elapsedMs <= 0) return;      // nothing timed yet
        if (run.running && !confirm('The timer is still running. Stop it and finalise?')) return;
        if (run.running) { run.elapsedMs = Date.now() - run.startedAt; run.running = false; run.stoppedMs = run.elapsedMs; }
        try {
            const r = await api('/api/competition/runs', {
                team: run.team, category: run.category, elapsed_ms: Math.round(run.elapsedMs), total: 0, scores: {},
                displayed: run.displayed, notes: run.notes,
            });
            if (!r.success) throw new Error(r.message);
            const saved = { team: run.team, cat: catLabel(run.category), time: fmt(run.elapsedMs) };
            // a team does Nav2, then Behaviour Trees in a row: keep the team and move on to the
            // next challenge, and only clear the team once Behaviour Trees is done
            const next = NEXT_CHALLENGE[run.category];
            run = next ? newRun(saved.team, next) : newRun('', 'nav2');
            saveRun();
            window.competitionRefresh();
            window.go('home');
            toast(`Run saved for ${saved.team}`, `${saved.cat} · ${saved.time}` + (next ? ` · up next: ${catLabel(next)}` : ''), '', null, 2000, 'saved');
        } catch (e) {
            console.error('Could not save the run', e);      // the run stays in the browser; try End run again
            toast('Could not save the run', 'Check the web bridge is running, then press End run again.', '', null, 4000, 'saved');
        }
    };
    $('finalize').addEventListener('click', window.endRun);

    // the End Run section shows what is about to be saved
    onRun(() => {
        $('end-team').textContent = run.team || '—';
        $('end-cat').textContent = run.team ? catLabel(run.category) : '—';
        $('end-time').textContent = fmt(elapsed());
        $('finalize').disabled = !run.team || (!run.running && run.elapsedMs <= 0);
    });
    setInterval(() => { if (run.running) $('end-time').textContent = fmt(elapsed()); }, 200);
})();

// ======================================================================
// SHELL: sidebar jump links, scroll-spy, theme, pollers - must stay last
// ======================================================================
(function () {
    const SECTIONS = ['home', 'screen', 'loading', 'obstacles', 'barrier', 'end'];
    const sidebar = $('sidebar');
    const main = $('main');
    const mobile = () => window.matchMedia('(max-width: 720px)').matches;

    // ---- theme (light by default)
    function applyTheme(t) {
        document.documentElement.dataset.theme = t;
        $('theme-icon').setAttribute('href', t === 'dark' ? '#i-sun' : '#i-moon');
        store.set('dojoTheme', t);
    }
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
    $('theme-toggle').addEventListener('click', () =>
        applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));

    // ---- sidebar: jump links into the one continuous page
    const savedNav = store.get('dojoNavCollapsed', null);       // null = never chosen: collapse on a narrow window
    if (mobile() || (savedNav === null ? window.innerWidth < 1150 : savedNav)) sidebar.classList.add('collapsed');
    $('nav-toggle').addEventListener('click', () => {
        sidebar.classList.toggle('collapsed');
        if (!mobile()) store.set('dojoNavCollapsed', sidebar.classList.contains('collapsed'));
    });
    sidebar.querySelectorAll('.nav-item').forEach((b) => b.addEventListener('click', () => {
        window.go(b.dataset.section);
        if (mobile()) sidebar.classList.add('collapsed');
    }));

    // ---- pollers: sections that are on screen (or a run in progress) keep their data fresh
    const vis = new Set();      // sections currently in view
    function updatePollers() {
        const live = run.running;
        if (vis.has('loading') || live) window.dispenserStart(); else window.dispenserStop();
        if (vis.has('barrier') || live) window.barrierStart(); else window.barrierStop();
    }
    onRun(updatePollers);
    window.refreshPollers = updatePollers;

    // ---- which section is "current" (sidebar highlight, hash, timer overlay label)
    let spyLock = 0, pushTimer = null;
    function setCurrent(name) {
        if (window.currentSection === name) return;
        window.currentSection = name;
        sidebar.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.section === name));
        history.replaceState(null, '', '#' + name);
        window.setStageLabel(name);
        clearTimeout(pushTimer);
        pushTimer = setTimeout(window.pushCurrent, 400);
    }

    window.go = (name) => {
        if (!SECTIONS.includes(name)) name = 'home';
        window.setTimerFs(false);                       // a toast / link from the big timer drops back to the page
        spyLock = Date.now() + 900;                     // don't let the scroll-spy flicker while we glide there
        setCurrent(name);
        $('sec-' + name).scrollIntoView({ behavior: 'smooth', block: 'start' });
    };

    // visibility (pollers) and scroll-spy (a thin band near the top of the page)
    const seen = new IntersectionObserver((entries) => {
        entries.forEach((en) => {
            const k = en.target.id.slice(4);
            if (en.isIntersecting) vis.add(k); else vis.delete(k);
        });
        updatePollers();
    }, { root: main });
    const spy = new IntersectionObserver((entries) => {
        if (Date.now() < spyLock) return;
        entries.forEach((en) => { if (en.isIntersecting) setCurrent(en.target.id.slice(4)); });
    }, { root: main, rootMargin: '-10% 0px -75% 0px' });
    SECTIONS.forEach((k) => { seen.observe($('sec-' + k)); spy.observe($('sec-' + k)); });
    main.addEventListener('scroll', () => {
        if (Date.now() < spyLock) return;
        if (main.scrollTop + main.clientHeight >= main.scrollHeight - 4) setCurrent('end');   // last section never reaches the band
    }, { passive: true });

    window.competitionStart();
    saveRun();      // first render of everything that follows the run
    const first = location.hash.slice(1);
    if (SECTIONS.includes(first) && first !== 'home') {
        spyLock = Date.now() + 600;
        setCurrent(first);
        requestAnimationFrame(() => $('sec-' + first).scrollIntoView({ block: 'start' }));
    } else {
        setCurrent('home');
    }
})();