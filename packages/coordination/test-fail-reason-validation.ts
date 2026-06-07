import { TaskSchema } from "@co/contracts";

// Test with different fail_reason values
const tests = [
  { name: "fail_reason: null", fail_reason: null },
  { name: "fail_reason: undefined", fail_reason: undefined },
  { name: "fail_reason: string", fail_reason: "test reason" },
  { name: "fail_reason: empty string", fail_reason: "" },
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
    fail_reason: test.fail_reason,
    created_at: new Date().toISOString(),
  };

  const result = TaskSchema.safeParse(payload);
  console.log("Success:", result.success);
  if (!result.success) {
    console.log("Error:", JSON.stringify(result.error, null, 2));
  }
}
