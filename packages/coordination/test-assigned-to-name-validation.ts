import { TaskSchema } from "@co/contracts";

// Test with different assigned_to_name values
const tests = [
  { name: "assigned_to_name: null", assigned_to_name: null },
  { name: "assigned_to_name: undefined", assigned_to_name: undefined },
  { name: "assigned_to_name: string", assigned_to_name: "worker-name" },
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
    assigned_to_name: test.assigned_to_name,
    status: "pending",
    created_at: new Date().toISOString(),
  };

  const result = TaskSchema.safeParse(payload);
  console.log("Success:", result.success);
  if (!result.success) {
    console.log("Error:", JSON.stringify(result.error, null, 2));
  }
}
