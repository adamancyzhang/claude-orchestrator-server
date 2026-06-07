import { TaskSchema } from "@co/contracts";

// Test with different assigned_to values
const tests = [
  { name: "assigned_to: null", assigned_to: null },
  { name: "assigned_to: undefined", assigned_to: undefined },
  { name: "assigned_to: string", assigned_to: "worker-id" },
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
    assigned_to: test.assigned_to,
    created_at: new Date().toISOString(),
  };

  const result = TaskSchema.safeParse(payload);
  console.log("Success:", result.success);
  if (!result.success) {
    console.log("Error:", JSON.stringify(result.error, null, 2));
  }
}
