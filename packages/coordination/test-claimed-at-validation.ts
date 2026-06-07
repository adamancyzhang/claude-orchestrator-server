import { TaskSchema } from "@co/contracts";

// Test with different claimed_at values
const tests = [
  { name: "claimed_at: null", claimed_at: null },
  { name: "claimed_at: undefined", claimed_at: undefined },
  { name: "claimed_at: ISO string", claimed_at: new Date().toISOString() },
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
    claimed_at: test.claimed_at,
    created_at: new Date().toISOString(),
  };

  const result = TaskSchema.safeParse(payload);
  console.log("Success:", result.success);
  if (!result.success) {
    console.log("Error:", JSON.stringify(result.error, null, 2));
  }
}
