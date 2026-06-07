import { TaskSchema } from "@co/contracts";

// Test with different result values
const tests = [
  { name: "result: null", result: null },
  { name: "result: undefined", result: undefined },
  { name: "result: string", result: "test result" },
  { name: "result: empty string", result: "" },
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
    result: test.result,
    created_at: new Date().toISOString(),
  };

  const result = TaskSchema.safeParse(payload);
  console.log("Success:", result.success);
  if (!result.success) {
    console.log("Error:", JSON.stringify(result.error, null, 2));
  }
}
