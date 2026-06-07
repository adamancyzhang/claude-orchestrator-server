import { TaskSchema } from "@co/contracts";

// Test 1: Task with link: null
const test1 = {
  id: "test-1",
  title: "Test task",
  description: "Test description",
  link: null,
  chain_id: null,
  status: "pending",
  created_at: new Date().toISOString(),
};

console.log("Test 1: Task with link: null");
const result1 = TaskSchema.safeParse(test1);
console.log("Success:", result1.success);
if (!result1.success) {
  console.log("Error:", JSON.stringify(result1.error, null, 2));
}

// Test 2: Task with link: "execute"
const test2 = {
  id: "test-2",
  title: "Test task",
  description: "Test description",
  link: "execute",
  chain_id: "chain-1",
  status: "pending",
  created_at: new Date().toISOString(),
};

console.log("\nTest 2: Task with link: 'execute'");
const result2 = TaskSchema.safeParse(test2);
console.log("Success:", result2.success);
if (!result2.success) {
  console.log("Error:", JSON.stringify(result2.error, null, 2));
}

// Test 3: Task without link field
const test3 = {
  id: "test-3",
  title: "Test task",
  description: "Test description",
  chain_id: null,
  status: "pending",
  created_at: new Date().toISOString(),
};

console.log("\nTest 3: Task without link field");
const result3 = TaskSchema.safeParse(test3);
console.log("Success:", result3.success);
if (!result3.success) {
  console.log("Error:", JSON.stringify(result3.error, null, 2));
}
