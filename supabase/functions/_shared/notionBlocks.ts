// Turning a Notion block into plain text.
//
// Lives here rather than inside notion-poller so it can be tested: the poller
// is a Deno.serve entrypoint and cannot be imported without starting a server.
// Same reason temporal.ts and financialRedaction.ts sit here.

export interface NotionBlock {
  id: string;
  type: string;
  has_children?: boolean;
  [key: string]: unknown;
}

/**
 * Flattens one block's own rich text. Children are the caller's problem.
 *
 * Read generically rather than by enumerating paragraph, heading_1,
 * bulleted_list_item, quote, callout and the rest: nearly every Notion block
 * type stores its text the same way, under block[block.type].rich_text. A type
 * this does not understand contributes nothing instead of throwing, which is
 * the right failure for a format that gains block types faster than any
 * consumer tracks them.
 */
export function blockText(block: NotionBlock | null | undefined): string {
  if (!block || typeof block.type !== "string") return "";
  const body = block[block.type];
  if (!body || typeof body !== "object") return "";

  const rich = (body as { rich_text?: { plain_text?: string }[] }).rich_text;
  if (!Array.isArray(rich)) return "";

  const text = rich.map((r) => r?.plain_text ?? "").join("").trim();
  if (!text) return "";

  // A checkbox carries its state in the block, not the text, and an action
  // item already done reads very differently from one still outstanding -
  // exactly the distinction extraction is trying to make.
  if (block.type === "to_do") {
    const checked = (body as { checked?: boolean }).checked === true;
    return `[${checked ? "x" : " "}] ${text}`;
  }

  return text;
}
