"""Robotics Dojo web bridge: everything the laptop serves, in one module.

Sections
  1. Screen bridge      ROS node + /api/set_display*  (Pi screen_manager_node)
  2. Dispenser bridge   ROS node + /api/dispenser/*   (loading station)
  3. Map exchange       /api/maps/*  (judges <-> competing teams, pure FastAPI, no ROS)
                        also carries the robot's detection image and live-stream URL
  4. Competition        /api/competition/*  (teams, finished runs = scoreboard, current run)
  5. App                lifespan, routers, static files, logos, pages, main()

--------------------------------------------------------------------------
Dispenser ROS interface (all under /gamefield/loading_station):
  action   dispense  loading_station_interfaces/action/Dispense
  service  enable    std_srvs/srv/SetBool
  service  home      std_srvs/srv/Trigger
  service  reset     std_srvs/srv/Trigger
  topic    status    loading_station_interfaces/msg/StationStatus (latched)

Map exchange flow
  1. A judge clicks "Request" on the Map Request panel     -> POST /api/maps/request
  2. A team's script (or the /team page) sees it            -> GET  /api/maps/pending
  3. The team uploads a PGM map or an RViz screenshot       -> POST /api/maps/upload
  4. The judges' page picks it up while polling             -> GET  /api/maps/status
     PGM files are converted to PNG for display (browsers can't show PGM); the
     original is kept and downloadable.
  Detection images use the same flow with format "detection": the robot uploads the
  frame it classified plus ?kind=detection&label=plastic&confidence=0.93.
  RViz live: a judge requests format "rviz_live"; the team's dojo_rviz_stream.py sees it
  (GET /api/maps/pending), streams the RViz window as MJPEG and registers the URL with
  kind "rviz"                                         -> POST /api/maps/stream
  The judges' page shows that URL in the "RViz live" tab (the browser pulls it straight
  from the robot, nothing is relayed through this server).

Environment
  DOJO_MAP_DIR  where received files and competition.json are stored (default ~/dojo_maps)
  DOJO_TOKEN    if set, teams must send it as header X-Dojo-Token to upload
"""
import asyncio
import json
import os
import re
import struct
import threading
import time
import urllib.request
import uuid
import zlib
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal, Optional

from fastapi import APIRouter, FastAPI, Header, HTTPException, Request
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from ament_index_python.packages import get_package_share_directory

import rclpy
from action_msgs.msg import GoalStatus
from example_interfaces.srv import SetBool as ScreenSetBool   # screen_manager uses example_interfaces
from rclpy.action import ActionClient
from rclpy.executors import MultiThreadedExecutor
from rclpy.node import Node
from rclpy.qos import DurabilityPolicy, HistoryPolicy, QoSProfile, ReliabilityPolicy
from screen_interfaces.srv import SetDisplayClass
from std_srvs.srv import SetBool, Trigger                      # loading station uses std_srvs

try:
    from loading_station_interfaces.action import Dispense
    from loading_station_interfaces.msg import StationStatus
    INTERFACES_OK = True
except ImportError:  # lets the screen page keep working if this package isn't built
    INTERFACES_OK = False


# =========================================================================
# 1. SCREEN BRIDGE
# =========================================================================
class WebBridgeNode(Node):
    def __init__(self):
        super().__init__('web_pi_bridge_node')
        self.cli = self.create_client(ScreenSetBool, '/screen_manager_node/set_display')
        self.class_cli = self.create_client(SetDisplayClass, '/screen_manager_node/set_display_class')
        self.get_logger().info('WebBridgeNode initialized, waiting for screen manager service...')

    async def _call(self, client, request, timeout_sec=5.0):
        if not client.wait_for_service(timeout_sec=2.0):
            return False, "Screen manager service unavailable"

        future = client.call_async(request)
        elapsed = 0.0
        while not future.done() and elapsed < timeout_sec:
            await asyncio.sleep(0.05)
            elapsed += 0.05

        if future.done():
            try:
                response = future.result()
                return response.success, response.message
            except Exception as e:
                return False, f"Service execution failed: {e}"

        return False, "Service request timed out"

    async def call_set_display(self, state: bool):
        req = ScreenSetBool.Request()
        req.data = state
        return await self._call(self.cli, req)

    async def call_set_display_class(self, category: str):
        req = SetDisplayClass.Request()
        req.category = category
        return await self._call(self.class_cli, req)


class DisplayRequest(BaseModel):
    state: bool


class DisplayClassRequest(BaseModel):
    category: str


ros_node = None  # set by lifespan


