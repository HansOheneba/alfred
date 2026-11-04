export class ChatReadTimeout extends Error {
  constructor() { super("The conversation read took too long."); }
}

/** Bounds read-only work, including transports that never settle on abort.
 * Cancellation prevents a late result from publishing; it is never a POST retry. */
export function chatReadDeadline<T>(work: Promise<T>, milliseconds: number, signal?: AbortSignal, timedOut?: () => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (done: () => void) => {
      if (finished) return;
      finished = true; clearTimeout(timer); signal?.removeEventListener("abort", aborted); done();
    };
    const aborted = () => finish(() => reject(new Error("The conversation read was cancelled.")));
    const timer = setTimeout(() => finish(() => { timedOut?.(); reject(new ChatReadTimeout()); }), milliseconds);
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) aborted();
    work.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
  });
}
