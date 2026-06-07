import { TaskSchema } from "@co/contracts";

// Test with different status values
const tests = [
  { name: "status: 'pending'", status: "pending" },
  { name: "status: 'claimed'", status: "claimed" },
  { name: "status: 'completed'", status: "completed" },
  { name: "status: 'failed'", status: "failed" },
  { name: "status: undefined", status: undefined },
  { name: "status: null", status: null },
  { name: "status: invalid", status: "invalid" },
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
    status: test.status,
    created_at: new Date().toISOString(),
  };

  const result = TaskSchema.safeParse(payload);
  console.log("Success:", result.success);
  if (!result.success) {
    console.log("Error:", JSON.stringify(result.error, null, 2));
  }
}