# =========================================================================
# 2. DISPENSER BRIDGE
# =========================================================================
BASE = '/gamefield/loading_station'
STATUS_STALE_S = 3.0  # node publishes at 2 Hz; older than this = considered offline


class DispenserBridgeNode(Node):
    def __init__(self):
        super().__init__('dispenser_web_bridge')
        self._lock = threading.Lock()
        self._status = None          # dict from the last StationStatus
        self._status_time = 0.0
        self._goal = None            # dict describing the latest dispense goal
        self._goal_handle = None

        self.enable_cli = self.create_client(SetBool, f'{BASE}/enable')
        self.home_cli = self.create_client(Trigger, f'{BASE}/home')
        self.reset_cli = self.create_client(Trigger, f'{BASE}/reset')
        self.action_cli = ActionClient(self, Dispense, f'{BASE}/dispense')

        # must be TRANSIENT_LOCAL to match the latched publisher
        latched = QoSProfile(
            depth=1,
            history=HistoryPolicy.KEEP_LAST,
            reliability=ReliabilityPolicy.RELIABLE,
            durability=DurabilityPolicy.TRANSIENT_LOCAL)
        self.create_subscription(StationStatus, f'{BASE}/status', self._on_status, latched)
        self.get_logger().info('DispenserBridgeNode initialized')

    # ------------------------------------------------------------ status
    def _on_status(self, msg):
        with self._lock:
            self._status = {
                'enabled': bool(msg.enabled),
                'serial_connected': bool(msg.serial_connected),
                'state': msg.state,
                'remaining': [int(r) for r in msg.remaining],
                'last_message': msg.last_message,
            }
            self._status_time = time.monotonic()

    def snapshot(self):
        with self._lock:
            online = (self._status is not None and
                      time.monotonic() - self._status_time < STATUS_STALE_S)
            return {
                'online': online,
                'status': dict(self._status) if self._status else None,
                'goal': dict(self._goal) if self._goal else None,
            }

    # ---------------------------------------------------------- services
    async def _call(self, client, request, timeout_sec=12.0):
        # home/reset move servos and can take several seconds, hence the long timeout
        if not client.service_is_ready():
            return False, 'Loading station service unavailable'
        future = client.call_async(request)
        elapsed = 0.0
        while not future.done() and elapsed < timeout_sec:
            await asyncio.sleep(0.05)
            elapsed += 0.05
        if not future.done():
            return False, 'Service request timed out'
        try:
            res = future.result()
            return res.success, res.message
        except Exception as e:
            return False, f'Service execution failed: {e}'

    async def call_enable(self, enabled: bool):
        req = SetBool.Request()
        req.data = enabled
        return await self._call(self.enable_cli, req)

    async def call_home(self):
        return await self._call(self.home_cli, Trigger.Request())

    async def call_reset(self):
        return await self._call(self.reset_cli, Trigger.Request())

    # ------------------------------------------------------------ action
    def _goal_active(self):
        return self._goal is not None and self._goal['state'] in ('SENDING', 'RUNNING')

    def send_dispense(self, station_id: int, count: int):
        """Fire-and-forget: returns at once, progress is exposed via snapshot()."""
        if not self.action_cli.server_is_ready():
            return False, 'Loading station action server unavailable'
        with self._lock:
            if self._goal_active():
                return False, 'A dispense is already in progress'
            self._goal = {'station': station_id, 'count': count, 'state': 'SENDING',
                          'operation': '', 'pieces': 0, 'message': ''}
            self._goal_handle = None

        goal = Dispense.Goal()
        goal.station_id = station_id
        goal.count = count
        fut = self.action_cli.send_goal_async(goal, feedback_callback=self._on_feedback)
        fut.add_done_callback(self._on_goal_response)
        return True, f'Dispensing {count} from station {station_id}...'

    def _on_goal_response(self, fut):
        handle = fut.result()
        with self._lock:
            if not handle.accepted:
                self._goal.update(state='REJECTED', message='Goal rejected by loading station')
                return
            self._goal_handle = handle
            self._goal['state'] = 'RUNNING'
        handle.get_result_async().add_done_callback(self._on_result)

    def _on_feedback(self, fb_msg):
        fb = fb_msg.feedback
        with self._lock:
            if self._goal:
                self._goal.update(operation=fb.current_operation, pieces=int(fb.pieces_dispensed))

    def _on_result(self, fut):
        wrapped = fut.result()
        names = {GoalStatus.STATUS_SUCCEEDED: 'SUCCEEDED',
                 GoalStatus.STATUS_CANCELED: 'CANCELED',
                 GoalStatus.STATUS_ABORTED: 'ABORTED'}
        with self._lock:
            if self._goal:
                self._goal.update(state=names.get(wrapped.status, 'ABORTED'),
                                  pieces=int(wrapped.result.pieces_dispensed),
                                  message=wrapped.result.message)

    def cancel_dispense(self):
        with self._lock:
            handle = self._goal_handle if self._goal_active() else None
        if handle is None:
            return False, 'Nothing to cancel'
        handle.cancel_goal_async()
        return True, 'Cancel requested'


