import { TaskSchema } from "@co/contracts";

// Test with different criteria values
const tests = [
  { name: "criteria: null", criteria: null },
  { name: "criteria: undefined", criteria: undefined },
  { name: "criteria: string", criteria: "test criteria" },
  { name: "criteria: empty string", criteria: "" },
];

for (const test of tests) {
  console.log(`\nTesting ${test.name}:`);
  const payload = {
    id: "test-id",
    title: "Test task",
    description: "test description",
    criteria: test.criteria,
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
