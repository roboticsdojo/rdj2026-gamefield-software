// Robotics Dojo control page - all front-end logic in one file.
// Sections: helpers, run state, timer, competition (teams/scoreboard),
// screen + detection, dispenser, obstacles, maps + RViz live (judges),
// finish run, team (/team), shell (sidebar / theme / pollers) - the shell must stay last.
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

// Screen categories are folder names on the Pi ('other' holds the metal images).
const CLASS_LABEL = { organic: 'Organic', metal: 'Metal', plastic: 'Plastic' };
const SCREEN_CATEGORY = { organic: 'organic', metal: 'other', plastic: 'plastic' };
function normClass(s) {
    s = (s || '').toLowerCase();
    if (s === 'other' || s === 'metal') return 'metal';
    return s === 'organic' || s === 'plastic' ? s : '';
}
const classLabel = (c) => CLASS_LABEL[c] || '—';

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
const STEPS = [
    ['screen', 'Gamefield screen', 'detectionMs'],
    ['loading', 'Loading station', 'loadedMs'],
    ['obstacles', 'Dynamic obstacles', null],
    ['maps', 'Map & RViz', 'stoppedMs'],
];

function newRun(team) {
    return { team: team || '', running: false, startedAt: 0, elapsedMs: 0, epochStart: 0,
             displayed: '', detected: '', detConf: null, detId: null, detectionMs: null,
             correct: null, loadedMs: null, stoppedMs: null, notes: '', done: {} };
}
let run = Object.assign(newRun(), store.get('dojoRun', {}));
const runListeners = [];
function onRun(fn) { runListeners.push(fn); }
function saveRun() { store.set('dojoRun', run); runListeners.forEach((fn) => fn()); }
const elapsed = () => (run.running ? Date.now() - run.startedAt : run.elapsedMs);


