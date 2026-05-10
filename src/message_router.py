import logging
from datetime import datetime, timezone
from typing import Optional

from .models import Message, MessageType
from .zk_client import ZkClient

logger = logging.getLogger(__name__)


class MessageRouter:
    def __init__(self, zk: ZkClient):
        self.zk = zk

    def send(self, from_instance: str, from_name: str,
             content: str, to_instance: Optional[str] = None,
             broadcast: bool = False) -> list[Message]:
        messages = []
        msg_type = MessageType.BROADCAST if broadcast else MessageType.DIRECT

        if broadcast:
            instances = self.zk.list_instances()
            targets = [i["id"] for i in instances if i["id"] != from_instance]
        elif to_instance:
            targets = [to_instance]
        else:
            raise ValueError("Must specify to_instance or broadcast=True")

        for target_id in targets:
            msg = Message(
                type=msg_type,
                from_instance=from_instance,
                from_name=from_name,
                to_instance=target_id,
                content=content,
                created_at=datetime.now(timezone.utc).isoformat(),
            )
            msg_id = self.zk.create_message(target_id, msg.model_dump())
            msg.id = msg_id
            messages.append(msg)
            logger.info(f"Message sent: {msg_id} {from_name} -> {target_id}")

        return messages

    def poll(self, instance_id: str) -> list[Message]:
        raw = self.zk.list_messages(instance_id)
        messages = []
        for msg_id, data in raw:
            data["id"] = msg_id
            msg = Message(**data)
            if not msg.read:
                msg.read = True
                self.zk.update_message(instance_id, msg_id, msg.model_dump())
            messages.append(msg)
        logger.info(f"Polled messages for {instance_id}: {len(messages)} found")
        return messages

    def request_help(self, from_instance: str, from_name: str,
                     question: str, context: Optional[str] = None) -> list[Message]:
        content = question
        if context:
            content = f"{question}\n\nContext:\n{context}"
        return self.send(
            from_instance=from_instance,
            from_name=from_name,
            content=content,
            broadcast=True,
        )
