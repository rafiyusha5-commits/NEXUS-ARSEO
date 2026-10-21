import "server-only";

// Request-time snapshot for lease displays. Kept in the data-loading layer;
// client components receive this value and advance it with a monotonic clock.
export async function loadProcessingClock(): Promise<number> {
  return Date.now();
}
