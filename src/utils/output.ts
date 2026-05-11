export function output(data: unknown, error = false): void {
  if (typeof data === "string") {
    data = { message: data };
  }
  console.log(JSON.stringify(data, null, 2));
  if (error) {
    process.exit(1);
  }
}
