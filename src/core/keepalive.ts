/**
 * Interleave SSE comment pings into a proxied stream so the connection shows
 * activity even while the engine is stalled in queue or long prefill. SSE
 * clients ignore comment lines; without the pings an idle upstream would be
 * killed by socket idle timeouts (ours or any intermediate proxy's).
 */
export function withSseKeepalive(
  src: ReadableStream<Uint8Array>,
  pingMs = 15000,
): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const reader = src.getReader();
  let active = true;
  let timer: ReturnType<typeof setInterval> | null = null;
  const halt = (): void => {
    active = false;
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
  return new ReadableStream<Uint8Array>({
    start(c) {
      timer = setInterval(() => {
        if (!active) return;
        try {
          c.enqueue(enc.encode(": ping\n\n"));
        } catch {
          halt();
        }
      }, pingMs);
      const pump = (): void => {
        reader
          .read()
          .then(({ done, value }) => {
            if (!active) return;
            if (done) {
              halt();
              c.close();
              return;
            }
            if (value !== undefined) {
              try {
                c.enqueue(value);
              } catch {
                halt();
              }
            }
            pump();
          })
          .catch(() => {
            if (!active) return;
            halt();
            c.error(new Error("upstream stream failed"));
          });
      };
      pump();
    },
    cancel(reason) {
      halt();
      reader.cancel(reason).catch(() => {});
    },
  });
}
