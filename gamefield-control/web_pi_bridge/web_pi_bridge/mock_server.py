#!/usr/bin/env python3
"""View the judges' page with no Pi, no ROS and no pip installs (Python 3.8+ standard library only).

    cd gamefield-control/web_pi_bridge/web_pi_bridge
    python3 mock_server.py            # then open http://localhost:8000
    python3 mock_server.py 9000       # other port

It serves index.html, /static and /logos exactly like the real server and answers the /api calls with
harmless fake data (teams and finished runs are kept in memory until you stop it).
The loading station shows OFFLINE and the screen / robot feeds stay empty, as they would without hardware.
The barrier is simulated: a robot drives past its ultrasonic sensor every 20 s and the detect sequence runs
(close, hold, open), and manual open / close / reset work. Same JSON as the real /api/barrier/status.
"""
import json
import mimetypes
import sys
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

HERE = Path(__file__).resolve().parent
COMP = {'teams': [], 'runs': [], 'current': None}

# ---- fake barrier: same shape as the real /api/barrier/status, and it runs the firmware's detect sequence
#      from OPEN  : close -> hold -> open        from CLOSED: wait -> open -> hold -> close
BARRIER = {'state': 'OPEN', 'target': 'OPEN', 'until': 0.0, 'seq': None, 'armed': True, 'events': [], 'eid': 0}
MOCK_MOVE_S, MOCK_HOLD_S, MOCK_WAIT_S = 1.0, 3.0, 2.0


def barrier_event(text):
    BARRIER['eid'] += 1
    BARRIER['events'].append({'id': BARRIER['eid'], 'time': time.time(), 'text': text})
    del BARRIER['events'][:-60]


def barrier_start_move(action):
    BARRIER.update(state='OPENING' if action == 'OPEN' else 'CLOSING',
                   target='OPEN' if action == 'OPEN' else 'CLOSED', until=time.time() + MOCK_MOVE_S)


def barrier_cancel_seq():
    if BARRIER['seq']:
        BARRIER['seq'] = None
        barrier_event('SEQ:CANCELLED')


def barrier_tick(dist):
    now = time.time()
    b = BARRIER
    if b['until'] and now >= b['until']:
        b['state'], b['until'] = b['target'], 0.0
    seq = b['seq']
    detected = 0 <= dist <= 30
    if not seq:
        if not detected:
            b['armed'] = True
        elif b['armed'] and b['state'] in ('OPEN', 'CLOSED'):
            origin = b['state']
            steps = [('CLOSE', MOCK_HOLD_S), ('OPEN', 0)] if origin == 'OPEN' else [('OPEN', MOCK_HOLD_S), ('CLOSE', 0)]
            b['seq'] = {'steps': steps, 'idx': -1, 'wait_until': now + (MOCK_WAIT_S if origin == 'CLOSED' else 0), 'hold_until': None}
            b['armed'] = False
            barrier_event(f'SEQ:START (from {origin})')
        return
    if seq['idx'] == -1:
        if now >= seq['wait_until']:
            seq['idx'] = 0
            barrier_start_move(seq['steps'][0][0])
        return
    action, hold = seq['steps'][seq['idx']]
    if b['state'] == ('OPEN' if action == 'OPEN' else 'CLOSED'):
        if seq['hold_until'] is None:
            seq['hold_until'] = now + hold
        if now >= seq['hold_until']:
            if seq['idx'] + 1 >= len(seq['steps']):
                b['seq'] = None
                barrier_event('SEQ:DONE')
            else:
                seq['idx'] += 1
                seq['hold_until'] = None
                barrier_start_move(seq['steps'][seq['idx']][0])


def barrier_snapshot():
    t = time.time() % 20               # a robot drives past the sensor: 90 cm -> 10 cm -> 90 cm, then nothing
    dist = int(10 + abs(t - 4) * 20) if t < 8 else -1
    barrier_tick(dist)
    angle = {'OPEN': 90, 'CLOSED': 0}.get(BARRIER['state'], 45)
    return {'online': True, 'events': list(BARRIER['events']),
            'status': {'connected': True, 'state': BARRIER['state'], 'angle': angle, 'pot': 512,
                       'distance_cm': dist, 'sequence': 'RUN' if BARRIER['seq'] else 'IDLE', 'fault': 'NONE'}}


