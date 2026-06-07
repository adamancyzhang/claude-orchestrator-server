import { TaskSchema } from "@co/contracts";

// Test with different completed_by_name values
const tests = [
  { name: "completed_by_name: null", completed_by_name: null },
  { name: "completed_by_name: undefined", completed_by_name: undefined },
  { name: "completed_by_name: string", completed_by_name: "worker-name" },
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
    completed_by_name: test.completed_by_name,
    created_at: new Date().toISOString(),
  };

  const result = TaskSchema.safeParse(payload);
  console.log("Success:", result.success);
  if (!result.success) {
    console.log("Error:", JSON.stringify(result.error, null, 2));
  }
}
