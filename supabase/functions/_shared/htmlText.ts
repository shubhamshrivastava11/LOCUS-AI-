// supabase/functions/_shared/htmlText.ts
//
// Was a private copy inside gmail-manual-sync/index.ts, used only when
// extracting the plain-text body to feed ai-worker. api/index.ts's
// extractEventText() - which reconstructs the "CONVERSATION" thread shown
// in Memory Explorer - reads the same stored envelope.raw_content.body but
// never ran it through this cleanup, so raw HTML captured before this fix
// existed (or any other row that ends up with markup in `body`) rendered
// verbatim in the UI instead of clean text. Shared here so both places stay
// in sync instead of drifting into two different HTML handling paths again.

// Marks a heading's own line so the frontend can render it distinctly (bold,
// larger, its own visual rhythm) instead of just another paragraph - chosen
// specifically because real prose never produces it, so stripping it back
// out on the frontend can't ever eat real content by accident.
export const HEADING_MARKER = "§§";

// Real transactional emails (GitHub's 2FA notice, Anthropic's billing
// alerts) are usually built from a table/MJML layout where every single
// sentence - sometimes every clause - sits in its own <p>/<div>, purely for
// cross-email-client compatibility, not because the sender meant each one
// as its own paragraph. Treating every block tag as a hard paragraph break
// reproduced that fragmentation: dozens of disconnected one-line blocks
// with a visible gap between every one of them, instead of the few
// sentences of actual prose they add up to.
//
// Three private sentinel tokens carry each tag's *intent* through the
// pipeline instead of committing to an actual newline count immediately,
// which regex-adjacent replacements can't reliably reason about (two
// back-to-back </p></div> each adding a literal "\n" produces the same
// double-newline a real blank-line gap would, with nothing left to tell
// them apart). Resolved in one pass at the end: any run touching a HARD
// break becomes a real paragraph gap; a run of only SOFT breaks reflows
// into a single space, regardless of how many adjacent tags produced it.
// Printable bracket sequences on purpose, not control characters - actual
// control chars made git treat this file as binary and stop showing
// readable diffs for it. No real email/Slack/Notion content plausibly
// contains these.
const SOFT = "⟦S⟧"; // maybe-merge boundary: </p>, </div>, </tr>, <br>, or a literal newline already in the source
const HARD = "⟦H⟧"; // must-stay-separate boundary: a heading's own start/end
const BULLET = "⟦B⟧"; // a list item - always its own line, never reflowed