dispenser_router = APIRouter(prefix='/api/dispenser', tags=['dispenser'])
dispenser_node = None  # set by lifespan; None if interfaces missing


def make_dispenser_node():
    """Create the node, or None if the interface package isn't installed."""
    return DispenserBridgeNode() if INTERFACES_OK else None


class EnableRequest(BaseModel):
    enabled: bool


class DispenseRequest(BaseModel):
    station_id: int = Field(ge=1, le=3)
    count: int = Field(default=1, ge=1, le=4)


def _disp_unavailable():
    return {'success': False,
            'message': 'loading_station_interfaces not installed on this machine'}


@dispenser_router.get('/status')
async def dispenser_status():
    if dispenser_node is None:
        return {'online': False, 'status': None, 'goal': None,
                'error': _disp_unavailable()['message']}
    return dispenser_node.snapshot()


@dispenser_router.post('/dispense')
async def dispenser_dispense(req: DispenseRequest):
    if dispenser_node is None:
        return _disp_unavailable()
    ok, msg = dispenser_node.send_dispense(req.station_id, req.count)
    return {'success': ok, 'message': msg}


@dispenser_router.post('/cancel')
async def dispenser_cancel():
    if dispenser_node is None:
        return _disp_unavailable()
    ok, msg = dispenser_node.cancel_dispense()
    return {'success': ok, 'message': msg}


@dispenser_router.post('/enable')
async def dispenser_enable(req: EnableRequest):
    if dispenser_node is None:
        return _disp_unavailable()
    ok, msg = await dispenser_node.call_enable(req.enabled)
    return {'success': ok, 'message': msg}


@dispenser_router.post('/home')
async def dispenser_home():
    if dispenser_node is None:
        return _disp_unavailable()
    ok, msg = await dispenser_node.call_home()
    return {'success': ok, 'message': msg}


@dispenser_router.post('/reset')
async def dispenser_reset():
    if dispenser_node is None:
        return _disp_unavailable()
    ok, msg = await dispenser_node.call_reset()
    return {'success': ok, 'message': msg}


# =========================================================================
# 3. MAP EXCHANGE
# =========================================================================
MAX_BYTES = 25 * 1024 * 1024     # largest accepted upload
REQUEST_TTL_S = 600              # an unanswered request expires after 10 minutes
KEEP = 50                        # how many requests / maps to remember
PNG_MAGIC = b'\x89PNG\r\n\x1a\n'

maps_router = APIRouter(prefix='/api/maps', tags=['maps'])

_requests = []   # oldest first
_maps = []       # oldest first (maps, screenshots and detection images)
_streams = {}    # (team lower case, kind) -> {'team', 'kind', 'url', 'time'}


def map_dir() -> Path:
    return Path(os.environ.get('DOJO_MAP_DIR') or Path.home() / 'dojo_maps')


# ---------------------------------------------------------------- file formats
def sniff(data: bytes):
    """Return (kind, ext): kind is 'pgm' or 'screenshot'; None if unsupported."""
    if data[:2] in (b'P5', b'P2'):
        return 'pgm', 'pgm'
    if data[:8] == PNG_MAGIC:
        return 'screenshot', 'png'
    if data[:3] == b'\xff\xd8\xff':
        return 'screenshot', 'jpg'
    return None


def _pgm_tokens(data, count, start=2):
    toks, i, n = [], start, len(data)
    while len(toks) < count and i < n:
        c = data[i:i + 1]
        if c == b'#':
            while i < n and data[i:i + 1] not in (b'\n', b'\r'):
                i += 1
        elif c.isspace():
            i += 1
        else:
            j = i
            while j < n and not data[j:j + 1].isspace():
                j += 1
            toks.append(data[i:j])
            i = j
    return toks, i


