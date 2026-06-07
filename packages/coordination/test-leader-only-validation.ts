import { TaskSchema } from "@co/contracts";

// Test with different leader_only values
const tests = [
  { name: "leader_only: false", leader_only: false },
  { name: "leader_only: true", leader_only: true },
  { name: "leader_only: undefined", leader_only: undefined },
  { name: "leader_only: null", leader_only: null },
  { name: "leader_only: 0", leader_only: 0 },
  { name: "leader_only: 1", leader_only: 1 },
  { name: "leader_only: 'true'", leader_only: "true" },
];

for (const test of tests) {
  console.log(`\nTesting ${test.name}:`);
  const payload = {
    id: "test-id",
    title: "Test task",
    description: "Test description",
    link: null,
    chain_id: null,
    created_by: "leader-id",
    status: "pending",
    leader_only: test.leader_only,
    created_at: new Date().toISOString(),
  };

  const result = TaskSchema.safeParse(payload);
  console.log("Success:", result.success);
  if (!result.success) {
    console.log("Error:", JSON.stringify(result.error, null, 2));
  }
}
