import { TaskSchema } from "@co/contracts";

// Test with different upstream_commits values
const tests = [
  { name: "upstream_commits: undefined", upstream_commits: undefined },
  { name: "upstream_commits: null", upstream_commits: null },
  { name: "upstream_commits: object", upstream_commits: { plan: null, execute: null, verify: null, review: null, accept: null } },
  { name: "upstream_commits: object with values", upstream_commits: { plan: "sha1", execute: "sha2", verify: "sha3", review: "sha4", accept: "sha5" } },
];

for (const test of tests) {
  console.log(`\nTesting ${test.name}:`);
  const payload = {
    id: "test-id",
    title: "Test task",
    description: "test description",
    link: null,
    chain_id: null,
    created_by: "leader-id",
    status: "pending",
    upstream_commits: test.upstream_commits,
    created_at: new Date().toISOString(),
  };

  const result = TaskSchema.safeParse(payload);
  console.log("Success:", result.success);
  if (!result.success) {
    console.log("Error:", JSON.stringify(result.error, null, 2));
  }
}
