import asyncio
import threading
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, HTTPException, Response, WebSocket, WebSocketDisconnect, Depends, Cookie
from app.auth import verify_password, create_session
from app.db import get_db
from app.models import GamefieldCommand, LoginRequest
from .connection_manager import GamefieldIOManager

import rclpy
from rclpy.node import Node
from screen_interfaces.srv import SetDisplayClass

class FastAPIInterfaceNode(Node):
    """ROS 2 client node for the Pi's screen_manager_node services."""

    def __init__(self):
        super().__init__('fastapi_ros2_interface_bridge')
        self.class_cli = self.create_client(
            SetDisplayClass, '/screen_manager_node/set_display_class'
        )

    def set_display_class(self, category: str, timeout: float = 5.0):
        if not self.class_cli.service_is_ready():
            return {"success": False, "message": "screen_manager_node service not available"}

        req = SetDisplayClass.Request()
        req.category = category

        future = self.class_cli.call_async(req)
        done = threading.Event()
        future.add_done_callback(lambda _f: done.set())

        if not done.wait(timeout=timeout):
            return {"success": False, "message": f"no response within {timeout}s"}
        if future.exception() is not None:
            return {"success": False, "message": f"service call failed: {future.exception()}"}

        result = future.result()
        return {"success": result.success, "message": result.message}


ros_node = None
ros_thread = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global ros_node, ros_thread
    rclpy.init()
    ros_node = FastAPIInterfaceNode()
    ros_thread = threading.Thread(target=lambda: rclpy.spin(ros_node), daemon=True)
    ros_thread.start()
    yield
    ros_node.destroy_node()
    rclpy.shutdown()
    ros_thread.join()


app = FastAPI(title="Gamefield Server", lifespan=lifespan)
manager = GamefieldIOManager()


@app.websocket("/ws/gamefield-io")
async def gamefield_io_socket(websocket: WebSocket, token: str = ""):
    connected = await manager.connect(websocket, token)
    if not connected:
        return
    try:
        while True:
            raw_message = await websocket.receive_text()
            await manager.handle_incoming(raw_message)
    except WebSocketDisconnect:
        await manager.disconnect(websocket)


async def _dispatch(target: str, command: GamefieldCommand) -> dict:
    if not manager.connected:
        raise HTTPException(status_code=503, detail="No gamefield IO client connected")
    message = {"target": target, "action": command.action, "payload": command.payload}
    try:
        return await manager.send_command(message)
    except TimeoutError as exc:
        raise HTTPException(status_code=504, detail=str(exc))


@app.post("/gamefield/loading")
async def control_loading(command: GamefieldCommand):
    return await _dispatch("loading", command)


@app.post("/gamefield/barrier")
async def control_barrier(command: GamefieldCommand):
    return await _dispatch("barrier", command)


@app.post("/gamefield/screen")
async def control_screen(command: GamefieldCommand):
    if ros_node is None:
        raise HTTPException(status_code=500, detail="ROS 2 client node not initialized")

    category = command.payload.get("category") if isinstance(command.payload, dict) else None
    if not category:
        raise HTTPException(status_code=400, detail="payload must include 'category'")

    loop = asyncio.get_running_loop()
    result = await loop.run_in_executor(None, ros_node.set_display_class, category)

    if not result["success"]:
        raise HTTPException(status_code=502, detail=result["message"])

    return {"status": "ok", "category": category, "detail": result["message"]}

@app.post("/gamefield/audience_screen")
async def control_audience_screen(command: GamefieldCommand):
    return await _dispatch("audience_screen", command)


@app.get("/gamefield/status")
async def gamefield_status():
    return {"io_client_connected": manager.connected}



from passlib.exc import UnknownHashError

@app.post("/auth/login")
def login(credentials: LoginRequest, response: Response):
    conn = get_db()

    try:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT judge_id, password_hash
            FROM judges
            WHERE username = %s
            """,
            (credentials.username,),
        )
        judge = cur.fetchone()

        if not judge:
            raise HTTPException(
                status_code=401,
                detail="Invalid username or password",
            )

        try:
            password_valid = verify_password(
                credentials.password,
                judge["password_hash"],
            )
        except (UnknownHashError, ValueError, TypeError):
            password_valid = False

        if not password_valid:
            raise HTTPException(
                status_code=401,
                detail="Invalid username or password",
            )

        # Pass the connection required by create_session().
        session_id, expires_at = create_session(
            judge["judge_id"],
            conn,
        )

        response.set_cookie(
            key="session_id",
            value=session_id,
            httponly=True,
            samesite="lax",
            expires=expires_at,
            secure=True,  # Set True when serving over HTTPS.
        )

        return {"logged_in": True}

    finally:
        conn.close()



@app.post("/auth/logout")
async def logout(response: Response, session_id: Optional[str] = Cookie(default=None)):
    if session_id:
        conn = get_db()
        cur = conn.cursor()
        cur.execute("DELETE FROM sessions WHERE session_id = %s", (session_id,))
        conn.commit()
        conn.close()
    response.delete_cookie(key="session_id")
    return {"logged_out": True}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)