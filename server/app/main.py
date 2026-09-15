from typing import Optional  # FIXED: Missing import added
from fastapi import FastAPI, HTTPException, Response, WebSocket, WebSocketDisconnect, Depends, Cookie  # FIXED: Cookie added
from app.auth import verify_password, create_session 
from app.db import get_db 
from app.models import GamefieldCommand, LoginRequest 
from .connection_manager import GamefieldIOManager

app = FastAPI(title="Gamefield Server")
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
    return await _dispatch("screen", command)

@app.post("/gamefield/audience_screen")
async def control_audience_screen(command: GamefieldCommand):
    return await _dispatch("audience_screen", command)

@app.get("/gamefield/status")
async def gamefield_status():
    return {"io_client_connected": manager.connected}  

@app.post("/auth/login")
async def login(
    credentials: LoginRequest, 
    response: Response,
    conn = Depends(get_db)  
):
    cur = conn.cursor()
    cur.execute(
        "SELECT judge_id, password_hash FROM judges WHERE username = %s", 
        (credentials.username,)
    )
    judge = cur.fetchone()

    if not judge or not verify_password(credentials.password, judge["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid username or password")

    session_id, expires_at = create_session(judge["judge_id"], conn)
    
    response.set_cookie(
        key="session_id", 
        value=session_id,  
        httponly=True,
        secure=True,       
        samesite="lax",    
        expires=expires_at
    )
    return {"logged_in": True}

@app.post("/auth/logout")
async def logout(
    response: Response,
    session_id: Optional[str] = Cookie(default=None),
    conn = Depends(get_db)
):
    if session_id:
        cur = conn.cursor()
        cur.execute("DELETE FROM sessions WHERE session_id = %s", (session_id,))
        conn.commit()

    response.delete_cookie(
        key="session_id",
        httponly=True,
        secure=True,       
        samesite="lax"
    )
    
    return {"logged_out": True}
