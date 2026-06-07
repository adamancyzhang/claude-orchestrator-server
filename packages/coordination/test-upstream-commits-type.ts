import { TaskSchema, type UpstreamCommits } from "@co/contracts";

// Test with UpstreamCommits type
const upstreamCommits: UpstreamCommits = {
  plan: "sha1",
  execute: "sha2",
  verify: "sha3",
  review: "sha4",
  accept: "sha5",
};
console.log("UpstreamCommits type:", upstreamCommits);

const payload = {
  id: "test-id",
  title: "Test task",
  description: "test description",
  link: null,
  chain_id: "test-chain-id",
  created_by: "leader-id",
  status: "pending",
  upstream_commits: upstreamCommits,
  created_at: new Date().toISOString(),
};

console.log("\nTesting with UpstreamCommits type:");
const result = TaskSchema.safeParse(payload);
console.log("Success:", result.success);
if (!result.success) {
  console.log("Error:", JSON.stringify(result.error, null, 2));
}