def parse_pgm(data: bytes):
    """Parse P5 (binary) or P2 (ascii) PGM -> (width, height, 8-bit pixel bytes)."""
    toks, i = _pgm_tokens(data, 3)
    if len(toks) < 3:
        raise ValueError('truncated PGM header')
    w, h, maxval = (int(t) for t in toks)
    if w <= 0 or h <= 0 or not 0 < maxval <= 65535:
        raise ValueError('bad PGM header')
    count = w * h
    if data[:2] == b'P5':
        raw = data[i + 1:]                       # exactly one whitespace byte after maxval
        if maxval > 255:
            if len(raw) < count * 2:
                raise ValueError('PGM raster is shorter than its header says')
            raw = raw[0:count * 2:2]             # keep the high byte
            maxval = 255 if maxval == 65535 else (maxval >> 8)
        elif len(raw) < count:
            raise ValueError('PGM raster is shorter than its header says')
        px = raw[:count]
    else:
        vals = data[i:].split()
        if len(vals) < count:
            raise ValueError('PGM raster is shorter than its header says')
        px = bytes(min(255, int(v)) for v in vals[:count])
    if maxval not in (255, 0):
        table = bytes(min(255, v * 255 // maxval) for v in range(256))
        px = px.translate(table)
    return w, h, px


def gray_png(w: int, h: int, px: bytes) -> bytes:
    """Minimal 8-bit grayscale PNG encoder (no Pillow needed)."""
    def chunk(tag, body):
        return (struct.pack('>I', len(body)) + tag + body +
                struct.pack('>I', zlib.crc32(tag + body) & 0xffffffff))
    raw = b''.join(b'\x00' + px[y * w:(y + 1) * w] for y in range(h))
    return (PNG_MAGIC + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 0, 0, 0, 0)) +
            chunk(b'IDAT', zlib.compress(raw, 6)) + chunk(b'IEND', b''))


# --------------------------------------------------------------------- helpers
def _check_token(token: str):
    required = os.environ.get('DOJO_TOKEN', '')
    if required and token != required:
        raise HTTPException(401, 'Wrong or missing token (set DOJO_TOKEN / --token)')


def _clean_team(name: str) -> str:
    return re.sub(r'[^A-Za-z0-9 _.-]', '', (name or '').strip())[:32]


def _expire():
    now = time.time()
    for r in _requests:
        if r['status'] == 'pending' and now - r['created'] > REQUEST_TTL_S:
            r['status'] = 'expired'


def _find_request(rid: str):
    return next((r for r in _requests if r['id'] == rid), None)


def _public_request(r):
    return {**r, 'age_s': int(time.time() - r['created'])}


def _public_map(m):
    return {k: m[k] for k in ('id', 'team', 'kind', 'width', 'height', 'resolution',
                              'origin_x', 'origin_y', 'request_id', 'time', 'size', 'ext')} | {
        'label': m.get('label', ''),
        'confidence': m.get('confidence'),
        'display_url': f"/api/maps/file/{m['id']}",
        'original_url': f"/api/maps/file/{m['id']}/original",
    }


# ------------------------------------------------------------------ judge side
class NewRequest(BaseModel):
    format: Literal['pgm', 'screenshot', 'any', 'detection', 'rviz_live'] = 'any'
    team: str = ''


@maps_router.get('/status')
async def maps_status():
    _expire()
    return {
        'token_required': bool(os.environ.get('DOJO_TOKEN')),
        'requests': [_public_request(r) for r in reversed(_requests[-15:])],
        'maps': [_public_map(m) for m in reversed(_maps[-30:])],
        'streams': list(_streams.values()),
    }


@maps_router.post('/request')
async def create_request(req: NewRequest):
    r = {'id': uuid.uuid4().hex[:6], 'format': req.format, 'team': _clean_team(req.team),
         'status': 'pending', 'created': time.time(), 'map_id': None,
         'answered_by': '', 'message': ''}
    _requests.append(r)
    del _requests[:-KEEP]
    what = {'detection': 'detection image', 'rviz_live': 'RViz live stream'}.get(req.format, f'{req.format} map')
    return {'success': True, 'message': f"Requested {what}"
            + (f" from {r['team']}" if r['team'] else ' from any team'), 'id': r['id']}


@maps_router.post('/request/{rid}/cancel')
async def cancel_request(rid: str):
    r = _find_request(rid)
    if r is None or r['status'] != 'pending':
        return {'success': False, 'message': 'Request is not pending'}
    r['status'] = 'cancelled'
    return {'success': True, 'message': 'Request cancelled'}


def _map_file(map_id: str):
    m = next((m for m in _maps if m['id'] == map_id), None)   # lookup by id, never by path
    if m is None:
        raise HTTPException(404, 'Unknown map')
    return m


@maps_router.get('/file/{map_id}')
async def display_file(map_id: str):
    m = _map_file(map_id)
    path = map_dir() / m['display_file']
    if not path.exists():
        raise HTTPException(404, 'File missing on disk')
    return FileResponse(path, media_type='image/jpeg' if m['ext'] == 'jpg' else 'image/png')


