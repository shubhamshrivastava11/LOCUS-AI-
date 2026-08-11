"""
Unit tests for the plain-text formatting rules in
modules.answering.prompt_builder.build_system_prompt().

The frontend renders the answer text as-is (no markdown renderer), so
Claude's raw prose is exactly what the user sees - literal "**" characters
and em dashes were showing up unrendered in real search results.
"""
from __future__ import annotations

from modules.answering.prompt_builder import build_system_prompt


class TestFormattingRules:
    def test_forbids_markdown_bold(self):
        assert "**bold**" in build_system_prompt(None)

    def test_forbids_markdown_headings(self):
        assert "# headings" in build_system_prompt(None)

    def test_forbids_em_dash(self):
        prompt = build_system_prompt(None)
        assert "em dash" in prompt
        assert "—" in prompt  # the character itself, so Claude sees exactly what to avoid

    def test_still_identifies_as_locus_ai(self):
        assert "You are Locus AI" in build_system_prompt(None)
