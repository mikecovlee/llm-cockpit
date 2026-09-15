import { expect, test } from "bun:test";
import { parseNvidiaSmiCsv } from "../src/core/gpu.ts";

test("parses single/multi-GPU rows", () => {
  const rows = parseNvidiaSmiCsv(
    "0, NVIDIA RTX PRO 4500 Blackwell, 100, 31146, 32623, 65, 199.99, 200.00\n1, NVIDIA H100, 42, 1024, 81920, 55, 300.5, [N/A]\n",
  );
  expect(rows.length).toBe(2);
  expect(rows[0]!.utilPct).toBe(100);
  expect(rows[0]!.name).toBe("NVIDIA RTX PRO 4500 Blackwell");
  expect(rows[1]!.powerLimitW).toBeNull();
  expect(rows[1]!.memTotalMb).toBe(81920);
});

test("skips garbage lines; unsupported cells become null", () => {
  const rows = parseNvidiaSmiCsv("\ngarbage\n0, X, [Not Supported], 1, 2, 30, 4, 5\n");
  expect(rows.length).toBe(1);
  expect(rows[0]!.utilPct).toBeNull();
});