@maps_router.get('/file/{map_id}/original')
async def original_file(map_id: str):
    m = _map_file(map_id)
    path = map_dir() / m['file']
    if not path.exists():
        raise HTTPException(404, 'File missing on disk')
    return FileResponse(path, media_type='application/octet-stream', filename=m['file'])


# ------------------------------------------------------------- competitor side
@maps_router.get('/pending')
async def pending(team: str = '', x_dojo_token: str = Header(default='')):
    _check_token(x_dojo_token)
    _expire()
    t = _clean_team(team).lower()
    return {'requests': [_public_request(r) for r in _requests
                         if r['status'] == 'pending' and (not r['team'] or r['team'].lower() == t)]}


@maps_router.post('/upload')
async def upload(request: Request, team: str = '', request_id: str = '', filename: str = '',
                 resolution: Optional[float] = None, origin_x: Optional[float] = None,
                 origin_y: Optional[float] = None, kind: str = '', label: str = '',
                 confidence: Optional[float] = None, x_dojo_token: str = Header(default='')):
    _check_token(x_dojo_token)
    _expire()
    if int(request.headers.get('content-length') or 0) > MAX_BYTES:
        raise HTTPException(413, f'File too large (max {MAX_BYTES // 1024 // 1024} MB)')
    body = await request.body()
    if len(body) > MAX_BYTES:
        raise HTTPException(413, f'File too large (max {MAX_BYTES // 1024 // 1024} MB)')

    sniffed = sniff(body)
    if sniffed is None:
        raise HTTPException(422, 'Unsupported file: send a .pgm, .png or .jpg')
    asked_kind = kind
    kind, ext = sniffed
    team = _clean_team(team) or 'unknown'

    req = None
    if request_id:
        req = _find_request(request_id)
        if req is None or req['status'] != 'pending':
            raise HTTPException(409, f'Request {request_id} is not pending (answered, cancelled or expired)')

    # a detection is the camera frame the robot classified; it's a png/jpg with a label
    if asked_kind == 'detection' or (req and req['format'] == 'detection'):
        if kind != 'screenshot':
            raise HTTPException(422, 'A detection must be a .png or .jpg image')
        kind = 'detection'

    if req:
        if req['format'] != 'any' and req['format'] != kind:
            raise HTTPException(422, f"Request {request_id} wants a {req['format']}, but this file is a {kind}")
        if req['format'] == 'any' and kind == 'detection':
            raise HTTPException(422, f'Request {request_id} wants a map, not a detection image')
        if req['team'] and req['team'].lower() != team.lower():
            raise HTTPException(403, f"Request {request_id} is addressed to team {req['team']}")

    width = height = None
    display_ext = ext
    display_bytes = body
    if kind == 'pgm':
        try:
            width, height, px = parse_pgm(body)
        except ValueError as e:
            raise HTTPException(422, f'Bad PGM: {e}')
        display_bytes, display_ext = gray_png(width, height, px), 'png'
    elif ext == 'png' and len(body) >= 24:
        width, height = struct.unpack('>II', body[16:24])

    mid = uuid.uuid4().hex[:8]
    stem = f"{time.strftime('%H%M%S')}_{re.sub(r'[^A-Za-z0-9_-]', '_', team)}_{mid}"
    d = map_dir()
    try:
        d.mkdir(parents=True, exist_ok=True)
        (d / f'{stem}.{ext}').write_bytes(body)
        if display_ext != ext or display_bytes is not body:
            (d / f'{stem}_view.{display_ext}').write_bytes(display_bytes)
    except OSError as e:
        raise HTTPException(500, f'Could not store file in {d}: {e}')

    _maps.append({'id': mid, 'team': team, 'kind': kind, 'ext': ext, 'width': width,
                  'height': height, 'resolution': resolution, 'origin_x': origin_x,
                  'origin_y': origin_y, 'request_id': req['id'] if req else None,
                  'time': time.time(), 'size': len(body), 'file': f'{stem}.{ext}',
                  'display_file': f'{stem}_view.{display_ext}' if display_ext != ext else f'{stem}.{ext}',
                  'label': re.sub(r'[^a-z]', '', label.lower())[:16] if kind == 'detection' else '',
                  'confidence': confidence if kind == 'detection' else None})
    del _maps[:-KEEP]
    if req:
        req.update(status='fulfilled', map_id=mid, answered_by=team)
    return {'success': True, 'map_id': mid,
            'message': f'Received {kind} from {team}' + (f' for request {req["id"]}' if req else ' (unrequested)')}


