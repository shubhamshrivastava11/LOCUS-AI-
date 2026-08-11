"""
Unit tests for modules.decisions.service._guess_actor_name().

Extraction only ever captures ActorReference.source_actor_id (see
modules.ai.extraction.schemas) - no dedicated name field - so it lands in
whichever provider-identifier column matches the event's source. For
Notion/Slack that identifier is sometimes a real machine id (a page UUID,
a "U..." Slack id) and sometimes literally the person's name as written in
the text, since raw text often has no real id to extract. _guess_actor_name
picks the best available string while skipping values that are clearly a
real machine id, not a name.
"""
from __future__ import annotations

from modules.decisions.service import _guess_actor_name


class TestDisplayNameAndEmailWin:
    def test_display_name_wins_over_everything(self):
        assert _guess_actor_name("Rajith", "rajith@acme.com", "some-id", "U123456789") == "Rajith"

    def test_email_used_when_no_display_name(self):
        assert _guess_actor_name(None, "rajith@acme.com", "some-id", None) == "rajith@acme.com"


class TestNotionIdentifierFallback:
    def test_real_notion_uuid_is_rejected_as_a_name(self):
        assert _guess_actor_name(None, None, "38bd872b-594c-8175-adf4-0002b6472331", None) is None

    def test_plain_name_in_notion_identifier_column_is_used(self):
        # Confirmed live: extraction sometimes writes a literal name here
        # because the source text never carried a real Notion user id.
        assert _guess_actor_name(None, None, "Rebira Adugna", None) == "Rebira Adugna"


class TestSlackIdentifierFallback:
    def test_real_slack_user_id_is_rejected_as_a_name(self):
        assert _guess_actor_name(None, None, None, "U0BGD5AC4FQ") is None

    def test_plain_name_in_slack_identifier_column_is_used(self):
        assert _guess_actor_name(None, None, None, "Priya Nair") == "Priya Nair"


class TestNothingUsable:
    def test_all_none_returns_none(self):
        assert _guess_actor_name(None, None, None, None) is None

    def test_all_machine_ids_returns_none(self):
        assert (
            _guess_actor_name(
                None, None, "38bd872b-594c-8175-adf4-0002b6472331", "U0BGD5AC4FQ"
            )
            is None
        )
