import json
import logging
from datetime import datetime, timezone
from typing import Optional

from .models import Task, TaskStatus, TaskPriority
from .zk_client import ZkClient

logger = logging.getLogger(__name__)


class TaskQueue:
    def __init__(self, zk: ZkClient):
        self.zk = zk

    def push(self, title: str, description: str = "",
             priority: int = 1, created_by: str = "",
             assigned_to: Optional[str] = None) -> Task:
        task = Task(
            title=title,
            description=description,
            priority=TaskPriority(priority) if priority in [0, 1, 2] else TaskPriority.MEDIUM,
            status=TaskStatus.PENDING,
            created_by=created_by,
            assigned_to=assigned_to,
        )
        task_id = self.zk.create_pending_task(task.model_dump())
        task.id = task_id
        logger.info(f"Task pushed: {task_id} \"{title}\" by {created_by}")
        return task

    def claim(self, instance_id: str) -> Optional[Task]:
        pending = self.zk.list_pending_tasks()

        def sort_key(item):
            tid, data = item
            assigned = data.get("assigned_to")
            prio = data.get("priority", 1)
            is_assigned_to_me = 0 if assigned == instance_id else 1
            return (is_assigned_to_me, prio, tid)

        for task_id, data in sorted(pending, key=sort_key):
            task_bytes = json.dumps(data).encode()
            if not self.zk.claim_task(instance_id, task_id, task_bytes):
                continue
            self.zk.delete_pending_task(task_id)
            now = datetime.now(timezone.utc).isoformat()
            data["id"] = task_id
            data["status"] = TaskStatus.CLAIMED.value
            data["claimed_at"] = now
            data["claimed_by"] = instance_id
            logger.info(f"Task claimed: {task_id} by {instance_id}")
            return Task(**data)

        return None

    def complete(self, instance_id: str, task_id: str, result: str) -> Task:
        claimed_data = self.zk.get_claimed_task(instance_id, task_id)
        self.zk.delete_claimed_task(instance_id, task_id)
        now = datetime.now(timezone.utc).isoformat()
        data = {
            "id": task_id,
            "title": claimed_data.get("title", ""),
            "description": claimed_data.get("description", ""),
            "priority": claimed_data.get("priority", 1),
            "created_by": claimed_data.get("created_by", ""),
            "assigned_to": claimed_data.get("assigned_to"),
            "completed_by": instance_id,
            "completed_at": now,
            "result": result,
        }
        self.zk.save_completed_task(task_id, data)
        logger.info(f"Task completed: {task_id} by {instance_id}")
        return Task(**data, status=TaskStatus.COMPLETED)

    def list_tasks(self, status: Optional[str] = None) -> list[Task]:
        tasks = []
        if status is None or status == "pending":
            for tid, data in self.zk.list_pending_tasks():
                data["id"] = tid
                data["status"] = TaskStatus.PENDING.value
                tasks.append(Task(**data))
        if status is None or status == "claimed":
            for ins_id, task_id, data in self.zk.list_claimed_tasks():
                data["id"] = task_id
                data["status"] = TaskStatus.CLAIMED.value
                data["claimed_by"] = ins_id
                tasks.append(Task(**data))
        if status is None or status == "completed":
            for data in self.zk.list_completed_tasks():
                data["title"] = data.get("title", "")
                data["status"] = TaskStatus.COMPLETED.value
                tasks.append(Task(**data))
        return tasks
