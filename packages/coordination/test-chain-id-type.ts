import { TaskSchema, asChainId } from "@co/contracts";

// Test with ChainId type
const chainId = asChainId("test-chain-id");
console.log("ChainId type:", typeof chainId, chainId);

const payload = {
  id: "test-id",
  title: "Test task",
  description: "test description",
  link: null,
  chain_id: chainId,
  created_by: "leader-id",
  status: "pending",
  created_at: new Date().toISOString(),
};

console.log("\nTesting with ChainId type:");
const result = TaskSchema.safeParse(payload);
console.log("Success:", result.success);
if (!result.success) {
  console.log("Error:", JSON.stringify(result.error, null, 2));
}
