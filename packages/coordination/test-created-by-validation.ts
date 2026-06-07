import { TaskSchema } from "@co/contracts";

// Test with different created_by values
const tests = [
  { name: "created_by: null", created_by: null },
  { name: "created_by: string", created_by: "leader-id" },
  { name: "created_by: undefined", created_by: undefined },
];

for (const test of tests) {
  console.log(`\nTesting ${test.name}:`);
  const payload = {
    id: "test-id",
    title: "Test task",
    description: "Test description",
    link: null,
    chain_id: null,
    created_by: test.created_by,
    status: "pending",
    created_at: new Date().toISOString(),
  };

  const result = TaskSchema.safeParse(payload);
  console.log("Success:", result.success);
  if (!result.success) {
    console.log("Error:", JSON.stringify(result.error, null, 2));
  }
}
