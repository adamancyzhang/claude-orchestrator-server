import { ChainTaskDefSchema } from "@co/contracts";

// Test ChainTaskDefSchema with different values
const tests = [
  {
    name: "ChainTaskDef with description: null",
    task: {
      title: "Test task",
      description: null,
      criteria: "Test criteria",
      priority: 1,
    },
  },
  {
    name: "ChainTaskDef with description: undefined",
    task: {
      title: "Test task",
      criteria: "Test criteria",
      priority: 1,
    },
  },
  {
    name: "ChainTaskDef with description: string",
    task: {
      title: "Test task",
      description: "Test description",
      criteria: "Test criteria",
      priority: 1,
    },
  },
];

for (const test of tests) {
  console.log(`\nTesting ${test.name}:`);
  const result = ChainTaskDefSchema.safeParse(test.task);
  console.log("Success:", result.success);
  if (!result.success) {
    console.log("Error:", JSON.stringify(result.error, null, 2));
  }
}
