import { TaskSchema } from "@co/contracts";

// Test with different result_path values
const tests = [
  { name: "result_path: null", result_path: null },
  { name: "result_path: undefined", result_path: undefined },
  { name: "result_path: string", result_path: "/path/to/result" },
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
    result_path: test.result_path,
    created_at: new Date().toISOString(),
  };

  const result = TaskSchema.safeParse(payload);
  console.log("Success:", result.success);
  if (!result.success) {
    console.log("Error:", JSON.stringify(result.error, null, 2));
  }
}
