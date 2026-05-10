import logging
from datetime import datetime, timezone
from typing import Optional
from uuid import uuid4

from .models import Instance, InstanceStatus, InstanceRole
from .zk_client import ZkClient

logger = logging.getLogger(__name__)


class InstanceRegistry:
    def __init__(self, zk: ZkClient):
        self.zk = zk

    def register(self, name: str, role: str = "general",
                 instance_id: Optional[str] = None) -> Instance:
        if instance_id:
            existing = self.zk.get_instance(instance_id)
            if existing:
                existing["name"] = name
                existing["role"] = InstanceRole(role).value if role in [r.value for r in InstanceRole] else InstanceRole.GENERAL.value
                existing["status"] = InstanceStatus.IDLE.value
                existing["connected_since"] = datetime.now(timezone.utc).isoformat()
                self.zk.update_instance(instance_id, existing)
                logger.info(f"Instance re-registered: {name} ({instance_id}) role={existing['role']}")
                return Instance(**existing)

        instance = Instance(
            id=instance_id or uuid4().hex,
            name=name,
            role=InstanceRole(role) if role in [r.value for r in InstanceRole] else InstanceRole.GENERAL,
            status=InstanceStatus.IDLE,
            connected_since=datetime.now(timezone.utc).isoformat(),
        )
        self.zk.register_instance(instance.id, instance.model_dump())
        logger.info(f"Instance registered: {instance.name} ({instance.id}) role={instance.role}")
        return instance

    def heartbeat(self, instance_id: str, current_task: Optional[str] = None):
        data = self.zk.get_instance(instance_id)
        if data is None:
            raise ValueError(f"Instance {instance_id} not found")
        if current_task is not None:
            data["current_task_id"] = current_task
            data["status"] = InstanceStatus.BUSY.value if current_task else InstanceStatus.IDLE.value
        self.zk.update_instance(instance_id, data)

    def get(self, instance_id: str) -> Optional[Instance]:
        data = self.zk.get_instance(instance_id)
        return Instance(**data) if data else None

    def list_all(self) -> list[Instance]:
        instances = self.zk.list_instances()
        return [Instance(**data) for data in instances]
