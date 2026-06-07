import { TaskSchema } from "@co/contracts";

// Test with different claimed_by values
const tests = [
  { name: "claimed_by: null", claimed_by: null },
  { name: "claimed_by: undefined", claimed_by: undefined },
  { name: "claimed_by: string", claimed_by: "worker-id" },
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
    claimed_by: test.claimed_by,
    created_at: new Date().toISOString(),
  };

  const result = TaskSchema.safeParse(payload);
  console.log("Success:", result.success);
  if (!result.success) {
    console.log("Error:", JSON.stringify(result.error, null, 2));
  }
}
