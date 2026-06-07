import { TaskSchema } from "@co/contracts";

// Test with different retry_count values
const tests = [
  { name: "retry_count: 0", retry_count: 0 },
  { name: "retry_count: 1", retry_count: 1 },
  { name: "retry_count: undefined", retry_count: undefined },
  { name: "retry_count: null", retry_count: null },
  { name: "retry_count: -1 (invalid)", retry_count: -1 },
  { name: "retry_count: 1.5 (invalid)", retry_count: 1.5 },
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
    retry_count: test.retry_count,
    created_at: new Date().toISOString(),
  };

  const result = TaskSchema.safeParse(payload);
  console.log("Success:", result.success);
  if (!result.success) {
    console.log("Error:", JSON.stringify(result.error, null, 2));
  }
}
