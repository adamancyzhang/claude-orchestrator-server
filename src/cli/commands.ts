import { ZkClient } from "../zk/client.js";
import { InstanceRegistry } from "../modules/registry.js";
import { TaskQueue } from "../modules/task-queue.js";
import { MessageRouter } from "../modules/message-router.js";
import { loadInstanceId, resolveInstanceId } from "../config.js";
import { output } from "../utils/output.js";
async function withZk(
  hosts: string,
  fn: (clients: {
    zk: ZkClient;
    registry: InstanceRegistry;
    taskQueue: TaskQueue;
    messageRouter: MessageRouter;
  }) => Promise<void>
): Promise<void> {
  const zk = new ZkClient(hosts);
  await zk.connect();
  const registry = new InstanceRegistry(zk);
  const taskQueue = new TaskQueue(zk);
  const messageRouter = new MessageRouter(zk);
  try {
    return await fn({ zk, registry, taskQueue, messageRouter });
  } finally {
    await zk.disconnect();
  }
}

export async function cmdPushTask(
  zkHosts: string,
  cliInstanceId: string | undefined,
  title: string,
  description: string,
  priority: number,
  assignee?: string,
  link?: string,
  chainId?: string,
  dependsOn?: string[],
  blockedBy?: string[],
): Promise<void> {
  await withZk(zkHosts, async ({ taskQueue }) => {
    const instanceId = cliInstanceId ?? "";
    const task = await taskQueue.push(title, description, priority, instanceId, assignee, undefined, undefined, link ?? null, chainId ?? null, dependsOn ?? [], blockedBy ?? []);
    output(task);
  });
}

export async function cmdClaimTask(
  zkHosts: string,
  cliInstanceId: string | undefined
): Promise<void> {
  await withZk(zkHosts, async ({ taskQueue }) => {
    const instanceId = resolveInstanceId(cliInstanceId);
    const task = await taskQueue.claim(instanceId);
    if (!task) {
      output({ status: "no_tasks", message: "No pending tasks available." });
    } else {
      output(task);
    }
  });
}

export async function cmdCompleteTask(
  zkHosts: string,
  cliInstanceId: string | undefined,
  taskId: string,
  result: string
): Promise<void> {
  await withZk(zkHosts, async ({ taskQueue }) => {
    const instanceId = resolveInstanceId(cliInstanceId);
    const task = await taskQueue.complete(instanceId, taskId, result);
    output(task);
  });
}

export async function cmdPollTask(
  zkHosts: string,
  statusFilter?: string
): Promise<void> {
  await withZk(zkHosts, async ({ taskQueue }) => {
    const tasks = await taskQueue.listTasks(statusFilter);
    output(tasks);
  });
}

export async function cmdSendMessage(
  zkHosts: string,
  cliInstanceId: string | undefined,
  content: string,
): Promise<void> {
  await withZk(zkHosts, async ({ registry, messageRouter }) => {
    const instanceId = cliInstanceId || loadInstanceId() || "";
    let fromName: string;
    if (instanceId) {
      const inst = await registry.get(instanceId);
      fromName = inst?.name ?? instanceId.slice(0, 8);
    } else {
      fromName = "CLI";
    }

    const instances = await registry.listAll();
    const leader = instances.find((i) => i.role === "leader");
    if (!leader) {
      throw new Error("No leader instance found");
    }
    const leaderId = leader.id as string;

    const messages = await messageRouter.send(
      instanceId,
      fromName,
      content,
      leaderId,
      false,
      undefined,
      false,
    );
    const targets = messages.map((m) => m.to_instance);
    output({ sent_to: targets, message_count: targets.length });
  });
}

export async function cmdPollMessage(
  zkHosts: string,
  cliInstanceId: string | undefined
): Promise<void> {
  await withZk(zkHosts, async ({ messageRouter }) => {
    const instanceId = resolveInstanceId(cliInstanceId);
    const messages = await messageRouter.poll(instanceId);
    output(messages);
  });
}

export async function cmdDeleteMessage(
  zkHosts: string,
  cliInstanceId: string | undefined,
  messageId: string
): Promise<void> {
  await withZk(zkHosts, async ({ messageRouter }) => {
    const instanceId = resolveInstanceId(cliInstanceId);
    await messageRouter.dismissMessage(instanceId, messageId);
    output({ status: "deleted", message_id: messageId });
  });
}

export async function cmdUnregister(
  zkHosts: string,
  cliInstanceId: string | undefined
): Promise<void> {
  const instanceId = resolveInstanceId(cliInstanceId);

  await withZk(zkHosts, async ({ registry }) => {
    await registry.unregister(instanceId);
    output({ status: "unregistered", instance_id: instanceId });
  });
}

export async function cmdTaskBlock(
  zkHosts: string,
  cliInstanceId: string | undefined,
  taskId: string,
  reason: string,
): Promise<void> {
  await withZk(zkHosts, async ({ taskQueue }) => {
    const instanceId = resolveInstanceId(cliInstanceId);
    const task = await taskQueue.block(instanceId, taskId, reason);
    output(task);
  });
}

export async function cmdTaskFail(
  zkHosts: string,
  cliInstanceId: string | undefined,
  taskId: string,
  reason: string,
): Promise<void> {
  await withZk(zkHosts, async ({ taskQueue }) => {
    const instanceId = resolveInstanceId(cliInstanceId);
    const task = await taskQueue.fail(instanceId, taskId, reason);
    output(task);
  });
}

export async function cmdTaskRetry(
  zkHosts: string,
  _cliInstanceId: string | undefined,
  taskId: string,
): Promise<void> {
  await withZk(zkHosts, async ({ taskQueue }) => {
    const task = await taskQueue.retry(taskId);
    output(task);
  });
}
