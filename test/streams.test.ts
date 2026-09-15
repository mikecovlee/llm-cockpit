import { expect, test } from "bun:test";
import { chatStream } from "../src/chat/openai.ts";
import { withSseKeepalive } from "../src/core/keepalive.ts";
import { findHistogram, parsePrometheus } from "../src/core/prom.ts";

test("findHistogram merges label-split series", () => {
  const p = parsePrometheus(
    [
      "# TYPE x_seconds histogram",
      'x_seconds_bucket{r="0",le="1"} 2',
      'x_seconds_bucket{r="0",le="+Inf"} 5',
      'x_seconds_sum{r="0"} 6',
      'x_seconds_count{r="0"} 5',
      'x_seconds_bucket{r="1",le="1"} 3',
      'x_seconds_bucket{r="1",le="+Inf"} 7',
      'x_seconds_sum{r="1"} 10',
      'x_seconds_count{r="1"} 7',
    ].join("\n"),
  );
  const h = findHistogram(p, "x_seconds");
  expect(h).not.toBeNull();
  if (h === null) return;
  expect(h.count).toBe(12);
  expect(h.sum).toBe(16);
  expect(h.buckets.find((b) => b.upper === 1)?.count).toBe(5);
});

test("keepalive pings during silence, passes chunks through, closes on done", async () => {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const src = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
    },
  });
  const dec = new TextDecoder();
  const reader = withSseKeepalive(src, 40).getReader();

  const first = await reader.read();
  expect(first.done).toBe(false);
  expect(dec.decode(first.value)).toContain(": ping");

  const p2 = reader.read();
  ctrl.enqueue(new TextEncoder().encode("data: chunk\n\n"));
  expect(dec.decode((await p2).value)).toBe("data: chunk\n\n");

  const p3 = reader.read();
  ctrl.close();
  expect((await p3).done).toBe(true);
});

test("keepalive cancel propagates to upstream reader", async () => {
  let cancelled = false;
  const src = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  const reader = withSseKeepalive(src, 30).getReader();
  await reader.read();
  await reader.cancel();
  expect(cancelled).toBe(true);
});

test("chatStream aborts at its deadline even with no caller signal", async () => {
  const srv = Bun.serve({
    port: 0,
    // biome-ignore lint/complexity/useArrowFunction: never resolving keeps the client hanging
    fetch: (): Promise<Response> => new Promise(() => {}),
  });
  try {
    await expect(
      chatStream(
        { baseUrl: `http://127.0.0.1:${srv.port}/v1`, apiKey: null },
        { messages: [] },
        undefined,
        150,
      ),
    ).rejects.toThrow();
  } finally {
    srv.stop();
  }
});
