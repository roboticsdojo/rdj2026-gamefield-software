// Robotics Dojo control page - all front-end logic in one file.
// One continuous page (no hidden sections). Sections: helpers, run state, timer (full screen + keys),
// competition (teams, navbar scoreboard for slam / nav2 / autonomy),
// screen + detection, dispenser, obstacles, map requests (judges),
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
const CLASS_LABEL = { organic: 'Organic', metal: 'Metal', plastic: 'Plastic' };
const SCREEN_CATEGORY = { organic: ['organic'], metal: ['metal', 'other'], plastic: ['plastic'] };
function normClass(s) {
    s = (s || '').toLowerCase();
    if (s === 'other' || s === 'metal') return 'metal';
    return s === 'organic' || s === 'plastic' ? s : '';
}
const classLabel = (c) => CLASS_LABEL[c] || '—';

// Challenges that get a time on the scoreboard. Runs saved before this existed have no category = autonomy.
const CATS = [['slam', 'SLAM'], ['nav2', 'Nav2'], ['autonomy', 'Behaviour Trees']];
const catLabel = (c) => (CATS.find((x) => x[0] === c) || CATS[2])[1];
const catOf = (r) => (r && (r.category === 'slam' || r.category === 'nav2') ? r.category : 'autonomy');

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
    setTimeout(close, ms || (actionLabel ? 12000 : 5000));
}

// ======================================================================
// RUN STATE
// ======================================================================
// The run being tracked lives in this browser (localStorage), so a refresh mid-run
// loses nothing. It is sent to the server only when finalised.
function newRun(team, category) {
    return { team: team || '', category: category || 'autonomy', running: false, startedAt: 0, elapsedMs: 0, epochStart: 0,
             displayed: '', detected: '', detConf: null, detId: null,
             correct: null, loadedMs: null, stoppedMs: null, notes: '' };
}
let run = Object.assign(newRun(), store.get('dojoRun', {}));
const runListeners = [];
function onRun(fn) { runListeners.push(fn); }
function saveRun() { store.set('dojoRun', run); runListeners.forEach((fn) => fn()); }
const elapsed = () => (run.running ? Date.now() - run.startedAt : run.elapsedMs);
// the map is only requested at the end: once the timer has been stopped
const mapsUnlocked = () => !run.running && run.stoppedMs !== null;


