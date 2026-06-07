import { TaskSchema } from "@co/contracts";

// Test with TaskStatus type
const taskStatus = "pending" as const;
console.log("TaskStatus type:", typeof taskStatus, taskStatus);

const payload = {
  id: "test-id",
  title: "Test task",
  description: "test description",
  link: null,
  chain_id: "test-chain-id",
  created_by: "leader-id",
  status: taskStatus,
  created_at: new Date().toISOString(),
};

console.log("\nTesting with TaskStatus type:");
const result = TaskSchema.safeParse(payload);
console.log("Success:", result.success);
if (!result.success) {
  console.log("Error:", JSON.stringify(result.error, null, 2));
}
