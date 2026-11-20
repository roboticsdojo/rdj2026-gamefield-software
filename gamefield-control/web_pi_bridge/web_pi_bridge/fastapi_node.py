"""Robotics Dojo web bridge: everything the laptop serves, in one module.

Sections
  1. Screen bridge      ROS node + /api/set_display*  (Pi screen_manager_node)
  2. Dispenser bridge   ROS node + /api/dispenser/*   (loading station)
  2b. Barrier bridge    ROS node + /api/barrier/*     (gamefield_barrier: servo gate + ultrasonic)
  3. Helpers            where competition.json is stored, team-name cleanup
  4. Competition        /api/competition/*  (teams, finished runs = scoreboard, current run)
  5. App                lifespan, routers, static files, logos, page, main()

Nothing here needs the internet: the page, its scripts and fonts are all served from this
module, and the only devices it talks to are the Pi (screen_manager, screen stream) and the
loading station, found by their .local hostnames on the closed competition network.

--------------------------------------------------------------------------
Dispenser ROS interface (all under /gamefield/loading_station):
  action   dispense  loading_station_interfaces/action/Dispense
  service  enable    std_srvs/srv/SetBool
  service  home      std_srvs/srv/Trigger
  service  reset     std_srvs/srv/Trigger
  topic    status    loading_station_interfaces/msg/StationStatus (latched)

Barrier ROS interface (all under /gamefield/barrier, published by the gamefield_barrier node
that talks to the Arduino; standard messages only, no extra interface package):
  service  open     std_srvs/srv/Trigger    blocks until the gate is OPEN (or fails)
  service  close    std_srvs/srv/Trigger    blocks until the gate is CLOSED (or fails)
  service  reset    std_srvs/srv/Trigger    clears a FAULT and re-initialises to CLOSED
  topic    status   std_msgs/msg/String     JSON {connected, state, angle, pot, distance_cm, sequence, fault}, ~2 Hz
  topic    event    std_msgs/msg/String     one line per event: "MANUAL:OPEN", "SEQ:START (from CLOSED)", ...

Environment
  DOJO_MAP_DIR  where competition.json (teams + scoreboard) is stored (default ~/dojo_maps)
"""
import asyncio
import json
import os
import re
import threading
import time
import urllib.request
from collections import deque
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, FastAPI, HTTPException
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
from std_msgs.msg import String                                # barrier status / events are String topics
from std_srvs.srv import SetBool, Trigger                      # loading station + barrier use std_srvs

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
# 2b. BARRIER BRIDGE  (gamefield_barrier node <-> Arduino with the servo gate + HC-SR04)
# =========================================================================
BARRIER_BASE = '/gamefield/barrier'
BARRIER_STALE_S = 3.0        # the barrier node publishes status at ~2 Hz; older than this = offline
BARRIER_EVENTS_KEPT = 60


class BarrierBridgeNode(Node):
    def __init__(self):
        super().__init__('barrier_web_bridge')
        self._lock = threading.Lock()
        self._status = None            # dict parsed from the last /status JSON
        self._status_time = 0.0
        self._events = deque(maxlen=BARRIER_EVENTS_KEPT)   # {'id', 'time', 'text'}
        self._event_id = 0

        self.open_cli = self.create_client(Trigger, f'{BARRIER_BASE}/open')
        self.close_cli = self.create_client(Trigger, f'{BARRIER_BASE}/close')
        self.reset_cli = self.create_client(Trigger, f'{BARRIER_BASE}/reset')
        self.create_subscription(String, f'{BARRIER_BASE}/status', self._on_status, 10)
        self.create_subscription(String, f'{BARRIER_BASE}/event', self._on_event, 10)
        self.get_logger().info('BarrierBridgeNode initialized')

    # ------------------------------------------------------------ topics
    def _on_status(self, msg):
        try:
            data = json.loads(msg.data)
        except ValueError:
            return
        if not isinstance(data, dict):
            return
        with self._lock:
            self._status = data
            self._status_time = time.monotonic()

    def _on_event(self, msg):
        with self._lock:
            self._event_id += 1
            self._events.append({'id': self._event_id, 'time': time.time(), 'text': msg.data})

    def snapshot(self):
        """What the page polls. `online` = the barrier node is publishing; status['connected'] = the
        Arduino is plugged in and answering. Events carry an increasing id so the page logs each once."""
        with self._lock:
            online = (self._status is not None and
                      time.monotonic() - self._status_time < BARRIER_STALE_S)
            return {
                'online': online,
                'status': dict(self._status) if self._status else None,
                'events': list(self._events),
            }

    # ---------------------------------------------------------- services
    async def _call(self, client, timeout_sec=10.0):
        # the barrier node holds the reply until the gate has arrived (up to its 6 s move timeout)
        if not client.service_is_ready():
            return False, 'Barrier service unavailable (is gamefield_barrier running?)'
        future = client.call_async(Trigger.Request())
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

    async def call_open(self):
        return await self._call(self.open_cli)

    async def call_close(self):
        return await self._call(self.close_cli)

    async def call_reset(self):
        return await self._call(self.reset_cli)