class StreamInfo(BaseModel):
    team: str = ''
    url: str = ''             # blank = remove
    kind: Literal['rviz', 'camera'] = 'rviz'
    request_id: str = ''      # optional: the "rviz_live" request this stream answers


@maps_router.post('/stream')
async def register_stream(s: StreamInfo, x_dojo_token: str = Header(default='')):
    """The robot tells the judges where its MJPEG stream (RViz window or camera) lives."""
    _check_token(x_dojo_token)
    team = _clean_team(s.team)
    if not team:
        raise HTTPException(422, 'team is required')
    url = s.url.strip()
    key = (team.lower(), s.kind)
    if not url:
        _streams.pop(key, None)
        return {'success': True, 'message': f'Stream for {team} removed'}
    if len(url) > 300 or not re.fullmatch(r'https?://[^\s"\'<>]+', url):
        raise HTTPException(422, 'url must look like http://<robot-ip>:8081/stream')
    _expire()
    req = _find_request(s.request_id) if s.request_id else None
    if req is not None and req['status'] == 'pending' and req['format'] == 'rviz_live':
        if req['team'] and req['team'].lower() != team.lower():
            raise HTTPException(403, f"Request {s.request_id} is addressed to team {req['team']}")
        req.update(status='fulfilled', answered_by=team)
    _streams[key] = {'team': team, 'kind': s.kind, 'url': url, 'time': time.time()}
    return {'success': True, 'message': f'{s.kind} stream for {team} registered'}


class Failure(BaseModel):
    team: str = ''
    message: str = ''


@maps_router.post('/request/{rid}/fail')
async def fail_request(rid: str, f: Failure, x_dojo_token: str = Header(default='')):
    _check_token(x_dojo_token)
    r = _find_request(rid)
    if r is None or r['status'] != 'pending':
        raise HTTPException(409, 'Request is not pending')
    r.update(status='failed', answered_by=_clean_team(f.team) or 'unknown', message=f.message[:200])
    return {'success': True, 'message': 'Failure reported to judges'}


# =========================================================================
# 4. COMPETITION (teams, scoreboard, current run)
# =========================================================================
# Kept in <DOJO_MAP_DIR>/competition.json so a restart doesn't lose the scoreboard.
# The judges' page keeps the run being scored in the browser and posts it here when
# finalised; /current is only so other screens can show who is playing.
comp_router = APIRouter(prefix='/api/competition', tags=['competition'])
_comp_lock = threading.Lock()
_comp = None


def _dump(model):
    return model.model_dump() if hasattr(model, 'model_dump') else model.dict()   # pydantic 2 / 1


def _comp_file() -> Path:
    return map_dir() / 'competition.json'


def _comp_data():
    global _comp
    if _comp is None:
        try:
            _comp = json.loads(_comp_file().read_text())
        except (OSError, ValueError):
            _comp = {}
        _comp.setdefault('teams', [])
        _comp.setdefault('runs', [])
        _comp.setdefault('current', None)
    return _comp


def _comp_save():
    try:
        map_dir().mkdir(parents=True, exist_ok=True)
        tmp = _comp_file().with_suffix('.tmp')
        tmp.write_text(json.dumps(_comp, indent=1))
        tmp.replace(_comp_file())
    except OSError as e:
        raise HTTPException(500, f'Could not save {_comp_file()}: {e}')


class TeamIn(BaseModel):
    name: str


class CurrentRun(BaseModel):
    team: str = ''
    running: bool = False
    elapsed_ms: int = 0
    section: str = ''


class RunIn(BaseModel):
    team: str
    elapsed_ms: int = Field(ge=0)
    total: float = 0          # marks were removed from the judges' page; kept so old clients still post
    scores: dict[str, float] = {}
    displayed: str = ''
    detected: str = ''
    notes: str = ''


@comp_router.get('')
async def comp_get():
    with _comp_lock:
        return _comp_data()


@comp_router.post('/teams')
async def comp_add_team(t: TeamIn):
    name = _clean_team(t.name)
    if not name:
        return {'success': False, 'message': 'Team name is empty'}
    with _comp_lock:
        d = _comp_data()
        if name.lower() in (x.lower() for x in d['teams']):
            return {'success': False, 'message': f'{name} already exists'}
        d['teams'].append(name)
        _comp_save()
    return {'success': True, 'message': f'Added {name}'}


@comp_router.delete('/teams/{name}')
async def comp_remove_team(name: str):
    with _comp_lock:
        d = _comp_data()
        d['teams'] = [x for x in d['teams'] if x.lower() != name.lower()]
        _comp_save()
    return {'success': True, 'message': f'Removed {name} (its runs are kept)'}


