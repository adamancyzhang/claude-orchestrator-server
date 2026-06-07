import { TaskSchema } from "@co/contracts";

// Test with different priority values
const tests = [
  { name: "priority: 0", priority: 0 },
  { name: "priority: 1", priority: 1 },
  { name: "priority: 2", priority: 2 },
  { name: "priority: undefined", priority: undefined },
  { name: "priority: null", priority: null },
  { name: "priority: 3 (invalid)", priority: 3 },
  { name: "priority: -1 (invalid)", priority: -1 },
  { name: "priority: 1.5 (invalid)", priority: 1.5 },
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
    priority: test.priority,
    created_at: new Date().toISOString(),
  };

  const result = TaskSchema.safeParse(payload);
  console.log("Success:", result.success);
  if (!result.success) {
    console.log("Error:", JSON.stringify(result.error, null, 2));
  }
}
