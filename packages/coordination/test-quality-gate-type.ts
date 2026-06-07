import { TaskSchema, type QualityGate } from "@co/contracts";

// Test with QualityGate type
const qualityGate: QualityGate = {
  type: "self_eval",
  criteria: "test criteria",
};
console.log("QualityGate type:", qualityGate);

const payload = {
  id: "test-id",
  title: "Test task",
  description: "test description",
  link: null,
  chain_id: "test-chain-id",
  created_by: "leader-id",
  status: "pending",
  quality_gate: qualityGate,
  created_at: new Date().toISOString(),
};

console.log("\nTesting with QualityGate type:");
const result = TaskSchema.safeParse(payload);
console.log("Success:", result.success);
if (!result.success) {
  console.log("Error:", JSON.stringify(result.error, null, 2));
}
