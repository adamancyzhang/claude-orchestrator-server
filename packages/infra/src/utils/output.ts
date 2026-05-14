export function output(data: unknown, error = false): void {
  const payload = typeof data === "string" ? { message: data } : data;
  console.log(JSON.stringify(payload, null, 2));
  if (error) {
    process.exit(1);
  }
}
