from datetime import datetime, timezone
from enum import Enum
from typing import Optional
from uuid import uuid4

from pydantic import BaseModel, Field


class InstanceStatus(str, Enum):
    IDLE = "idle"
    BUSY = "busy"
    BLOCKED = "blocked"


class InstanceRole(str, Enum):
    ARCHITECT = "architect"
    DEVELOPER = "developer"
    TESTER = "tester"
    GENERAL = "general"


class TaskStatus(str, Enum):
    PENDING = "pending"
    CLAIMED = "claimed"
    COMPLETED = "completed"


class TaskPriority(int, Enum):
    HIGH = 0
    MEDIUM = 1
    LOW = 2


class MessageType(str, Enum):
    DIRECT = "direct"
    BROADCAST = "broadcast"
    HELP = "help"


class Instance(BaseModel):
    id: str = Field(default_factory=lambda: uuid4().hex)
    name: str
    role: InstanceRole = InstanceRole.GENERAL
    status: InstanceStatus = InstanceStatus.IDLE
    current_task_id: Optional[str] = None
    connected_since: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


class Task(BaseModel):
    id: str = ""
    title: str
    description: str = ""
    priority: TaskPriority = TaskPriority.MEDIUM
    status: TaskStatus = TaskStatus.PENDING
    created_by: str = ""
    assigned_to: Optional[str] = None
    created_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    claimed_at: Optional[str] = None
    completed_at: Optional[str] = None
    claimed_by: Optional[str] = None
    result: Optional[str] = None


class Message(BaseModel):
    id: str = ""
    type: MessageType = MessageType.DIRECT
    from_instance: str = ""
    from_name: str = ""
    to_instance: Optional[str] = None
    content: str
    created_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    read: bool = False


class MessageInput(BaseModel):
    content: str
    to_instance: Optional[str] = None
    broadcast: bool = False


class ContextEntry(BaseModel):
    key: str
    value: str
    updated_by: str = ""
    updated_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
