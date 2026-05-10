import logging
from datetime import datetime, timezone
from typing import Optional

from .models import ContextEntry
from .zk_client import ZkClient

logger = logging.getLogger(__name__)


class ContextStore:
    def __init__(self, zk: ZkClient):
        self.zk = zk

    def set(self, key: str, value: str, updated_by: str = "") -> ContextEntry:
        entry = ContextEntry(
            key=key,
            value=value,
            updated_by=updated_by,
            updated_at=datetime.now(timezone.utc).isoformat(),
        )
        self.zk.set_context(key, entry.model_dump())
        logger.info(f"Context set: {key}={value} by {updated_by}")
        return entry

    def get(self, key: str) -> Optional[str]:
        data = self.zk.get_context(key)
        if data is None:
            return None
        return data.get("value")
