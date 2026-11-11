from typing import Any, Optional
from pydantic import BaseModel, Field


class GamefieldCommand(BaseModel):
    action: str
    payload: Optional[dict[str, Any]] = None

class LoginRequest(BaseModel):
    username: str
    password: str

class GameInitializationRequest(BaseModel):
    duration_seconds: int = Field(default=300, gt=0, strict=True)
    clear_test_data: bool = False