@comp_router.post('/current')
async def comp_current(c: CurrentRun):
    with _comp_lock:
        _comp_data()['current'] = _dump(c) | {'team': _clean_team(c.team), 'time': time.time()}
    return {'success': True}


@comp_router.post('/runs')
async def comp_add_run(r: RunIn):
    run = _dump(r) | {'id': uuid.uuid4().hex[:8], 'team': _clean_team(r.team) or 'unknown',
                            'notes': r.notes[:500], 'time': time.time()}
    with _comp_lock:
        d = _comp_data()
        d['runs'].append(run)
        d['current'] = None
        _comp_save()
    return {'success': True, 'message': f"Saved {run['team']}: {run['total']:g} pts", 'id': run['id']}


@comp_router.delete('/runs/{rid}')
async def comp_remove_run(rid: str):
    with _comp_lock:
        d = _comp_data()
        d['runs'] = [x for x in d['runs'] if x['id'] != rid]
        _comp_save()
    return {'success': True, 'message': 'Run deleted'}


# =========================================================================
# 5. APP
# =========================================================================
@asynccontextmanager
async def lifespan(app: FastAPI):
    global ros_node, dispenser_node
    if not rclpy.ok():
        rclpy.init()
    ros_node = WebBridgeNode()
    dispenser_node = make_dispenser_node()  # None if interfaces missing

    # One executor spins both nodes (screen + dispenser) on a background thread
    executor = MultiThreadedExecutor(num_threads=4)
    executor.add_node(ros_node)
    if dispenser_node is not None:
        executor.add_node(dispenser_node)
    thread = threading.Thread(target=executor.spin, daemon=True)
    thread.start()

    yield

    executor.shutdown()
    ros_node.destroy_node()
    if dispenser_node is not None:
        dispenser_node.destroy_node()
    if rclpy.ok():
        rclpy.shutdown()


app = FastAPI(lifespan=lifespan)
app.include_router(dispenser_router)
app.include_router(maps_router)
app.include_router(comp_router)

pkg_share = None
try:
    pkg_share = get_package_share_directory('web_pi_bridge')
    TEMPLATE_PATH = os.path.join(pkg_share, 'templates', 'index.html')
    STATIC_DIR = os.path.join(pkg_share, 'static')
    if not os.path.exists(TEMPLATE_PATH):
        raise FileNotFoundError
except Exception:
    PKG_ROOT = Path(__file__).parent.resolve()
    TEMPLATE_PATH = os.path.join(PKG_ROOT, 'templates', 'index.html')
    STATIC_DIR = os.path.join(PKG_ROOT, 'static')

# Serve CSS/JS assets (and dojo_map.py for teams) from /static
print(f"STATIC_DIR = {STATIC_DIR}, exists = {os.path.exists(STATIC_DIR)}")
app.mount("/static", StaticFiles(directory=STATIC_DIR, follow_symlink=True), name="static")

# Organisation logos are bundled with this package (web_pi_bridge/logos). The old
# location (screen_images package) is still tried last so existing setups keep working.
LOGOS = ('icon.png', 'title.jpg', 'title_slogan.jpg', 'title_slogan_footer.png')


def _find_logo_dir() -> Path:
    candidates = [Path(__file__).resolve().parent / 'logos']       # source tree / symlink-install
    if pkg_share:
        candidates.insert(0, Path(pkg_share) / 'logos')           # installed share dir
    try:
        candidates.append(Path(get_package_share_directory('screen_images')) / 'logos')
    except Exception:
        pass
    candidates.append(Path(__file__).resolve().parents[2] / 'screen_images' / 'logos')
    return next((c for c in candidates if (c / 'icon.png').exists()), candidates[0])


LOGO_DIR = _find_logo_dir()


@app.get("/logos/{name}", response_class=FileResponse)
async def get_logo(name: str):
    path = LOGO_DIR / name
    if name not in LOGOS or not path.exists():
        raise HTTPException(404, 'Unknown logo')
    return FileResponse(path)


@app.get("/", response_class=FileResponse)
async def get_index():
    if not os.path.exists(TEMPLATE_PATH):
        return FileResponse("index.html")
    return FileResponse(TEMPLATE_PATH)


@app.get("/team", response_class=FileResponse)
async def get_team_page():
    # Same single page as "/"; app.js sees the /team path and shows only the team upload view.
    return await get_index()