export function htmlToPlainText(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, SOFT)
    .replace(/<h[1-6][^>]*>/gi, `${HARD}${HEADING_MARKER}`)
    .replace(/<\/h[1-6]>/gi, HARD)
    .replace(/<li[^>]*>/gi, `${BULLET}• `)
    .replace(/<\/(p|div|tr)>/gi, SOFT)
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    // A literal newline already present in the raw HTML source (most real
    // email markup has one) is just formatting noise, exactly as mergeable
    // as a tag-derived soft break.
    .replace(/\n/g, SOFT)
    .replace(/[ \t]+/g, " ")
    .replace(new RegExp(`(?:${SOFT}|\\s)*${HARD}(?:${SOFT}|${HARD}|\\s)*`, "g"), "\n\n")
    .replace(new RegExp(BULLET, "g"), "\n")
    .replace(new RegExp(`(?:${SOFT})+`, "g"), " ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    // Collapses a stray space left ahead of a bullet by the SOFT->" " step
    // above down to the single newline a list actually needs.
    .replace(/\n{2,}(?=• )/g, "\n")
    // Keeps a heading marker on the same line as its own text even when the
    // source had whitespace between the opening tag and the text - the
    // frontend only looks for the marker at the start of a line, so a
    // marker stranded alone would render as an empty heading with the real
    // text left as a plain paragraph after it.
    .replace(new RegExp(`(${HEADING_MARKER})\\n+`, "g"), "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Cheap, conservative heuristic - real prose essentially never contains a
// doctype/html/head tag or more than a couple of angle-bracket tags, so
// false positives (treating real text as HTML) are effectively impossible;
// the failure mode to guard against is a false negative (missing real HTML),
// which is why the tag-count check has a low threshold.
export function looksLikeHtml(text: string): boolean {
  if (/<!doctype html|<html[\s>]|<head[\s>]|<body[\s>]/i.test(text)) return true;
  const tagMatches = text.match(/<\/?[a-z][a-z0-9]*(\s[^<>]*)?>/gi);
  return (tagMatches?.length ?? 0) >= 3;
}

// Gmail body bytes are UTF-8, but atob() returns a "binary string" - one
// character per raw byte - so a multi-byte UTF-8 sequence (a curly quote, a
// non-breaking space) reads back as 2-3 separate Latin-1 characters instead
// of the one real character it was (a curly-quoted "LOCUS AI." became
// mojibake, confirmed live in a stored Anthropic billing email).
// gmail-manual-sync's own decode now does this correctly at the source, but
// rows already stored before that fix keep the mojibake permanently, since
// only the already-broken text was ever saved. Safe to attempt
// unconditionally: reinterpreting already-correct text as raw UTF-8 bytes
// either reproduces it exactly (plain ASCII) or fails strict validation and
// falls through unchanged (a genuine, already-decoded Unicode character
// essentially never happens to also be a valid UTF-8 byte sequence on its
// own when reinterpreted).
function repairMojibake(text: string): string {
  // \t\n\r explicitly allowed alongside the printable Latin-1 range -
  // without them, this guard rejected on sight any text with more than one
  // line (real newlines sit below U+0020, outside " "-"ÿ"), which is most
  // stored bodies. Confirmed live: a real multi-line mojibake email was
  // never even attempted because of this.
  if (/[^\t\n\r -ÿ]/.test(text)) return text;
  try {
    const bytes = Uint8Array.from(text, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return text;
  }
}

// Strips CSS that survives even when looksLikeHtml() finds no angle-bracket
// tags to trigger on - e.g. a legacy row whose stored body ended up being
// (or containing) the inside of a <style> block with the tags themselves
// already gone, leaving bare rule blocks and declarations. Confirmed live:
// one such row rendered as a lone "96" (a fragment of
// "<o:PixelsPerInch>96</o:PixelsPerInch>") with no HTML tags left to strip.
//
// Only collapses spaces/tabs directly, never bare newlines - an earlier
// version used \s{2,} here, which also matched newlines and flattened every
// real paragraph break htmlToPlainText had just inserted into one run-on
// wall of text.
//
// Runs on plain, non-HTML bodies too (this function fires unconditionally,
// not just after htmlToPlainText), and those can carry Windows line endings
// with a stray space on otherwise-blank lines - "\r\n \r\n \r\n" - which
// \n{3,} alone never matches (there's no run of 3 literal \n in a row, each
// pair has a CR and a space between them). Confirmed live: a real email
// with exactly this pattern kept a dozen-plus blank lines' worth of gap.
// Trimming whitespace off both sides of every newline first turns that into
// real "\n\n\n", which the collapse below can actually see.
function stripCssRemnants(text: string): string {
  return text
    .replace(/[.#@]?[\w-]+\s*\{[^{}]*\}/g, " ") // rule blocks: .foo { ... }
    .replace(/[a-zA-Z-]+\s*:\s*[^;{}\n]+;/g, " ") // bare declarations: color: red;
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t\r]*\n[ \t\r]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// A markup/CSS fragment can leave a short-lived remnant that isn't itself a
// full rule block or declaration - just a bare token like "96" (from
// "<o:PixelsPerInch>96</o:PixelsPerInch>") sitting right before the real
// message starts. Narrow on purpose: only strips 1-3 digits at the very
// start of the text, immediately followed by a capitalized word (optionally
// through a bullet marker first, when the real message happens to open with
// a bulleted line) - real sentences that legitimately start with a number
// ("3 tests failing...") are lowercase after the digit and won't match.
function stripLeadingArtifactToken(text: string): string {
  return text.replace(/^\d{1,3}\s+(?=(?:• )?[A-Z])/, "");
}

// A body counts as real prose only if it has several actual word-like
// tokens - catches style-property soup ("family Arial sans-serif") that a
// raw letter count would wrongly accept as "meaningful" text.
function isReadableProse(text: string): boolean {
  const words = text.split(/\s+/).filter((w) => /^[A-Za-z][A-Za-z'.,!?-]*$/.test(w) && w.length >= 2);
  return words.length >= 4;
}

// Defensive cleanup for any stored body that might still carry raw HTML/CSS
// or mojibake (legacy rows ingested before the source-side fixes, or any
// future gap in them) - so already-clean bodies pass through untouched, but
// nothing readable surviving falls back to a plain placeholder instead of
// rendering a near-empty wall of whitespace or a stray markup fragment.
export function cleanDisplayText(text: string): string {
  const repaired = repairMojibake(text);
  const htmlStripped = looksLikeHtml(repaired) ? htmlToPlainText(repaired) : repaired;
  const cleaned = stripLeadingArtifactToken(stripCssRemnants(htmlStripped));
  return isReadableProse(cleaned) ? cleaned : "(no readable message content captured)";
}
