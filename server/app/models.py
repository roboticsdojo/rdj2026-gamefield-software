from typing import Any, Optional
from pydantic import BaseModel

class GamefieldCommand(BaseModel):
    action: str
    payload: Optional[dict[str, Any]] = None

class LoginRequest(BaseModel):
    username: str
    password: str