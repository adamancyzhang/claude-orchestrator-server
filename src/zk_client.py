import json
import logging
import threading
import time
from typing import Optional

from kazoo.client import KazooClient, KazooState
from kazoo.exceptions import NoNodeError, NodeExistsError, ConnectionLoss, SessionExpiredError

logger = logging.getLogger(__name__)

ROOT_PATH = "/claude-orchestrator"
INSTANCES_PATH = f"{ROOT_PATH}/instances"
TASKS_PATH = f"{ROOT_PATH}/tasks"
TASKS_PENDING = f"{TASKS_PATH}/pending"
TASKS_CLAIMED = f"{TASKS_PATH}/claimed"
TASKS_COMPLETED = f"{TASKS_PATH}/completed"
MESSAGES_PATH = f"{ROOT_PATH}/messages"
CONTEXT_PATH = f"{ROOT_PATH}/context"


class ZkClient:
    def __init__(self, hosts: str = "127.0.0.1:2181"):
        self.hosts = hosts
        self.client: Optional[KazooClient] = None
        self._lock = threading.Lock()
        self._connected = False
        self._running = False
        self._reconnecting = False

    # ── Connection lifecycle ──

    def start(self):
        self._running = True
        self._connect()

    def _connect(self):
        with self._lock:
            old = self.client
            if old:
                # Detach listener BEFORE stopping to prevent LOST → reconnect cascade
                try:
                    old.remove_listener(self._state_listener)
                except Exception:
                    pass
                try:
                    old.stop()
                    old.close()
                except Exception:
                    pass
            self.client = KazooClient(hosts=self.hosts, timeout=30)
            self.client.add_listener(self._state_listener)
            self.client.start(timeout=30)
            self._ensure_paths()
            self._connected = True
            logger.info(f"Connected to ZooKeeper at {self.hosts}")

    def _state_listener(self, state: KazooState):
        if state == KazooState.SUSPENDED:
            logger.warning("ZK session suspended — waiting for auto-reconnect")
        elif state == KazooState.LOST:
            logger.warning("ZK session LOST — will attempt reconnection")
            self._connected = False
            if self._running and not self._reconnecting:
                self._reconnecting = True
                t = threading.Thread(target=self._reconnect_loop, daemon=True)
                t.start()
        elif state == KazooState.CONNECTED:
            logger.info("ZK connected")
            self._connected = True

    def _reconnect_loop(self):
        try:
            for attempt in range(10):
                if not self._running:
                    logger.info("ZK reconnection cancelled — server is shutting down")
                    return
                delay = min(2 ** attempt, 30)
                logger.info(f"ZK reconnection attempt {attempt + 1}/10 (waiting {delay}s)...")
                time.sleep(delay)
                if not self._running:
                    return
                try:
                    self._connect()
                    logger.info("ZK reconnection successful")
                    return
                except Exception as e:
                    logger.error(f"ZK reconnection attempt {attempt + 1} failed: {e}")
            logger.critical("ZK reconnection FAILED after 10 attempts — server requires restart")
        finally:
            self._reconnecting = False

    @property
    def connected(self) -> bool:
        return self._connected and self.client is not None and self.client.connected

    def _with_retry(self, func, *args, **kwargs):
        try:
            return func(*args, **kwargs)
        except (ConnectionLoss, SessionExpiredError) as e:
            logger.warning(f"ZK operation failed: {e} — connection lost, retrying once")
            if self._running:
                try:
                    self._connect()
                    return func(*args, **kwargs)
                except Exception as e2:
                    raise ConnectionError(f"ZK operation failed after reconnect: {e2}") from e
            raise ConnectionError(f"ZK connection lost: {e}") from e

    def stop(self):
        self._running = False
        self._connected = False
        if self.client:
            try:
                self.client.remove_listener(self._state_listener)
            except Exception:
                pass
            self.client.stop()
            self.client.close()
            logger.info("ZK client stopped")

    def _ensure_paths(self):
        for path in [ROOT_PATH, INSTANCES_PATH, TASKS_PATH, TASKS_PENDING,
                     TASKS_CLAIMED, TASKS_COMPLETED, MESSAGES_PATH, CONTEXT_PATH]:
            self.client.ensure_path(path)

    # ── Instance operations ──

    def register_instance(self, instance_id: str, data: dict):
        path = f"{INSTANCES_PATH}/{instance_id}"
        self.client.create(path, json.dumps(data).encode(), ephemeral=True, makepath=True)

    def get_instance(self, instance_id: str) -> Optional[dict]:
        path = f"{INSTANCES_PATH}/{instance_id}"
        try:
            raw, _ = self.client.get(path)
            return json.loads(raw)
        except NoNodeError:
            return None

    def update_instance(self, instance_id: str, data: dict):
        path = f"{INSTANCES_PATH}/{instance_id}"
        self.client.set(path, json.dumps(data).encode())

    def list_instances(self) -> list[dict]:
        try:
            children = self.client.get_children(INSTANCES_PATH)
        except NoNodeError:
            return []
        results = []
        for cid in children:
            data = self.get_instance(cid)
            if data:
                results.append(data)
        return results

    def delete_instance(self, instance_id: str):
        path = f"{INSTANCES_PATH}/{instance_id}"
        try:
            self.client.delete(path)
        except NoNodeError:
            pass

    # ── Task operations ──

    def create_pending_task(self, data: dict) -> str:
        path_prefix = f"{TASKS_PENDING}/task-"
        path = self.client.create(path_prefix, json.dumps(data).encode(),
                                  sequence=True, makepath=True)
        return path.split("/")[-1]

    def get_pending_task(self, task_id: str) -> Optional[dict]:
        path = f"{TASKS_PENDING}/{task_id}"
        try:
            raw, _ = self.client.get(path)
            return json.loads(raw)
        except NoNodeError:
            return None

    def list_pending_tasks(self) -> list[tuple[str, dict]]:
        try:
            children = self.client.get_children(TASKS_PENDING)
        except NoNodeError:
            return []
        results = []
        for cid in sorted(children):
            data = self.get_pending_task(cid)
            if data:
                results.append((cid, data))
        return results

    def delete_pending_task(self, task_id: str):
        path = f"{TASKS_PENDING}/{task_id}"
        try:
            self.client.delete(path)
        except NoNodeError:
            pass

    def claim_task(self, instance_id: str, task_id: str, data: bytes = b"") -> bool:
        claimed_path = f"{TASKS_CLAIMED}/{instance_id}-{task_id}"
        try:
            self.client.create(claimed_path, data, ephemeral=True)
            return True
        except NodeExistsError:
            return False

    def get_claimed_task(self, instance_id: str, task_id: str) -> dict:
        path = f"{TASKS_CLAIMED}/{instance_id}-{task_id}"
        try:
            raw, _ = self.client.get(path)
            if raw:
                return json.loads(raw)
        except NoNodeError:
            pass
        return {}

    def list_claimed_tasks(self) -> list[tuple[str, str, dict]]:
        try:
            children = self.client.get_children(TASKS_CLAIMED)
        except NoNodeError:
            return []
        results = []
        for name in sorted(children):
            parts = name.split("-", 1)
            if len(parts) == 2:
                data = self.get_claimed_task(parts[0], parts[1])
                results.append((parts[0], parts[1], data))
        return results

    def delete_claimed_task(self, instance_id: str, task_id: str):
        path = f"{TASKS_CLAIMED}/{instance_id}-{task_id}"
        try:
            self.client.delete(path)
        except NoNodeError:
            pass

    def save_completed_task(self, task_id: str, data: dict):
        path = f"{TASKS_COMPLETED}/{task_id}"
        self.client.create(path, json.dumps(data).encode(), makepath=True)

    def get_completed_task(self, task_id: str) -> Optional[dict]:
        path = f"{TASKS_COMPLETED}/{task_id}"
        try:
            raw, _ = self.client.get(path)
            return json.loads(raw)
        except NoNodeError:
            return None

    def list_completed_tasks(self) -> list[dict]:
        try:
            children = self.client.get_children(TASKS_COMPLETED)
        except NoNodeError:
            return []
        results = []
        for cid in sorted(children):
            data = self.get_completed_task(cid)
            if data:
                results.append(data)
        return results

    # ── Message operations ──

    def create_message(self, instance_id: str, data: dict) -> str:
        path_prefix = f"{MESSAGES_PATH}/{instance_id}/msg-"
        self.client.ensure_path(f"{MESSAGES_PATH}/{instance_id}")
        path = self.client.create(path_prefix, json.dumps(data).encode(),
                                  sequence=True)
        return path.split("/")[-1]

    def get_message(self, instance_id: str, msg_id: str) -> Optional[dict]:
        path = f"{MESSAGES_PATH}/{instance_id}/{msg_id}"
        try:
            raw, _ = self.client.get(path)
            return json.loads(raw)
        except NoNodeError:
            return None

    def update_message(self, instance_id: str, msg_id: str, data: dict):
        path = f"{MESSAGES_PATH}/{instance_id}/{msg_id}"
        self.client.set(path, json.dumps(data).encode())

    def list_messages(self, instance_id: str) -> list[tuple[str, dict]]:
        try:
            children = self.client.get_children(f"{MESSAGES_PATH}/{instance_id}")
        except NoNodeError:
            return []
        results = []
        for cid in sorted(children):
            data = self.get_message(instance_id, cid)
            if data:
                results.append((cid, data))
        return results

    def delete_message(self, instance_id: str, msg_id: str):
        path = f"{MESSAGES_PATH}/{instance_id}/{msg_id}"
        try:
            self.client.delete(path)
        except NoNodeError:
            pass

    # ── Context operations ──

    def set_context(self, key: str, data: dict):
        path = f"{CONTEXT_PATH}/{key}"
        if self.client.exists(path):
            self.client.set(path, json.dumps(data).encode())
        else:
            self.client.create(path, json.dumps(data).encode(), makepath=True)

    def get_context(self, key: str) -> Optional[dict]:
        path = f"{CONTEXT_PATH}/{key}"
        try:
            raw, _ = self.client.get(path)
            return json.loads(raw)
        except NoNodeError:
            return None