SCREEN_STREAM_URL = os.environ.get('DOJO_SCREEN_STREAM', 'http://100.76.206.127:8080/stream')
SCREEN_FPS = float(os.environ.get('DOJO_SCREEN_FPS', '8'))          # max frames/s sent to each viewer
SCREEN_WIDTH = int(os.environ.get('DOJO_SCREEN_WIDTH', '640'))      # frames wider than this are shrunk
SCREEN_QUALITY = int(os.environ.get('DOJO_SCREEN_QUALITY', '60'))   # JPEG quality of the shrunk frames

try:
    from PIL import Image
    import io
except ImportError:      # shrinking is skipped (frame rate is still capped); pip install pillow to enable
    Image = None


def shrink_frame(frame):
    """Return a smaller JPEG of `frame`, or the original if Pillow is missing or anything fails."""
    if Image is None:
        return frame
    try:
        img = Image.open(io.BytesIO(frame))
        if img.width > SCREEN_WIDTH:
            img = img.resize((SCREEN_WIDTH, round(img.height * SCREEN_WIDTH / img.width)))
        out = io.BytesIO()
        img.convert('RGB').save(out, 'JPEG', quality=SCREEN_QUALITY, optimize=True)
        small = out.getvalue()
        return small if len(small) < len(frame) else frame
    except Exception:
        return frame



class ScreenFeed:
    """Reads the Pi's MJPEG feed once and keeps only the newest JPEG frame.

    Every browser gets the latest frame, never a backlog, so a slow viewer
    skips frames instead of falling further behind. The upstream connection
    is opened when the first viewer arrives and closed after the last leaves.
    """

    def __init__(self, url):
        self.url = url
        self.cond = threading.Condition()
        self.frame = None
        self.seq = 0
        self.viewers = 0
        self.thread = None

    def acquire(self):
        with self.cond:
            self.viewers += 1
            if self.thread is None:
                self.thread = threading.Thread(target=self._run, daemon=True)
                self.thread.start()

    def release(self):
        with self.cond:
            self.viewers -= 1

    def _run(self):
        while True:
            with self.cond:
                if self.viewers <= 0:
                    self.thread = None
                    self.frame = None
                    return
            upstream = None
            try:
                upstream = urllib.request.urlopen(self.url, timeout=10)
                buf = b''
                while self.viewers > 0:
                    chunk = upstream.read1(65536)
                    if not chunk:
                        break
                    buf += chunk
                    while True:                      # pull out every complete JPEG
                        a = buf.find(b'\xff\xd8')
                        if a < 0:
                            buf = b''
                            break
                        b = buf.find(b'\xff\xd9', a + 2)
                        if b < 0:
                            buf = buf[a:]
                            break
                        frame, buf = buf[a:b + 2], buf[b + 2:]
                        with self.cond:
                            self.frame = frame
                            self.seq += 1
                            self.cond.notify_all()
            except Exception:
                time.sleep(1)                        # Pi unreachable: retry while viewers remain
            finally:
                if upstream is not None:
                    upstream.close()


screen_feed = ScreenFeed(SCREEN_STREAM_URL)


@app.get("/api/screen_stream")
def screen_stream():
    """Serve the Pi's screen feed over this server (and so over its HTTPS): newest frame only,
    capped frame rate, shrunk to SCREEN_WIDTH when Pillow is installed."""
    min_gap = 1.0 / SCREEN_FPS if SCREEN_FPS > 0 else 0.0

    def relay():
        screen_feed.acquire()
        last = 0
        last_sent = 0.0
        try:
            while True:
                wait = min_gap - (time.monotonic() - last_sent)
                if wait > 0:
                    time.sleep(wait)
                with screen_feed.cond:
                    screen_feed.cond.wait_for(lambda: screen_feed.seq != last, timeout=15)
                    if screen_feed.seq == last:      # nothing from the Pi for 15 s
                        break
                    frame, last = screen_feed.frame, screen_feed.seq
                frame = shrink_frame(frame)
                yield (b'--frame\r\nContent-Type: image/jpeg\r\nContent-Length: %d\r\n\r\n'
                       % len(frame)) + frame + b'\r\n'
                last_sent = time.monotonic()
        finally:
            screen_feed.release()

    return StreamingResponse(relay(), media_type='multipart/x-mixed-replace; boundary=frame')


@app.post("/api/set_display")
async def handle_set_display(req: DisplayRequest):
    success, message = await ros_node.call_set_display(req.state)
    return {"success": success, "message": message}


@app.post("/api/set_display_class")
async def handle_set_display_class(req: DisplayClassRequest):
    success, message = await ros_node.call_set_display_class(req.category)
    return {"success": success, "message": message}


def main():
    import uvicorn
    uvicorn.run("web_pi_bridge.fastapi_node:app", host="0.0.0.0", port=8000, reload=False)


if __name__ == '__main__':
    main()