// ======================================================================
// TIMER
// ======================================================================
(function () {
    function tick() {
        const ms = elapsed();
        $('timer-display').textContent = fmt(ms);
        $('timer').classList.toggle('running', run.running);
    }
    setInterval(() => { if (run.running) tick(); }, 100);

    window.startRun = () => {
        if (run.running) return;
        if (!run.team) {
            toast('Pick a team first', 'Choose the team playing on the Home page.', 'Go to Home', () => window.go('home'));
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
        toast(resuming ? 'Timer resumed' : `Run started: ${run.team}`, 'The robot is on its way to the gamefield screen.',
              'Go to Gamefield Screen', () => window.go('screen'), 0, 'run');
    };

    window.stopRun = () => {
        if (!run.running) return;
        run.elapsedMs = Date.now() - run.startedAt;
        run.running = false;
        run.stoppedMs = run.elapsedMs;
        saveRun();
        window.pushCurrent();
        if (window.currentSection === 'maps') toast(`Timer stopped at ${fmt(run.elapsedMs)}`, 'Request the map or RViz live and finalise the run.', '', null, 0, 'run');
        else toast(`Timer stopped at ${fmt(run.elapsedMs)}`, 'Request the map or RViz live and finalise the run.',
                   'Go to Map Request', () => window.go('maps'), 0, 'run');
    };

    $('timer-start').addEventListener('click', window.startRun);
    $('timer-stop').addEventListener('click', window.stopRun);
    $('home-start').addEventListener('click', window.startRun);

    onRun(() => {
        tick();
        $('timer-start').disabled = run.running;
        $('timer-stop').disabled = !run.running;
        $('timer-start').querySelector('span').textContent = !run.running && run.elapsedMs ? 'Resume' : 'Start';
        $('home-start').disabled = run.running;
        $('team-chip').textContent = run.team || 'No team';
    });
})();

// ======================================================================
// COMPETITION: teams, scoreboard, home page (talks to /api/competition)
// ======================================================================
(function () {
    let comp = { teams: [], runs: [], current: null };

    window.pushCurrent = () => {
        api('/api/competition/current', { team: run.team, running: run.running,
            elapsed_ms: Math.round(elapsed()), section: window.currentSection || '' }).catch(() => {});
    };

    async function load() {
        try { comp = await api('/api/competition'); } catch (e) { return; }
        render();
    }
    window.competitionRefresh = load;

    function renderTeams() {
        const sel = $('team-select');
        // teams listed in index.html (data-teams) plus any added through "Manage teams"
        const preset = ($('team-select').dataset.teams || '').split(';').map((n) => n.trim()).filter(Boolean);
        const names = [...preset];
        comp.teams.forEach((n) => { if (!names.some((x) => x.toLowerCase() === n.toLowerCase())) names.push(n); });
        if (run.team && !names.some((n) => n.toLowerCase() === run.team.toLowerCase())) names.push(run.team);
        sel.replaceChildren(el('option', '', 'Select a team…'));
        sel.firstChild.value = '';
        names.forEach((n) => { const o = el('option', '', n); o.value = n; sel.appendChild(o); });
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

    function renderScoreboard() {
        const best = new Map();
        comp.runs.forEach((r) => {
            const k = r.team.toLowerCase();
            const b = best.get(k);
            if (!b) best.set(k, { team: r.team, run: r, count: 1 });
            else {
                b.count++;
                if (r.elapsed_ms < b.run.elapsed_ms) b.run = r;
            }
        });
        const rows = [...best.values()].sort((a, b) => a.run.elapsed_ms - b.run.elapsed_ms);
        const tb = $('scoreboard').querySelector('tbody');
        tb.replaceChildren();
        if (!rows.length) {
            const td = el('td', 'empty', 'No finished runs yet.');
            td.colSpan = 4;
            tb.appendChild(el('tr')).appendChild(td);
        }
        rows.forEach((r, i) => {
            const tr = el('tr', i === 0 ? 'top' : '');
            if (run.team && r.team.toLowerCase() === run.team.toLowerCase()) tr.classList.add('playing');
            tr.append(el('td', 'rank', String(i + 1)), el('td', '', r.team),
                      el('td', 'num', fmt(r.run.elapsed_ms)), el('td', 'num', String(r.count)));
            tb.appendChild(tr);
        });

        const rb = $('runs-table').querySelector('tbody');
        rb.replaceChildren();
        if (!comp.runs.length) {
            const td = el('td', 'empty', 'Nothing yet.');
            td.colSpan = 5;
            rb.appendChild(el('tr')).appendChild(td);
        }
        [...comp.runs].reverse().forEach((r) => {
            const tr = el('tr');
            const det = r.displayed ? `${classLabel(normClass(r.displayed))} → ${classLabel(normClass(r.detected))}` : '—';
            const del = el('button', 'del');
            del.title = 'Delete this run';
            del.appendChild(icon('x'));
            del.addEventListener('click', async () => {
                if (!confirm(`Delete ${r.team}'s run (${fmt(r.elapsed_ms)})?`)) return;
                await api('/api/competition/runs/' + r.id, undefined, 'DELETE');
                load();
            });
            const td = el('td');
            td.appendChild(del);
            tr.append(el('td', '', new Date(r.time * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })),
                      el('td', '', r.team), el('td', 'num', fmt(r.elapsed_ms)),
                      el('td', 'small', det), td);
            rb.appendChild(tr);
        });
    }

    function renderNowPlaying() {
        const box = $('now-playing');
        box.replaceChildren();
        if (!run.team) {
            box.appendChild(el('span', 'muted', 'Pick a team, then press Start. The timer runs at the top while you move through the sections.'));
            return;
        }
        box.appendChild(el('div', 'now-team', run.team));
        const state = run.running ? 'Running' : run.elapsedMs ? `Stopped at ${fmt(run.elapsedMs)}` : 'Ready to start';
        box.appendChild(el('div', 'now-meta', state));
    }

    function renderProgress() {
        const ol = $('progress-list');
        ol.replaceChildren();
        STEPS.forEach(([sec, name, timeKey], i) => {
            const li = el('li', run.done[sec] ? 'done' : '');
            li.append(el('span', 'p-dot', run.done[sec] ? '✓' : String(i + 1)), el('span', 'p-name', name),
                      el('span', 'p-time', timeKey && run[timeKey] !== null ? fmt(run[timeKey]) : ''));
            li.addEventListener('click', () => window.go(sec));
            ol.appendChild(li);
        });
    }

    function render() { renderTeams(); renderScoreboard(); renderNowPlaying(); renderProgress(); }
    onRun(() => { renderNowPlaying(); renderProgress(); $('team-select').disabled = run.running; });

    $('team-select').addEventListener('change', () => {
        const t = $('team-select').value;
        const hasData = run.elapsedMs > 0 || run.displayed || run.detected;
        if (hasData && t !== run.team && !confirm(`Discard the run in progress for ${run.team}?`)) {
            $('team-select').value = run.team;
            return;
        }
        run = hasData && t !== run.team ? newRun(t) : Object.assign(run, { team: t });
        saveRun();
        window.pushCurrent();
        renderScoreboard();
    });

    $('team-add').addEventListener('click', async () => {
        const name = $('team-new').value.trim();
        if (!name) return;
        const r = await api('/api/competition/teams', { name });
        if (!r.success) toast('Not added', r.message);
        $('team-new').value = '';
        load();
    });
    $('team-new').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('team-add').click(); });

    $('home-reset').addEventListener('click', () => {
        if (!confirm('Discard the run in progress? The timer and detection are cleared.')) return;
        const team = run.team;
        run = newRun(team);
        saveRun();
        window.pushCurrent();
    });

    let timer = null;
    window.competitionStart = () => { if (!timer) { load(); timer = setInterval(load, 5000); } };
    window.competitionStop = () => { clearInterval(timer); timer = null; };
    load();
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
            const data = await api('/api/set_display_class', { category: SCREEN_CATEGORY[cls] });
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
    $('v-mark-now').addEventListener('click', () => {
        if (!run.running && !run.elapsedMs) { toast('Timer not running', 'Start the run first.'); return; }
        run.detectionMs = elapsed();
        saveRun();
    });

    $('det-request').addEventListener('click', async () => {
        if (!run.team) { toast('No team selected', 'Pick the team on the Home page.'); return; }
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
            if (run.detectionMs === null && run.running) run.detectionMs = elapsed();
            if (run.displayed && run.detected) setCorrect(run.detected === run.displayed); else saveRun();
            const verdict = !run.detected ? 'no label sent' : run.correct ? 'correct' : 'WRONG';
            toast(`Robot detected ${classLabel(run.detected)}`, `Screen shows ${classLabel(run.displayed)}: ${verdict}.`,
                  'Go to Loading Station', () => window.go('loading'), 0, 'det');
        }
        const shown = dets.find((m) => m.id === run.detId) || (run.detId ? null : dets[0]);
        renderDetection(shown);
    };

    function renderDetection(m) {
        const img = $('det-img');
        $('det-empty').hidden = !!m;
        img.hidden = !m;
        const old = $('robot-detection-view').querySelector('.det-label');
        if (old) old.remove();
        if (!m) return;
        if (img.dataset.id !== m.id) { img.src = m.display_url; img.dataset.id = m.id; }
        const conf = m.confidence !== null && m.confidence !== undefined ? ` · ${Math.round(m.confidence * 100)}%` : '';
        $('robot-detection-view').appendChild(el('span', 'det-label', classLabel(normClass(m.label)) + conf));
        $('det-status').textContent = `Detection received ${new Date(m.time * 1000).toLocaleTimeString()}`;
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
        $('v-dettime').textContent = fmt(run.detectionMs);
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
            toast('Item loaded', `${text} at ${fmt(run.loadedMs)}.`, 'Go to Dynamic Obstacles', () => window.go('obstacles'));
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

    $('obs-copy').addEventListener('click', async () => {
        const text = 'Obstacles: ' + current.map((i) => `${cells[i].name} (x ${cells[i].cx}, y ${cells[i].cy})`).join('; ');
        try {
            await navigator.clipboard.writeText(text);
            $('obs-status').textContent = `Copied: ${describe()}`;
        } catch (e) {
            $('obs-status').textContent = text;   // clipboard API needs https/localhost
        }
    });

    // time-based: optionally reshuffle every N seconds
    let auto = null;
    function setAuto() {
        clearInterval(auto);
        auto = null;
        const s = Math.max(5, Number($('obs-auto-s').value) || 20);
        if ($('obs-auto').checked) auto = setInterval(randomize, s * 1000);
    }
    $('obs-auto').addEventListener('change', setAuto);
    $('obs-auto-s').addEventListener('change', setAuto);

    $('obs-stop-timer').addEventListener('click', () => {
        run.done.obstacles = true;
        window.go('maps');
        if (run.running) window.stopRun();
        else saveRun();
    });
    onRun(() => {
        $('obs-stop-timer').querySelector('span').textContent = run.running ? 'Stop timer & go to Map' : 'Go to Map';
    });

    randomize();   // start with a layout already shown
})();

