import { TaskSchema, ValidationError } from "@co/contracts";

// Simulate the payload from chain-router.ts
const payload = {
  title: "Test task",
  description: "Test description",
  criteria: "",
  priority: 1,
  link: null,
  chain_id: "test-chain-id",
  created_by: "leader-id",
  created_by_name: "leader",
};

console.log("Testing payload from chain-router.ts:");
console.log("Payload:", JSON.stringify(payload, null, 2));

const result = TaskSchema.safeParse({
  ...payload,
  id: "test-id",
  status: "pending",
  created_at: new Date().toISOString(),
});

console.log("\nValidation result:");
console.log("Success:", result.success);
if (!result.success) {
  console.log("Error:", JSON.stringify(result.error, null, 2));
} else {
  console.log("Parsed data:", JSON.stringify(result.data, null, 2));
}
