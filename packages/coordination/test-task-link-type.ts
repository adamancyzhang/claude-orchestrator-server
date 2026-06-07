import { TaskSchema } from "@co/contracts";

// Test with TaskLink type
const taskLink = "execute" as const;
console.log("TaskLink type:", typeof taskLink, taskLink);

const payload = {
  id: "test-id",
  title: "Test task",
  description: "test description",
  link: taskLink,
  chain_id: "test-chain-id",
  created_by: "leader-id",
  status: "pending",
  created_at: new Date().toISOString(),
};

console.log("\nTesting with TaskLink type:");
const result = TaskSchema.safeParse(payload);
console.log("Success:", result.success);
if (!result.success) {
  console.log("Error:", JSON.stringify(result.error, null, 2));
}
