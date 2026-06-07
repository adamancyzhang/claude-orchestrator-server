import { TaskSchema, type CreateTaskInput } from "@co/contracts";

// Test with CreateTaskInput
const input: CreateTaskInput = {
  title: "Test task",
  description: "Test description",
  criteria: "",
  priority: 1,
  link: null,
  chain_id: "test-chain-id",
  created_by: "leader-id",
  created_by_name: "leader",
};

console.log("Testing CreateTaskInput:");
console.log("Input:", JSON.stringify(input, null, 2));

// Simulate what task-queue.push does
const payload = {
  title: input.title,
  description: input.description ?? "",
  criteria: input.criteria ?? "",
  priority: input.priority ?? 1,
  status: "pending" as const,
  link: input.link ?? null,
  chain_id: input.chain_id ?? null,
  result_path: input.result_path ?? null,
  retry_count: input.retry_count ?? 0,
  fail_reason: null,
  created_by: input.created_by ?? null,
  created_by_name: input.created_by_name ?? "",
  assigned_to: input.assigned_to ?? null,
  assigned_to_name: input.assigned_to_name ?? null,
  claimed_by: null,
  completed_by_name: null,
  created_at: new Date().toISOString(),
  claimed_at: null,
  completed_at: null,
  duration_seconds: null,
  leader_only: input.leader_only ?? false,
  result: null,
};

console.log("\nPayload constructed by task-queue.push:");
console.log("Payload:", JSON.stringify(payload, null, 2));

const result = TaskSchema.safeParse({
  ...payload,
  id: "test-id",
});

console.log("\nValidation result:");
console.log("Success:", result.success);
if (!result.success) {
  console.log("Error:", JSON.stringify(result.error, null, 2));
} else {
  console.log("Parsed data:", JSON.stringify(result.data, null, 2));
}
