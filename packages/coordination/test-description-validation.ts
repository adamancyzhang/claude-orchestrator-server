import { TaskSchema } from "@co/contracts";

// Test with different description values
const tests = [
  { name: "description: null", description: null },
  { name: "description: undefined", description: undefined },
  { name: "description: string", description: "test description" },
  { name: "description: empty string", description: "" },
];

for (const test of tests) {
  console.log(`\nTesting ${test.name}:`);
  const payload = {
    id: "test-id",
    title: "Test task",
    description: test.description,
    link: null,
    chain_id: null,
    created_by: "leader-id",
    status: "pending",
    created_at: new Date().toISOString(),
  };

  const result = TaskSchema.safeParse(payload);
  console.log("Success:", result.success);
  if (!result.success) {
    console.log("Error:", JSON.stringify(result.error, null, 2));
  }
}
