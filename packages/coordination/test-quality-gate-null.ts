import { TaskSchema } from "@co/contracts";

// Test with quality_gate: null
const payload = {
  id: "test-id",
  title: "Test task",
  description: "test description",
  link: null,
  chain_id: "test-chain-id",
  created_by: "leader-id",
  status: "pending",
  quality_gate: null,
  created_at: new Date().toISOString(),
};

console.log("Testing with quality_gate: null:");
const result = TaskSchema.safeParse(payload);
console.log("Success:", result.success);
if (!result.success) {
  console.log("Error:", JSON.stringify(result.error, null, 2));
}
