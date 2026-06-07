import { TaskSchema } from "@co/contracts";

// Test with different completed_at values
const tests = [
  { name: "completed_at: null", completed_at: null },
  { name: "completed_at: undefined", completed_at: undefined },
  { name: "completed_at: ISO string", completed_at: new Date().toISOString() },
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
    completed_at: test.completed_at,
    created_at: new Date().toISOString(),
  };

  const result = TaskSchema.safeParse(payload);
  console.log("Success:", result.success);
  if (!result.success) {
    console.log("Error:", JSON.stringify(result.error, null, 2));
  }
}