// ======================================================================
// TIMER (full screen, keyboard controlled)
// ======================================================================
(function () {
    const fsEl = $('timer-fs');
    let fsOpen = false;
    const STAGE_NAME = { home: 'Setup', screen: 'Gamefield screen', loading: 'Loading station',
                         obstacles: 'Dynamic obstacles', maps: 'Map request' };

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
        if (!fsOpen) toast('Full screen timer', 'Press F, or open it here.', 'Full screen', () => window.setTimerFs(true), 6000, 'fs');
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
    let sortKey = store.get('dojoSbSort', 'autonomy');      // 'team' | 'slam' | 'nav2' | 'autonomy'

    window.pushCurrent = () => {
        api('/api/competition/current', { team: run.team, running: run.running, category: run.category,
            elapsed_ms: Math.round(elapsed()), section: window.currentSection || '' }).catch(() => {});
    };

    async function load() {
        try { comp = await api('/api/competition'); } catch (e) { return; }
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
            td.colSpan = 4;
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
            const det = r.displayed ? `${classLabel(normClass(r.displayed))} → ${classLabel(normClass(r.detected))}` : '—';
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
        box.hidden = !run.team;
        if (!run.team) return;
        box.appendChild(el('div', 'now-team', run.team));
        const state = run.running ? 'Running' : run.elapsedMs ? `Stopped at ${fmt(run.elapsedMs)}` : 'Ready to start';
        box.appendChild(el('div', 'now-meta', `${catLabel(run.category)} · ${state}`));
    }

    function renderCat() {
        $('cat-seg').querySelectorAll('.seg-btn').forEach((b) => {
            b.classList.toggle('active', b.dataset.cat === run.category);
            b.disabled = run.running;
        });
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
        const hasData = run.elapsedMs > 0 || run.displayed || run.detected;
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
// GAMEFIELD SCREEN + ROBOT DETECTION
// ======================================================================
(function () {
    let screenShown = 'logo';
    let visible = false;

    function setStatus(t) { $('status').textContent = t; }

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
                if (run.detected) setCorrect(run.detected === cls); else saveRun();
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
            if (data.success) { screenShown = 'logo'; render(); }
        } catch (e) { setStatus('Error connecting to web bridge'); }
    });

    function setCorrect(value) {
        run.correct = value;
        saveRun();
    }
    $('v-correct').addEventListener('click', () => setCorrect(run.correct !== true));

    $('det-request').addEventListener('click', async () => {
        if (!run.team) return;
        $('det-status').textContent = 'Asking the robot for its detection…';
        try {
            const data = await api('/api/maps/request', { format: 'detection', team: run.team });
            $('det-status').textContent = data.message;
        } catch (e) { $('det-status').textContent = 'Error connecting to web bridge'; }
    });

    // Detection results arrive through the map exchange (kind = 'detection'); the maps
    // poller hands every status poll to this function.
    let known = null;
    window.screenOnMaps = (status) => {
        const team = (run.team || '').toLowerCase();
        // this team's detections from this run (60 s slack for clock differences)
        const dets = status.maps.filter((m) => m.kind === 'detection' && m.team.toLowerCase() === team &&
                                              (!run.epochStart || m.time * 1000 > run.epochStart - 60000));
        const ids = new Set(status.maps.filter((m) => m.kind === 'detection').map((m) => m.id));
        const fresh = known === null ? [] : dets.filter((m) => !known.has(m.id));
        known = ids;
        if (fresh.length && (run.running || run.elapsedMs)) {
            const m = fresh[0];
            run.detId = m.id;
            run.detected = normClass(m.label);
            run.detConf = m.confidence;
            if (run.displayed && run.detected) setCorrect(run.detected === run.displayed); else saveRun();
        }
        const shown = dets.find((m) => m.id === run.detId) || (run.detId ? null : dets[0]);
        renderDetection(shown);
    };

    function renderDetection(m) {
        if (m) $('det-status').textContent = `Detection received ${new Date(m.time * 1000).toLocaleTimeString()}`;
    }


    function renderScreenFeed() {
        // only load the gamefield screen's MJPEG feed while the section is on screen, it eats bandwidth
        const screen = $('live-stream');
        if (visible) { if (!screen.getAttribute('src')) screen.src = screen.dataset.src; }
        else screen.removeAttribute('src');
    }

    function render() {
        $('screen-shown').textContent = 'Screen: ' + (screenShown === 'logo' ? 'logo' : classLabel(screenShown));
        $('class-buttons').querySelectorAll('.class-btn').forEach((b) => {
            b.classList.toggle('active', normClass(b.dataset.cat) === screenShown);
        });
        $('v-displayed').textContent = classLabel(run.displayed);
        $('v-detected').textContent = run.detected ? classLabel(run.detected) +
            (run.detConf !== null && run.detConf !== undefined ? ` (${Math.round(run.detConf * 100)}%)` : '') : '—';
        const c = $('v-correct');
        c.setAttribute('aria-pressed', String(run.correct === true));
        c.classList.toggle('wrong', run.correct === false);
        c.querySelector('span').textContent = run.correct === false ? 'Incorrectly identified' : 'Correctly identified';
    }
    onRun(render);

    window.screenStart = () => { visible = true; renderScreenFeed(); };
    window.screenStop = () => { visible = false; renderScreenFeed(); };
})();

