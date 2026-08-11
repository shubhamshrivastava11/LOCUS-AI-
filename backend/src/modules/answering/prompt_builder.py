"""
Answer Prompt Builder — deterministic system + user prompt construction for
single-turn grounded question answering over retrieved decisions, plus the
forced-tool-call schema Claude must respond through.

Structured tool output (submit_answer) replaces the old free-text +
regex-citation-extraction approach: Claude self-reports sufficient_evidence
as an explicit boolean and citations as an explicit int list, rather than
us regex-scanning its prose for "Decision N" mentions. This closes a real
bug found during evaluation: the old regex (`[Dd]ecision\\s+(\\d+)`) could
match a decision number mentioned inside Claude's own refusal explanation
("unlike Decision 3, which is unrelated...") and misreport it as a
citation. With structured output, Claude can discuss a decision in
`reasoning` without it ever entering `citations` unless it deliberately
puts it there.

REFUSAL_TEXT is unchanged, byte-for-byte, from the original free-text
prompt - modules.answering.service enforces it verbatim (and forces
citations to []) whenever sufficient_evidence is False, regardless of
what Claude wrote in `answer`, so every consumer of this API (including
the existing evaluation benchmark, which string-matches this exact
sentence) keeps working unchanged.
"""
from __future__ import annotations

from modules.query_understanding.schemas import NULL_QUERY_ANALYSIS, QueryAnalysis

REFUSAL_TEXT = "I couldn't find enough information in the available decisions."

ANSWER_TOOL_NAME = "submit_answer"

_MULTI_DOCUMENT_INSTRUCTION = (
    "This question likely spans multiple decisions. If more than one decision in the context "
    "is relevant, structure your answer as a short list in plain text - one sentence per "
    "relevant decision, each citing its decision number - followed by a one-sentence overall "
    "summary. Do not merge distinct decisions into one statement if they are actually separate."
)

_FORMATTING_RULES = (
    "- Plain prose only: never use markdown syntax (no **bold**, no # headings, no bullet or "
    "numbered list characters). The frontend displays this text as-is, so any markdown "
    "punctuation shows up literally to the reader instead of being rendered. Structure with "
    "plain sentences and paragraph breaks instead.\n"
    "- Never use an em dash (—) or double hyphen (--). Use a period, comma, colon, or \"and\"/"
    "\"but\" to join or separate clauses instead."
)

SYSTEM_PROMPT_TEMPLATE = """You are Locus AI, answering questions about a company's recorded \
decisions using ONLY the context supplied below.

Rules:
- Answer ONLY using the supplied context. Never use outside knowledge, general assumptions, or \
anything about what a company "probably" did.
- Never invent facts, decisions, owners, dates, or outcomes that are not explicitly present in \
the context.
- Cite every factual statement you make with its specific decision number (e.g. "Decision 2"). A \
sentence with no citation should not contain a specific claim from the context.
- If one or more decisions in the context directly and clearly support an answer, answer \
confidently and cite them - even if other, less relevant decisions are also present in the \
context. The presence of topically-related-but-non-answering decisions is NOT a reason to refuse \
or hedge; only evaluate whether the decisions that actually bear on the question support an \
answer.
- Only when two or more decisions DIRECTLY conflict about the same specific fact (not merely \
adjacent or topically similar) should you explain both viewpoints instead of silently picking one.
- Set sufficient_evidence to false ONLY when no decision in the context actually answers the \
question. Do not refuse merely because multiple related decisions exist, but do not guess or \
partially answer from outside knowledge when the context genuinely lacks a supporting decision.
{formatting_rules}
{multi_document_instruction}
Call the submit_answer tool exactly once with your response."""


def _is_real_analysis(query_analysis: QueryAnalysis | None) -> bool:
    """True only for a genuine (non-fallback) QueryAnalysis - NULL_QUERY_ANALYSIS never counts."""
    return query_analysis is not None and query_analysis is not NULL_QUERY_ANALYSIS


def build_system_prompt(query_analysis: QueryAnalysis | None) -> str:
    """Render the system prompt, adding multi-document structuring guidance when relevant."""
    instruction = (
        _MULTI_DOCUMENT_INSTRUCTION
        if (_is_real_analysis(query_analysis) and query_analysis.is_multi_document)
        else ""
    )
    return SYSTEM_PROMPT_TEMPLATE.format(
        formatting_rules=_FORMATTING_RULES, multi_document_instruction=instruction
    )


def build_user_message(question: str, context: str, query_analysis: QueryAnalysis | None) -> str:
    """Render the question, its detected type/intent (if genuinely analyzed), and the formatted context."""
    header = f"Question:\n{question}"
    if _is_real_analysis(query_analysis) and query_analysis.intent:
        header += f"\n\nDetected intent: {query_analysis.intent} (question_type={query_analysis.question_type.value})"
    return f"{header}\n\nContext:\n{context}"


ANSWER_TOOL_SCHEMA = {
    "name": ANSWER_TOOL_NAME,
    "description": "Submit the grounded answer to the user's question, based only on the supplied context.",
    "input_schema": {
        "type": "object",
        "properties": {
            "sufficient_evidence": {
                "type": "boolean",
                "description": (
                    "True if the supplied context contains enough information to answer the "
                    "question. False if it does not - answer/reasoning/citations are still "
                    "required in that case but will be overridden with a standard refusal."
                ),
            },
            "answer": {
                "type": "string",
                "description": (
                    "The answer, grounded ONLY in the supplied context, citing every factual "
                    "statement inline as 'Decision N'. If sufficient_evidence is false, still "
                    "provide your best short explanation of what's missing."
                ),
            },
            "reasoning": {
                "type": "string",
                "description": (
                    "A brief 1-3 sentence explanation of which decisions were used and why they "
                    "answer the question - the grounding chain, not a restatement of the answer."
                ),
            },
            "citations": {
                "type": "array",
                "items": {"type": "integer"},
                "description": "Every decision number (matching 'Decision N' in the context) actually used to support the answer.",
            },
            "confidence": {
                "type": "number",
                "minimum": 0.0,
                "maximum": 1.0,
                "description": "Self-reported confidence that the answer is fully and correctly grounded in the cited decisions.",
            },
        },
        "required": ["sufficient_evidence", "answer", "reasoning", "citations", "confidence"],
        "additionalProperties": False,
    },
}
