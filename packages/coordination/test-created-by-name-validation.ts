import { TaskSchema } from "@co/contracts";

// Test with different created_by_name values
const tests = [
  { name: "created_by_name: null", created_by_name: null },
  { name: "created_by_name: undefined", created_by_name: undefined },
  { name: "created_by_name: string", created_by_name: "leader-name" },
  { name: "created_by_name: empty string", created_by_name: "" },
];

for (const test of tests) {
  console.log(`\nTesting ${test.name}:`);
  const payload = {
    id: "test-id",
    title: "Test task",
    description: "test description",
    link: null,
    chain_id: null,
    created_by: "leader-id",
    created_by_name: test.created_by_name,
    status: "pending",
    created_at: new Date().toISOString(),
  };

  const result = TaskSchema.safeParse(payload);
  console.log("Success:", result.success);
  if (!result.success) {
    console.log("Error:", JSON.stringify(result.error, null, 2));
  }
}
