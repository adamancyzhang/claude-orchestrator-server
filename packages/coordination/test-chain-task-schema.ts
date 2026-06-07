import { ChainTaskSchema } from "@co/contracts";

// Test ChainTaskSchema with different values
const tests = [
  {
    name: "ChainTask with description: null",
    task: {
      task_id: "0",
      title: "Test task",
      description: null,
      system_prompt: "Test prompt",
    },
  },
  {
    name: "ChainTask with description: undefined",
    task: {
      task_id: "0",
      title: "Test task",
      system_prompt: "Test prompt",
    },
  },
  {
    name: "ChainTask with description: string",
    task: {
      task_id: "0",
      title: "Test task",
      description: "Test description",
      system_prompt: "Test prompt",
    },
  },
];

for (const test of tests) {
  console.log(`\nTesting ${test.name}:`);
  const result = ChainTaskSchema.safeParse(test.task);
  console.log("Success:", result.success);
  if (!result.success) {
    console.log("Error:", JSON.stringify(result.error, null, 2));
  }
}