barrier_router = APIRouter(prefix='/api/barrier', tags=['barrier'])
barrier_node = None  # set by lifespan


@barrier_router.get('/status')
async def barrier_status():
    if barrier_node is None:
        return {'online': False, 'status': None, 'events': [], 'error': 'barrier bridge not started'}
    return barrier_node.snapshot()


@barrier_router.post('/open')
async def barrier_open():
    ok, msg = await barrier_node.call_open()
    return {'success': ok, 'message': msg}


@barrier_router.post('/close')
async def barrier_close():
    ok, msg = await barrier_node.call_close()
    return {'success': ok, 'message': msg}


@barrier_router.post('/reset')
async def barrier_reset():
    ok, msg = await barrier_node.call_reset()
    return {'success': ok, 'message': msg}


# =========================================================================
# 3. HELPERS
# =========================================================================
def map_dir() -> Path:
    """Folder that holds competition.json (the name is kept so DOJO_MAP_DIR keeps working)."""
    return Path(os.environ.get('DOJO_MAP_DIR') or Path.home() / 'dojo_maps')


def _clean_team(name: str) -> str:
    return re.sub(r'[^A-Za-z0-9 _.-]', '', (name or '').strip())[:32]


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


# challenges that get their own fastest time on the scoreboard (older runs have none = autonomy)
COMP_CATEGORIES = {'slam': 'SLAM', 'nav2': 'Nav2', 'autonomy': 'Autonomy'}


class CurrentRun(BaseModel):
    team: str = ''
    category: str = ''
    running: bool = False
    elapsed_ms: int = 0
    section: str = ''


class RunIn(BaseModel):
    team: str
    category: str = 'autonomy'    # slam | nav2 | autonomy
    elapsed_ms: int = Field(ge=0)
    total: float = 0          # marks were removed from the judges' page; kept so old clients still post
    scores: dict[str, float] = {}
    displayed: str = ''
    correct: Optional[bool] = None    # judged by hand: was the item correctly identified
    detected: str = ''        # old runs only (the robot detection feed was removed)
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
    cat = (r.category or '').strip().lower()
    if cat not in COMP_CATEGORIES:
        cat = 'autonomy'
    run = _dump(r) | {'id': uuid.uuid4().hex[:8], 'team': _clean_team(r.team) or 'unknown', 'category': cat,
                            'notes': r.notes[:500], 'time': time.time()}
    with _comp_lock:
        d = _comp_data()
        d['runs'].append(run)
        d['current'] = None
        _comp_save()
    secs = r.elapsed_ms / 1000
    return {'success': True,
            'message': f"Saved {run['team']} ({COMP_CATEGORIES[cat]}): {int(secs // 60):02d}:{secs % 60:04.1f}",
            'id': run['id']}


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
    global ros_node, dispenser_node, barrier_node
    if not rclpy.ok():
        rclpy.init()
    ros_node = WebBridgeNode()
    dispenser_node = make_dispenser_node()  # None if interfaces missing
    barrier_node = BarrierBridgeNode()

    # One executor spins all the nodes (screen, dispenser, barrier) on a background thread
    executor = MultiThreadedExecutor(num_threads=4)
    executor.add_node(ros_node)
    if dispenser_node is not None:
        executor.add_node(dispenser_node)
    executor.add_node(barrier_node)
    thread = threading.Thread(target=executor.spin, daemon=True)
    thread.start()

    yield

    executor.shutdown()
    ros_node.destroy_node()
    if dispenser_node is not None:
        dispenser_node.destroy_node()
    barrier_node.destroy_node()
    if rclpy.ok():
        rclpy.shutdown()


app = FastAPI(lifespan=lifespan)
app.include_router(dispenser_router)
app.include_router(barrier_router)
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


PI_HOST = os.environ.get('DOJO_PI_HOST', 'screen.local')          # the Pi is found by hostname, never by a stored IP
SCREEN_STREAM_URL = os.environ.get('DOJO_SCREEN_STREAM', f'http://{PI_HOST}:8080/stream')   # dojo_net_up sets this from a live lookup
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
        self._small_lock = threading.Lock()   # shrink each frame once, not once per viewer
        self._small = None
        self._small_seq = -1

    def small_for(self, frame, seq):
        with self._small_lock:
            if self._small_seq != seq:
                self._small, self._small_seq = shrink_frame(frame), seq
            return self._small

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
                if frame is None:                    # first viewer after an idle spell: nothing captured yet
                    continue
                frame = screen_feed.small_for(frame, last)
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