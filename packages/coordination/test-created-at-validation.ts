import { TaskSchema } from "@co/contracts";

// Test with different created_at values
const tests = [
  { name: "created_at: ISO string", created_at: new Date().toISOString() },
  { name: "created_at: undefined", created_at: undefined },
  { name: "created_at: null", created_at: null },
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
    created_at: test.created_at,
  };

  const result = TaskSchema.safeParse(payload);
  console.log("Success:", result.success);
  if (!result.success) {
    console.log("Error:", JSON.stringify(result.error, null, 2));
  }
}