// ======================================================================
// MAP REQUEST PANEL + RVIZ LIVE, judges - talks to /api/maps/*
// ======================================================================
(function () {
    const FORMAT_LABEL = { pgm: 'PGM map', screenshot: 'RViz screenshot', any: 'Either',
                           detection: 'Detection image', rviz_live: 'RViz live' };

    let maps = [];
    let known = null;          // ids already seen (null until first poll)
    let selectedId = null;
    let followLatest = true;
    let historySig = '';

    // ---- RViz live: the robot registers an MJPEG url (kind 'rviz'), we just show it
    let rvizStreams = [];
    let rvizPending = false;
    let liveStopped = false;       // the judge pressed Stop
    let knownStreams = null;       // 'team|url|time' keys already seen (null until first poll)
    let liveState = '';            // '' | 'loading' | 'live' | 'error'
    let shownUrl = '';

    function setStatus(t) { $('maps-status').textContent = t; }
    const ago = (s) => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`);

    $('maps-format').addEventListener('change', () => {
        $('maps-request-btn').querySelector('span').textContent =
            $('maps-format').value === 'rviz_live' ? 'Request RViz live' : 'Request map';
    });

    async function sendRequest(format, team) {
        setStatus('Sending request…');
        try {
            const data = await api('/api/maps/request', { format, team });
            setStatus(data.message);
            if (format === 'rviz_live') { liveStopped = false; setRviz(true, false); }
        } catch (e) { setStatus('Error connecting to web bridge'); }
        poll();
    }
    $('maps-request-btn').addEventListener('click', () => sendRequest($('maps-format').value, $('maps-team').value));
    $('rviz-request').addEventListener('click', () => sendRequest('rviz_live', run.team || $('maps-team').value));


    // ---- floating panel: open / collapsed state is remembered in the browser
    const rvizUI = store.get('dojoRviz', { open: false, collapsed: false });
    function setRviz(open, collapsed) {
        rvizUI.open = open;
        if (collapsed !== undefined) rvizUI.collapsed = collapsed;
        store.set('dojoRviz', rvizUI);
        window.rvizPanelOpen = open;
        $('rviz-panel').hidden = !open;
        $('rviz-panel').classList.toggle('collapsed', rvizUI.collapsed);
        $('rviz-body').hidden = rvizUI.collapsed;
        $('rviz-toggle').classList.toggle('active', open);
        renderLive();
        if (window.refreshPollers) window.refreshPollers();     // keep polling while the panel is open
    }
    $('rviz-toggle').addEventListener('click', () => setRviz(!rvizUI.open, false));
    $('rviz-collapse').addEventListener('click', () => setRviz(true, !rvizUI.collapsed));
    $('rviz-close').addEventListener('click', () => setRviz(false));
    $('rviz-head').addEventListener('click', (e) => { if (!e.target.closest('button')) setRviz(true, !rvizUI.collapsed); });

    function rvizUrl() {
        const manual = $('rviz-url').value.trim();
        if (manual) return { url: manual, team: run.team || '', time: null };
        const want = ($('maps-team').value.trim() || run.team || '').toLowerCase();
        const mine = rvizStreams.filter((x) => !want || x.team.toLowerCase() === want);
        const latest = mine.sort((a, b) => b.time - a.time)[0];
        return latest || null;
    }

    function renderLive() {
        // only pull the MJPEG stream while the panel is open and expanded, it eats bandwidth
        const img = $('rviz-stream');
        const s = rvizUrl();
        const on = rvizUI.open && !rvizUI.collapsed && !liveStopped && s;
        const url = on ? s.url : '';
        if (!url) {
            if (img.getAttribute('src')) img.removeAttribute('src');
            shownUrl = '';
            liveState = '';
        } else if (shownUrl !== url) {
            shownUrl = url;
            liveState = 'loading';
            img.src = url;
        }
        img.hidden = !url || liveState === 'error';
        $('rviz-empty').hidden = !img.hidden;
        $('rviz-live-dot').hidden = liveState !== 'live';
        $('rviz-empty-text').innerHTML = liveState === 'error'
            ? 'Cannot open the stream.<br>Check the robot is still running <code>dojo_rviz_stream.py</code> and is on the same network.'
            : liveStopped
                ? 'Stream stopped.<br>Press <b>Resume</b> to watch again.'
                : 'No RViz stream yet.<br>Press <b>Request</b> to ask the team.';
        $('rviz-stop').textContent = liveStopped ? 'Resume' : 'Stop';
        $('rviz-stop').disabled = !s;
        $('rviz-toggle').classList.toggle('live', liveState === 'live');
        $('rviz-meta').textContent = !s ? (rvizPending ? 'waiting for the robot…' : '—')
            : `${s.team || 'manual url'} · RViz live` + (s.time ? ` · registered ${new Date(s.time * 1000).toLocaleTimeString()}` : '') +
              (liveState === 'live' ? ' · streaming' : liveState === 'loading' ? ' · connecting…' : '');
    }
    $('rviz-stream').addEventListener('load', () => { liveState = 'live'; renderLive(); });
    $('rviz-stream').addEventListener('error', () => { if ($('rviz-stream').getAttribute('src')) { liveState = 'error'; renderLive(); } });
    $('rviz-url').addEventListener('change', () => { liveStopped = false; renderLive(); });
    $('rviz-stop').addEventListener('click', () => { liveStopped = !liveStopped; renderLive(); });

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
            else if (r.status === 'fulfilled') text += r.format === 'rviz_live' ? `streaming from ${r.answered_by}` : `received from ${r.answered_by}`;
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
        rvizStreams = (s.streams || []).filter((x) => x.kind === 'rviz');
        rvizPending = s.requests.some((r) => r.format === 'rviz_live' && r.status === 'pending');
        const keys = new Set(rvizStreams.map((x) => `${x.team}|${x.url}|${x.time}`));
        const newStream = knownStreams !== null && rvizStreams.find((x) => !knownStreams.has(`${x.team}|${x.url}|${x.time}`));
        knownStreams = keys;
        if (newStream) {
            liveStopped = false;
            setStatus(`RViz live from ${newStream.team}`);
            setRviz(true, false);
        }
        renderRequests(s.requests.filter((r) => r.format !== 'detection'));
        maps = s.maps.filter((m) => m.kind !== 'detection');
        const ids = new Set(maps.map((m) => m.id));
        const fresh = known === null ? [] : maps.filter((m) => !known.has(m.id));
        known = ids;
        if (fresh.length) {
            setStatus(`Map received from ${fresh[0].team}`);
            followLatest = true;
            if (window.currentSection !== 'maps') toast(`Map received from ${fresh[0].team}`, '', 'View map', () => window.go('maps'));
        }
        if (followLatest && maps.length) selectedId = maps[0].id;
        if (selectedId && !ids.has(selectedId)) selectedId = maps.length ? maps[0].id : null;
        const sig = maps.map((m) => m.id).join();
        if (sig !== historySig) { historySig = sig; renderHistory(); }
        renderViewer();
        renderLive();
    }

    async function poll() {
        try {
            const s = await api('/api/maps/status');
            render(s);
            window.screenOnMaps(s);
        } catch (e) { setStatus('Error connecting to web bridge'); }
    }

    let timer = null;
    window.mapsStart = () => { if (!timer) { poll(); timer = setInterval(poll, 1000); } renderLive(); };
    window.mapsStop = () => { clearInterval(timer); timer = null; renderLive(); };
    window.mapsPrefill = () => { if (run.team) $('maps-team').value = run.team; };
    setRviz(rvizUI.open, rvizUI.collapsed);
})();

// ======================================================================
// FINISH RUN
// ======================================================================
(function () {
    onRun(() => {
        if (document.activeElement !== $('run-notes')) $('run-notes').value = run.notes || '';
    });

    $('run-notes').addEventListener('input', () => { run.notes = $('run-notes').value; store.set('dojoRun', run); });

    $('finalize').addEventListener('click', async () => {
        if (!run.team) { toast('No team selected', 'Pick the team on the Home page.'); return; }
        if (run.running && !confirm('The timer is still running. Stop it and finalise?')) return;
        if (run.running) { run.elapsedMs = Date.now() - run.startedAt; run.running = false; run.stoppedMs = run.elapsedMs; }
        try {
            const r = await api('/api/competition/runs', {
                team: run.team, elapsed_ms: Math.round(run.elapsedMs), total: 0, scores: {},
                displayed: run.displayed, detected: run.detected, notes: run.notes,
            });
            if (!r.success) throw new Error(r.message);
            toast('Run saved', r.message);
            run = newRun();
            saveRun();
            window.competitionRefresh();
            window.go('home');
        } catch (e) {
            toast('Could not save the run', 'Check the web bridge is running, then try again.');
        }
    });
})();

// ======================================================================
// TEAM UPLOAD PAGE, /team - competitor fallback page
// ======================================================================
(function () {
    let pending = [];

    $('team').value = store.get('dojoTeam', '');
    $('token').value = store.get('dojoToken', '');

    const headers = () => ({ 'X-Dojo-Token': $('token').value });
    const team = () => $('team').value.trim();

    function kindOf(file) {
        const n = file.name.toLowerCase();
        if (n.endsWith('.pgm')) return 'pgm';
        if (/\.(png|jpe?g)$/.test(n)) return 'screenshot';
        return null;
    }

    function updateCmd() {
        const t = team() || 'YOUR_TEAM';
        $('cmd').textContent =
            `curl -fsSL ${location.origin}/static/dojo_map.py -o dojo_map.py\n` +
            `# answer map + detection requests:\n` +
            `python3 dojo_map.py --server ${location.origin} --team "${t}" --watch\n\n` +
            `curl -fsSL ${location.origin}/static/dojo_rviz_stream.py -o dojo_rviz_stream.py\n` +
            `# start RViz first, then answer "RViz live" requests (streams the RViz window):\n` +
            `python3 dojo_rviz_stream.py --server ${location.origin} --team "${t}" --watch`;
    }

    function updateSend() { $('send').disabled = !($('file').files[0] && team()); }

    async function refresh() {
        try {
            const st = await (await fetch('/api/maps/status')).json();
            $('token-row').hidden = !st.token_required;
            const res = await fetch('/api/maps/pending?team=' + encodeURIComponent(team()), { headers: headers() });
            const data = await res.json();
            pending = res.ok ? data.requests.filter((r) => r.format !== 'detection') : [];
            const box = $('pending');
            if (!res.ok) { box.className = 'pending none'; box.textContent = data.detail || 'Not allowed'; }
            else if (!pending.length) { box.className = 'pending none'; box.textContent = 'No request right now.'; }
            else {
                const r = pending[0], labels = { pgm: 'a PGM map', screenshot: 'an RViz screenshot', any: 'a map or RViz screenshot',
                                                 rviz_live: 'a live RViz stream (use the terminal command below)' };
                box.className = 'pending wait';
                box.textContent = `Judges want ${labels[r.format] || r.format} (${r.age_s}s ago)`;
            }
        } catch (e) { $('pending').textContent = 'Cannot reach the judges server'; }
    }

    $('file').addEventListener('change', () => {
        const f = $('file').files[0], img = $('preview');
        img.hidden = !(f && kindOf(f) === 'screenshot');      // browsers can't preview PGM
        if (!img.hidden) img.src = URL.createObjectURL(f);
        updateSend();
    });
    $('team').addEventListener('input', () => { store.set('dojoTeam', team()); updateCmd(); updateSend(); });
    $('token').addEventListener('input', () => store.set('dojoToken', $('token').value));

    $('send').addEventListener('click', async () => {
        const f = $('file').files[0], kind = kindOf(f), out = $('result');
        const req = pending.find((r) => r.format === 'any' || r.format === kind);
        const q = new URLSearchParams({ team: team(), filename: f.name });
        if (req) q.set('request_id', req.id);
        out.className = '';
        out.textContent = 'Sending…';
        try {
            const res = await fetch('/api/maps/upload?' + q, {
                method: 'POST', headers: { ...headers(), 'Content-Type': 'application/octet-stream' }, body: f });
            const data = await res.json();
            out.className = res.ok ? 'ok' : 'err';
            out.textContent = res.ok ? data.message : (data.detail || 'Upload failed');
        } catch (e) { out.className = 'err'; out.textContent = 'Cannot reach the judges server'; }
        refresh();
    });

    $('copy').addEventListener('click', async () => {
        try { await navigator.clipboard.writeText($('cmd').textContent); $('copy').textContent = 'Copied'; }
        catch (e) { $('copy').textContent = 'Select the text and copy'; }
    });

    updateCmd();
    updateSend();

    let timer = null;
    window.teamStart = () => { if (!timer) { refresh(); timer = setInterval(refresh, 2000); } };
})();

