/** Keep signal handlers installed until owned analysis resources are closed. */
export const withProcessCancellation = async <Value>(
  suppliedSignal: AbortSignal | undefined,
  operation: (signal: AbortSignal) => Promise<Value>,
): Promise<Value> => {
  if (suppliedSignal !== undefined) return operation(suppliedSignal);
  const controller = new AbortController();
  const cancel = (): void => controller.abort();
  // Package runners can forward a terminal interrupt after REA already received
  // it directly. Keep both guards installed until provider cleanup has settled.
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  try {
    return await operation(controller.signal);
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
};
