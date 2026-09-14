import asyncio
import itertools
import json
import os
from typing import Optional

from fastapi import WebSocket

EXPECTED_TOKEN = os.environ.get("GAMEFIELD_IO_TOKEN", "changeme-dev-token")


class GamefieldIOManager:
    def __init__(self):
        self._socket: Optional[WebSocket] = None
        self._lock = asyncio.Lock()
        self._pending: dict[str, asyncio.Future] = {}
        self._id_counter = itertools.count()

    @property
    def connected(self) -> bool:
        return self._socket is not None

    async def connect(self, websocket: WebSocket, token: str) -> bool:
        if token != EXPECTED_TOKEN:
            await websocket.close(code=4003, reason="Invalid token")
            return False

        await websocket.accept()
        async with self._lock:
            if self._socket is not None:
                try:
                    await self._socket.close()
                except Exception:
                    pass
            self._socket = websocket
        return True

    async def disconnect(self, websocket: WebSocket) -> None:
        async with self._lock:
            if self._socket is websocket:
                self._socket = None
                
#handle incoming messages from the websocket(method that processes acks back from the pi)
        
    async def handle_incoming(self, raw_message: str) -> None:  # WebSockets send text, not Python objects. Whatever the Pi sends back arrives here as a raw JSON string, e.g. '{"request_id": "3", "status": "ok"}'.
           """Called for every message received FROM the IO client (acks)."""
           try:
               data = json.loads(raw_message) # parses that string into a Python dict
           except json.JSONDecodeError:
               return
           
           
           request_id = data.get("request_id")
           future = self._pending.pop(request_id, None)
           if future and not future.done():
               future.set_result(data)
                
               
    async def send_command(self, message: dict, timeout: float = 5.0) -> dict: #message: dict, timeout: float = 5.0 — message is the command to send (e.g. {"target": "barrier", "action": "open"},  in main.py). timeout caps how long we'll wait for an ack before giving up — 5 seconds by default, but callable with a different value.
        if self._socket is None:
            raise ConnectionError("No gamefield IO client connected")

        request_id = str(next(self._id_counter))
        outgoing = {**message, "request_id": request_id}
        future: asyncio.Future = asyncio.get_event_loop().create_future()
        self._pending[request_id] = future

        try:
            await self._socket.send_text(json.dumps(outgoing))
            return await asyncio.wait_for(future, timeout=timeout)
        except asyncio.TimeoutError:
            self._pending.pop(request_id, None)
            raise TimeoutError(
                f"No ack from gamefield IO client for target "
                f"'{message.get('target')}' within {timeout}s"
            )
    #This is the method that ties the whole class together: connect()/disconnect() manage who's attached, handle_incoming() and send_command() manage the request-and-wait-for-reply conversation with whoever that is.    