// ======================================================================
// SHELL: sidebar, sections, theme, pollers - must stay last
// ======================================================================
// One section visible at a time, remembered in the URL hash (e.g. /#loading).
// Pollers run while their section is visible; maps + dispenser also keep running
// during a run so detections and loads are caught whichever section is open.
(function () {
    const SECTIONS = ['home', 'screen', 'loading', 'obstacles', 'maps'];
    const NEXT = { screen: 'loading', loading: 'obstacles' };
    const NAMES = { loading: 'Loading Station', obstacles: 'Dynamic Obstacles' };
    const sidebar = $('sidebar');
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

    // ---- sidebar
    if (mobile() || store.get('dojoNavCollapsed', false)) sidebar.classList.add('collapsed');
    $('nav-toggle').addEventListener('click', () => {
        sidebar.classList.toggle('collapsed');
        if (!mobile()) store.set('dojoNavCollapsed', sidebar.classList.contains('collapsed'));
    });
    sidebar.querySelectorAll('.nav-item').forEach((b) => b.addEventListener('click', () => {
        window.go(b.dataset.section);
        if (mobile()) sidebar.classList.add('collapsed');
    }));

    // ---- pollers
    function updatePollers() {
        const s = window.currentSection;
        const live = run.running;
        if (s === 'screen' || s === 'maps' || live || window.rvizPanelOpen) window.mapsStart(); else window.mapsStop();
        if (s === 'loading' || live) window.dispenserStart(); else window.dispenserStop();
        if (s === 'home') window.competitionStart(); else window.competitionStop();
        if (s === 'screen') window.screenStart(); else window.screenStop();
    }
    onRun(updatePollers);
    window.refreshPollers = updatePollers;

    window.go = (name) => {
        if (!SECTIONS.includes(name)) name = 'home';
        SECTIONS.forEach((k) => { $('sec-' + k).hidden = k !== name; });
        sidebar.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.section === name));
        window.currentSection = name;
        history.replaceState(null, '', '#' + name);
        if (name === 'maps') window.mapsPrefill();
        updatePollers();
        $('sec-' + name).parentElement.scrollTop = 0;
        window.pushCurrent();
    };

    // "Confirm & go to ..." buttons at the bottom of each section
    document.querySelectorAll('[data-next]').forEach((b) => b.addEventListener('click', () => {
        const sec = b.dataset.next;
        run.done[sec] = true;
        saveRun();
        window.go(NEXT[sec]);
        toast(`${NAMES[NEXT[sec]]}`, '');
    }));

    onRun(() => {
        sidebar.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('done', !!run.done[b.dataset.section]));
    });

    // /team = competitor upload page: same file, but only the team view is shown.
    if (location.pathname.replace(/\/+$/, '') === '/team') {
        document.body.classList.add('team-mode');
        document.title = 'Robotics Dojo - Team Map Upload';
        SECTIONS.forEach((k) => { $('sec-' + k).hidden = true; });
        $('view-team').hidden = false;
        window.currentSection = 'team';
        window.teamStart();
        return;
    }

    saveRun();      // first render of everything that follows the run
    window.go(location.hash.slice(1));
})();