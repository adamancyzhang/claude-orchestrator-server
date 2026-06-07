import { TaskSchema } from "@co/contracts";

// Test with TaskPriority type
const taskPriority = 1 as const;
console.log("TaskPriority type:", typeof taskPriority, taskPriority);

const payload = {
  id: "test-id",
  title: "Test task",
  description: "test description",
  link: null,
  chain_id: "test-chain-id",
  created_by: "leader-id",
  status: "pending",
  priority: taskPriority,
  created_at: new Date().toISOString(),
};

console.log("\nTesting with TaskPriority type:");
const result = TaskSchema.safeParse(payload);
console.log("Success:", result.success);
if (!result.success) {
  console.log("Error:", JSON.stringify(result.error, null, 2));
}