// ======================================================================
// LOADING STATION (dispenser) - talks to /api/dispenser/*
// ======================================================================
(function () {
    let enabled = true;
    let prev = null;             // previous snapshot, to log changes
    let stationClass = store.get('dojoStationMap', { 1: 'metal', 2: 'plastic', 3: 'organic' });

    // ---- build the 3 station cards once
    document.querySelectorAll('.station').forEach((card) => {
        const n = card.dataset.station;
        card.innerHTML = `
            <h3><span>STATION ${n}</span><span class="st-class"><select aria-label="Waste class of station ${n}">
                <option value="organic">Organic</option><option value="metal">Metal</option><option value="plastic">Plastic</option>
            </select></span></h3>
            <div class="left">- left</div>
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

    function log(text, cls) {
        const box = $('disp-log');
        const empty = box.querySelector('.empty');
        if (empty) empty.remove();
        const line = el('div', cls || '');
        const t = run.running ? fmt(elapsed()) : new Date().toLocaleTimeString();
        line.appendChild(el('span', 't', t));
        line.appendChild(document.createTextNode(text));
        box.appendChild(line);
        box.scrollTop = box.scrollHeight;
    }
    function clearLog() { $('disp-log').replaceChildren(el('div', 'empty', 'Station events appear here.')); }
    $('disp-log-clear').addEventListener('click', clearLog);
    clearLog();

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
                else if (was !== undefined && r > was) log(`Station ${i + 1} refilled (${r} left)`);
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
        document.querySelectorAll('.station').forEach((card, i) => {
            const left = st && st.remaining[i] !== undefined ? st.remaining[i] : null;
            card.querySelector('.left').textContent = left === null ? '- left' : `${left} left`;
            card.querySelector('.station-actions button').disabled = !idle || left === 0;
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
    grid.style.aspectRatio = `${AREA.x1 - AREA.x0} / ${AREA.y1 - AREA.y0}`;
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
// MAP REQUEST PANEL, judges - talks to /api/maps/*
// ======================================================================
(function () {
    const FORMAT_LABEL = { pgm: 'PGM map', screenshot: 'RViz screenshot', any: 'Either',
                           detection: 'Detection image' };

    let maps = [];
    let known = null;          // ids already seen (null until first poll)
    let selectedId = null;
    let followLatest = true;
    let historySig = '';

    function setStatus(t) { $('maps-status').textContent = t; }
    const ago = (s) => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`);

    async function sendRequest(format, team) {
        if (!mapsUnlocked()) return;
        setStatus('Sending request…');
        try {
            const data = await api('/api/maps/request', { format, team });
            setStatus(data.message);
        } catch (e) { setStatus('Error connecting to web bridge'); }
        poll();
    }
    $('maps-request-btn').addEventListener('click', () => sendRequest($('maps-format').value, $('maps-team').value));


    async function cancel(id) {
        try { await api(`/api/maps/request/${id}/cancel`, {}); } catch (e) { /* next poll shows state */ }
        poll();
    }

    function renderRequests(reqs) {
        const box = $('maps-requests');
        box.replaceChildren();
        reqs.slice(0, 4).forEach((r) => {
            const row = el('div', 'req req-' + r.status);
            let text = `${FORMAT_LABEL[r.format]} · ${r.team || 'any team'} · `;
            if (r.status === 'pending') text += `WAITING ${ago(r.age_s)}`;
            else if (r.status === 'fulfilled') text += `received from ${r.answered_by}`;
            else if (r.status === 'failed') text += `FAILED (${r.answered_by}): ${r.message || 'no reason given'}`;
            else text += r.status;
            row.appendChild(el('span', '', text));
            if (r.status === 'pending') {
                const b = el('button', 'btn btn-ghost btn-sm', 'Cancel');
                b.addEventListener('click', () => cancel(r.id));
                row.appendChild(b);
            }
            box.appendChild(row);
        });
    }

    function select(id, fromUser) {
        selectedId = id;
        if (fromUser) followLatest = maps.length > 0 && maps[0].id === id;
        renderViewer();
        renderHistory();
    }

    function renderViewer() {
        const m = maps.find((x) => x.id === selectedId);
        const img = $('maps-img');
        $('maps-empty').hidden = !!m;
        img.hidden = !m;
        const actions = $('maps-actions');
        actions.replaceChildren();
        if (!m) { $('maps-meta').textContent = '—'; return; }

        if (img.dataset.id !== m.id) { img.src = m.display_url + '?v=' + m.id; img.dataset.id = m.id; }
        img.className = m.kind === 'pgm' ? 'pixelated' : '';
        img.onclick = () => window.open(m.display_url, '_blank');

        const lines = [`${m.team} · ${m.kind === 'pgm' ? 'PGM map' : 'RViz screenshot'}`,
                       new Date(m.time * 1000).toLocaleTimeString()];
        if (m.width) lines.push(`${m.width} × ${m.height} px`);
        if (m.resolution) lines.push(`${m.resolution} m/px`);
        if (m.origin_x !== null && m.origin_x !== undefined) lines.push(`origin (${m.origin_x}, ${m.origin_y})`);
        lines.push(m.request_id ? 'answered a request' : 'unrequested');
        const meta = $('maps-meta');
        meta.replaceChildren();
        lines.forEach((l, i) => meta.appendChild(el('div', i === 0 ? 'meta-title' : '', l)));

        const a1 = el('a', 'btn btn-primary btn-sm', m.kind === 'pgm' ? 'Download PNG' : 'Download');
        a1.href = m.display_url;
        a1.download = `${m.team}_map.${m.kind === 'pgm' ? 'png' : m.ext}`;
        actions.appendChild(a1);
        if (m.kind === 'pgm') {
            const a2 = el('a', 'btn btn-ghost btn-sm', 'Download PGM');
            a2.href = m.original_url;
            actions.appendChild(a2);
        }
    }

    function renderHistory() {
        const box = $('maps-history');
        box.replaceChildren();
        maps.slice(0, 12).forEach((m) => {
            const b = el('button', 'thumb' + (m.id === selectedId ? ' active' : ''));
            const i = el('img');
            i.src = m.display_url;
            i.alt = '';
            if (m.kind === 'pgm') i.className = 'pixelated';
            b.appendChild(i);
            b.appendChild(el('span', '', `${m.team} · ${m.kind === 'pgm' ? 'PGM' : 'shot'}`));
            b.addEventListener('click', () => select(m.id, true));
            box.appendChild(b);
        });
    }

    function render(s) {
        renderRequests(s.requests.filter((r) => r.format !== 'detection'));
        maps = s.maps.filter((m) => m.kind !== 'detection');
        const ids = new Set(maps.map((m) => m.id));
        const fresh = known === null ? [] : maps.filter((m) => !known.has(m.id));
        known = ids;
        if (fresh.length) {
            setStatus(`Map received from ${fresh[0].team}`);
            followLatest = true;
        }
        if (followLatest && maps.length) selectedId = maps[0].id;
        if (selectedId && !ids.has(selectedId)) selectedId = maps.length ? maps[0].id : null;
        const sig = maps.map((m) => m.id).join();
        if (sig !== historySig) { historySig = sig; renderHistory(); }
        renderViewer();
    }

    async function poll() {
        try {
            const s = await api('/api/maps/status');
            render(s);
            window.screenOnMaps(s);
        } catch (e) { setStatus('Error connecting to web bridge'); }
    }

    let timer = null;
    window.mapsStart = () => { if (!timer) { poll(); timer = setInterval(poll, 1000); } };
    window.mapsStop = () => { clearInterval(timer); timer = null; };
    window.mapsPrefill = () => { if (run.team) $('maps-team').value = run.team; };

    function renderLock() {
        const ok = mapsUnlocked();
        $('maps-lock').hidden = ok;
        ['maps-format', 'maps-team', 'maps-request-btn'].forEach((id) => { $(id).disabled = !ok; });
        if (run.team && ok && !$('maps-team').value) $('maps-team').value = run.team;
    }
    onRun(renderLock);
    renderLock();
})();

// ======================================================================
// FINISH RUN
// ======================================================================
(function () {
    onRun(() => {
        if (document.activeElement !== $('run-notes')) $('run-notes').value = run.notes || '';
    });

    $('run-notes').addEventListener('input', () => { run.notes = $('run-notes').value; store.set('dojoRun', run); });

    window.endRun = async () => {
        if (!run.team) return;
        if (!run.running && run.elapsedMs <= 0) return;      // nothing timed yet
        if (run.running && !confirm('The timer is still running. Stop it and finalise?')) return;
        if (run.running) { run.elapsedMs = Date.now() - run.startedAt; run.running = false; run.stoppedMs = run.elapsedMs; }
        try {
            const r = await api('/api/competition/runs', {
                team: run.team, category: run.category, elapsed_ms: Math.round(run.elapsedMs), total: 0, scores: {},
                displayed: run.displayed, detected: run.detected, notes: run.notes,
            });
            if (!r.success) throw new Error(r.message);
            const saved = { team: run.team, cat: catLabel(run.category), time: fmt(run.elapsedMs) };
            run = newRun('', run.category);
            saveRun();
            window.competitionRefresh();
            window.go('home');
            toast(`Run saved for ${saved.team}`, `${saved.cat} · ${saved.time}`, '', null, 5000, 'saved');
        } catch (e) {
            console.error('Could not save the run', e);      // the run stays in the browser; try End run again
            toast('Could not save the run', 'Check the web bridge is running, then press End run again.', '', null, 6000, 'saved');
        }
    };
    $('finalize').addEventListener('click', window.endRun);
})();

// ======================================================================
// SHELL: sidebar jump links, scroll-spy, theme, pollers - must stay last
// ======================================================================
(function () {
    const SECTIONS = ['home', 'screen', 'loading', 'obstacles', 'maps'];
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
    if (mobile() || store.get('dojoNavCollapsed', false)) sidebar.classList.add('collapsed');
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
        if (vis.has('screen') || vis.has('maps') || live) window.mapsStart(); else window.mapsStop();
        if (vis.has('loading') || live) window.dispenserStart(); else window.dispenserStop();
        if (vis.has('screen')) window.screenStart(); else window.screenStop();
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
        if (main.scrollTop + main.clientHeight >= main.scrollHeight - 4) setCurrent('maps');   // last section never reaches the band
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