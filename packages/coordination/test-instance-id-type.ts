import { TaskSchema, asInstanceId } from "@co/contracts";

// Test with InstanceId type
const instanceId = asInstanceId("test-instance-id");
console.log("InstanceId type:", typeof instanceId, instanceId);

const payload = {
  id: "test-id",
  title: "Test task",
  description: "test description",
  link: null,
  chain_id: "test-chain-id",
  created_by: instanceId,
  status: "pending",
  created_at: new Date().toISOString(),
};

console.log("\nTesting with InstanceId type:");
const result = TaskSchema.safeParse(payload);
console.log("Success:", result.success);
if (!result.success) {
  console.log("Error:", JSON.stringify(result.error, null, 2));
}
