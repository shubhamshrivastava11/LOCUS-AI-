import { assertEquals } from "https://deno.land/std/assert/mod.ts";
import { blockText, type NotionBlock } from "./notionBlocks.ts";

function block(type: string, body: unknown, extra: Partial<NotionBlock> = {}): NotionBlock {
  return { id: "b1", type, [type]: body, ...extra } as NotionBlock;
}

function rich(...parts: string[]) {
  return { rich_text: parts.map((p) => ({ plain_text: p })) };
}

Deno.test("reads a paragraph's text", () => {
  assertEquals(blockText(block("paragraph", rich("We are going with Postgres."))),
    "We are going with Postgres.");
});

Deno.test("joins rich text runs without separators", () => {
  // Notion splits a sentence at every formatting change, so naive joining with
  // spaces would insert them mid-word.
  assertEquals(blockText(block("paragraph", rich("Use ", "Postgres", " for now."))),
    "Use Postgres for now.");
});

Deno.test("handles any block type that follows the rich_text convention", () => {
  for (const type of ["heading_1", "heading_2", "bulleted_list_item", "quote", "callout", "toggle"]) {
    assertEquals(blockText(block(type, rich("shared text"))), "shared text", type);
  }
});

Deno.test("an unchecked to_do keeps its state", () => {
  assertEquals(blockText(block("to_do", { ...rich("Ship the migration"), checked: false })),
    "[ ] Ship the migration");
});

Deno.test("a checked to_do reads differently from an unchecked one", () => {
  // The whole point: "done" and "outstanding" are the distinction extraction
  // is trying to draw, and it lives in the block, not the text.
  assertEquals(blockText(block("to_do", { ...rich("Ship the migration"), checked: true })),
    "[x] Ship the migration");
});

Deno.test("a to_do with no checked field is treated as outstanding", () => {
  assertEquals(blockText(block("to_do", rich("Ship it"))), "[ ] Ship it");
});

Deno.test("an unknown block type contributes nothing rather than throwing", () => {
  // Notion adds block types faster than any consumer tracks them.
  assertEquals(blockText(block("some_future_block", { foo: "bar" })), "");
});

Deno.test("a block with no rich_text contributes nothing", () => {
  assertEquals(blockText(block("divider", {})), "");
  assertEquals(blockText(block("image", { file: { url: "https://x" } })), "");
});

Deno.test("whitespace-only text is dropped, not emitted as a blank line", () => {
  assertEquals(blockText(block("paragraph", rich("   ", "\n"))), "");
});

Deno.test("surrounding whitespace is trimmed", () => {
  assertEquals(blockText(block("paragraph", rich("  spaced out  "))), "spaced out");
});

Deno.test("missing or malformed blocks are survivable", () => {
  assertEquals(blockText(null), "");
  assertEquals(blockText(undefined), "");
  assertEquals(blockText({ id: "x" } as unknown as NotionBlock), "");
  assertEquals(blockText(block("paragraph", null)), "");
  assertEquals(blockText(block("paragraph", { rich_text: "not an array" })), "");
});

Deno.test("a rich_text run missing plain_text does not become 'undefined'", () => {
  const b = { id: "b", type: "paragraph", paragraph: { rich_text: [{}, { plain_text: "real" }] } };
  assertEquals(blockText(b as unknown as NotionBlock), "real");
});
