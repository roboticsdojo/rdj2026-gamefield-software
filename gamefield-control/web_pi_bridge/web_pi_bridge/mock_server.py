#!/usr/bin/env python3
"""View the judges' page with no Pi, no ROS and no pip installs (Python 3.8+ standard library only).

    cd gamefield-control/web_pi_bridge/web_pi_bridge
    python3 mock_server.py            # then open http://localhost:8000
    python3 mock_server.py 9000       # other port

It serves index.html, /static and /logos exactly like the real server and answers the /api calls with
harmless fake data (teams and finished runs are kept in memory until you stop it).
The loading station shows OFFLINE and the screen / robot feeds stay empty, as they would without hardware.
The barrier is simulated (a robot drives past its ultrasonic sensor every 20 s; open / close / reset work),
sending the same JSON as the real /api/barrier/status.
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

# ---- fake barrier: same shape as the real /api/barrier/status
BARRIER = {'state': 'CLOSED', 'target': 'CLOSED', 'until': 0.0}


def barrier_snapshot():
    now = time.time()
    if BARRIER['until'] and now >= BARRIER['until']:
        BARRIER['state'], BARRIER['until'] = BARRIER['target'], 0.0
    t = now % 20                       # a robot drives past the sensor: 90 cm -> 10 cm -> 90 cm, then nothing
    dist = int(10 + abs(t - 4) * 20) if t < 8 else -1
    angle = {'OPEN': 90, 'CLOSED': 0}.get(BARRIER['state'], 45)
    return {'online': True, 'events': [],
            'status': {'connected': True, 'state': BARRIER['state'], 'angle': angle, 'pot': 512,
                       'distance_cm': dist, 'sequence': 'IDLE', 'fault': 'NONE'}}


def barrier_move(target, moving):
    BARRIER.update(state=moving, target=target, until=time.time() + 1.0)
    time.sleep(1.0)                    # the real service answers once the gate has arrived
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
                       'category': cat if cat in ('slam', 'nav2', 'autonomy') else 'autonomy'}
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