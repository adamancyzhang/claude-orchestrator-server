import { TaskSchema } from "@co/contracts";

// Test with different duration_seconds values
const tests = [
  { name: "duration_seconds: null", duration_seconds: null },
  { name: "duration_seconds: undefined", duration_seconds: undefined },
  { name: "duration_seconds: number", duration_seconds: 4.2 },
  { name: "duration_seconds: 0", duration_seconds: 0 },
  { name: "duration_seconds: -1 (invalid)", duration_seconds: -1 },
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
    duration_seconds: test.duration_seconds,
    created_at: new Date().toISOString(),
  };

  const result = TaskSchema.safeParse(payload);
  console.log("Success:", result.success);
  if (!result.success) {
    console.log("Error:", JSON.stringify(result.error, null, 2));
  }
}
