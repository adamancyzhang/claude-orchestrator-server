import { TaskSchema } from "@co/contracts";

// Test with different title values
const tests = [
  { name: "title: string", title: "Test task" },
  { name: "title: undefined", title: undefined },
  { name: "title: null", title: null },
  { name: "title: empty string", title: "" },
];

for (const test of tests) {
  console.log(`\nTesting ${test.name}:`);
  const payload = {
    id: "test-id",
    title: test.title,
    description: "Test description",
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
