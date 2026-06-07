import { TaskSchema } from "@co/contracts";

// Simulate reading a task from ZooKeeper with link: null
const rawFromZooKeeper = {
  id: "test-id",
  title: "Test task",
  description: "test description",
  link: null,
  chain_id: null,
  created_by: "leader-id",
  created_by_name: "leader",
  status: "pending",
  created_at: new Date().toISOString(),
  // Other fields that might be null in ZooKeeper
  result_path: null,
  retry_count: 0,
  fail_reason: null,
  assigned_to: null,
  assigned_to_name: null,
  claimed_by: null,
  completed_by_name: null,
  claimed_at: null,
  completed_at: null,
  duration_seconds: null,
  leader_only: false,
  result: null,
};

console.log("Testing task from ZooKeeper with link: null:");
console.log("Raw data:", JSON.stringify(rawFromZooKeeper, null, 2));

const result = TaskSchema.safeParse(rawFromZooKeeper);
console.log("\nValidation result:");
console.log("Success:", result.success);
if (!result.success) {
  console.log("Error:", JSON.stringify(result.error, null, 2));
} else {
  console.log("Parsed data:", JSON.stringify(result.data, null, 2));
}