def barrier_move(target, moving):
    barrier_cancel_seq()
    BARRIER.update(state=moving, target=target, until=time.time() + MOCK_MOVE_S)
    time.sleep(MOCK_MOVE_S)            # the real service answers once the gate has arrived
    barrier_snapshot()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):      # quiet
        pass

    # ---- helpers
    def send_json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, path: Path):
        if not path.is_file():
            self.send_error(404)
            return
        data = path.read_bytes()
        self.send_response(200)
        self.send_header('Content-Type', mimetypes.guess_type(str(path))[0] or 'application/octet-stream')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')      # edit a file, refresh, see it
        self.end_headers()
        self.wfile.write(data)

    def body(self):
        n = int(self.headers.get('Content-Length') or 0)
        try:
            return json.loads(self.rfile.read(n) or b'{}')
        except ValueError:
            return {}

    # ---- GET
    def do_GET(self):
        path = unquote(urlparse(self.path).path)
        if path == '/':
            return self.send_file(HERE / 'templates' / 'index.html')
        for prefix in ('/static/', '/logos/'):
            if path.startswith(prefix):
                f = (HERE / path.lstrip('/')).resolve()
                if HERE in f.parents:
                    return self.send_file(f)
                return self.send_error(403)
        if path == '/api/competition':
            return self.send_json(COMP)
        if path == '/api/barrier/status':
            return self.send_json(barrier_snapshot())
        if path == '/api/dispenser/status':
            return self.send_json({'online': False, 'status': None, 'goal': None, 'error': 'mock server: no loading station'})
        self.send_json({'success': False, 'message': 'mock server: not implemented'}, 404)

    # ---- POST / DELETE
    def do_POST(self):
        path = urlparse(self.path).path
        b = self.body()
        if path == '/api/competition/teams':
            name = (b.get('name') or '').strip()
            if not name:
                return self.send_json({'success': False, 'message': 'Team name is empty'})
            if name.lower() in (x.lower() for x in COMP['teams']):
                return self.send_json({'success': False, 'message': f'{name} already exists'})
            COMP['teams'].append(name)
            return self.send_json({'success': True, 'message': f'Added {name}'})
        if path == '/api/competition/current':
            COMP['current'] = b | {'time': time.time()}
            return self.send_json({'success': True})
        if path == '/api/competition/runs':
            cat = (b.get('category') or '').lower()
            run = b | {'id': uuid.uuid4().hex[:8], 'time': time.time(),
                       'category': cat if cat in ('nav2', 'autonomy') else 'autonomy'}
            COMP['runs'].append(run)
            COMP['current'] = None
            secs = run.get('elapsed_ms', 0) / 1000
            return self.send_json({'success': True, 'message': f"Saved {run.get('team')}: {int(secs // 60):02d}:{secs % 60:04.1f}"})
        if path in ('/api/set_display_class', '/api/set_display'):
            return self.send_json({'success': True, 'message': 'Mock: screen command accepted'})
        if path in ('/api/barrier/open', '/api/barrier/close', '/api/barrier/reset'):
            cmd = path.rsplit('/', 1)[1]
            target = 'OPEN' if cmd == 'open' else 'CLOSED'
            barrier_move(target, 'OPENING' if cmd == 'open' else 'CLOSING')
            return self.send_json({'success': True, 'message': f'Barrier {target.lower()}' if cmd != 'reset' else 'Barrier closed'})
        if path.startswith('/api/dispenser/'):
            return self.send_json({'success': False, 'message': 'Mock: no loading station'})
        self.send_json({'success': False, 'message': 'mock server: not implemented'}, 404)

    def do_DELETE(self):
        path = unquote(urlparse(self.path).path)
        if path.startswith('/api/competition/teams/'):
            n = path.rsplit('/', 1)[1].lower()
            COMP['teams'] = [t for t in COMP['teams'] if t.lower() != n]
            return self.send_json({'success': True, 'message': 'Removed'})
        if path.startswith('/api/competition/runs/'):
            rid = path.rsplit('/', 1)[1]
            COMP['runs'] = [r for r in COMP['runs'] if r['id'] != rid]
            return self.send_json({'success': True, 'message': 'Run deleted'})
        self.send_json({'success': False, 'message': 'mock server: not implemented'}, 404)


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    print(f'Judges page (mock data): http://localhost:{port}   (Ctrl+C to stop)')
    ThreadingHTTPServer(('127.0.0.1', port), Handler).serve_forever()