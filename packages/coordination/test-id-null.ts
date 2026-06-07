import { TaskSchema } from "@co/contracts";

// Test with id: null
const payload = {
  id: null,
  title: "Test task",
  description: "test description",
  link: null,
  chain_id: "test-chain-id",
  created_by: "leader-id",
  status: "pending",
  created_at: new Date().toISOString(),
};

console.log("Testing with id: null:");
const result = TaskSchema.safeParse(payload);
console.log("Success:", result.success);
if (!result.success) {
  console.log("Error:", JSON.stringify(result.error, null, 2));
} else {
  console.log("Parsed data:", JSON.stringify(result.data, null, 2));
}
