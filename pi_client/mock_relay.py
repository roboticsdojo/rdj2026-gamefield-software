#!/usr/bin/env python3
import asyncio
import json
import websockets

CONNECTED = set()

SAMPLE_ITEMS = {
    "1": {
        "name": "Watermelon rind",
        "waste_type": "organic",
        "image_url": "https://wikimedia.org"
    },
    "2": {
        "name": "Plastic bottles",
        "waste_type": "plastic",
        "image_url": "https://wikimedia.org"
    },
}

async def handler(websocket):
    CONNECTED.add(websocket)
    print(f"[relay] display connected ({len(CONNECTED)} total)")
    try:
        async for _ in websocket:
            pass  # display.html doesn't send anything back
    finally:
        CONNECTED.discard(websocket)
        print(f"[relay] display disconnected ({len(CONNECTED)} total)")

async def broadcast(message: dict):
    if not CONNECTED:
        print("[relay] no display connected yet")
        return
    payload = json.dumps(message)
    await asyncio.gather(*(ws.send(payload) for ws in CONNECTED))

async def command_loop():
    print("\nCommands: show 1 | show 2 | clear | quit\n")
    loop = asyncio.get_running_loop()
    while True:
        cmd = await loop.run_in_executor(None, input, "> ")
        cmd = cmd.strip().lower()
        if cmd.startswith("show"):
            parts = cmd.split(" ", 1)
            if len(parts) < 2:
                print("Please specify an item id (e.g., show 1)")
                continue
            item_id = parts[1].strip()
            item = SAMPLE_ITEMS.get(item_id)
            if item:
                await broadcast({"action": "show_item", "item": item})
            else:
                print(f"unknown item id: {item_id} (try 1 or 2)")
        elif cmd == "clear":
            await broadcast({"action": "clear"})
        elif cmd == "quit":
            break
        else:
            print("unknown command")

async def main():
    async with websockets.serve(handler, "localhost", 8765):
        print("[relay] listening on ws://localhost:8765")
        await command_loop()

if __name__ == "__main__":
    asyncio.run(main())

