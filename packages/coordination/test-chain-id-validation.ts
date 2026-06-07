import { TaskSchema } from "@co/contracts";

// Test with different chain_id values
const tests = [
  { name: "chain_id: null", chain_id: null },
  { name: "chain_id: string", chain_id: "test-chain-id" },
  { name: "chain_id: undefined", chain_id: undefined },
];

for (const test of tests) {
  console.log(`\nTesting ${test.name}:`);
  const payload = {
    id: "test-id",
    title: "Test task",
    description: "Test description",
    link: null,
    chain_id: test.chain_id,
    status: "pending",
    created_at: new Date().toISOString(),
  };

  const result = TaskSchema.safeParse(payload);
  console.log("Success:", result.success);
  if (!result.success) {
    console.log("Error:", JSON.stringify(result.error, null, 2));
  }
}
