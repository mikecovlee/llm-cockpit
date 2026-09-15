import { expect, test } from "bun:test";
import { en, type LangKey, t, zh } from "../web/i18n.ts";

const enKeys = Object.keys(en) as LangKey[];

test("en and zh key sets are identical", () => {
  const zhKeys = (Object.keys(zh) as LangKey[]).sort();
  expect(zhKeys).toEqual([...enKeys].sort());
  expect(enKeys.length).toBeGreaterThan(0);
});

test("no empty or whitespace-only values in either language", () => {
  const empty = enKeys.filter((k) => en[k].trim() === "" || zh[k].trim() === "");
  expect(empty).toEqual([]);
});

test("t() interpolates chat.tooBig in both languages", () => {
  expect(t("en", "chat.tooBig", { name: "a.png" })).toBe("a.png exceeds 8MB — skipped.");
  expect(t("zh", "chat.tooBig", { name: "a.png" })).toBe("「a.png」超过 8MB — 已跳过。");
});

test("t() plain lookup without vars", () => {
  expect(t("en", "chat.send")).toBe("send");
  expect(t("zh", "chat.send")).toBe("发送");
});
