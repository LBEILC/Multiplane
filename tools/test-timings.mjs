// Node's reporter stream retains source locations and nested test timings.
export default async function* timings(source) {
  for await (const event of source) {
    yield JSON.stringify(event, (_key, value) => value instanceof Error
      ? { ...value, message: value.message, stack: value.stack, cause: value.cause }
      : value) + '\n';
  }
}
