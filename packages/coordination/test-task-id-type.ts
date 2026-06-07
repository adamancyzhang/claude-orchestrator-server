import { TaskSchema, asTaskId } from "@co/contracts";

// Test with TaskId type
const taskId = asTaskId("test-task-id");
console.log("TaskId type:", typeof taskId, taskId);

const payload = {
  id: taskId,
  title: "Test task",
  description: "test description",
  link: null,
  chain_id: "test-chain-id",
  created_by: "leader-id",
  status: "pending",
  created_at: new Date().toISOString(),
};

console.log("\nTesting with TaskId type:");
const result = TaskSchema.safeParse(payload);
console.log("Success:", result.success);
if (!result.success) {
  console.log("Error:", JSON.stringify(result.error, null, 2));
}
