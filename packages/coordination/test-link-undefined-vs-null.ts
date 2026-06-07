import { TaskSchema } from "@co/contracts";

// Test link: undefined vs link: null
const tests = [
  { name: "link: undefined", link: undefined },
  { name: "link: null", link: null },
  { name: "link: 'execute'", link: "execute" },
  { name: "link: 'plan'", link: "plan" },
  { name: "link: 'verify'", link: "verify" },
  { name: "link: 'review'", link: "review" },
  { name: "link: 'accept'", link: "accept" },
  { name: "link: 'explore'", link: "explore" },
  { name: "link: 'invalid'", link: "invalid" },
];

for (const test of tests) {
  console.log(`\nTesting ${test.name}:`);
  const payload = {
    id: "test-id",
    title: "Test task",
    description: "Test description",
    link: test.link,
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
