-- Memory Explorer upgrade (MVP 02 architecture), Phase 1: schema changes.
-- Implements docs/Solution_for_upgrade_memory-explorer.md Section 1/5.
--
-- Scope decision, called out explicitly for reviewers: this migration is
-- deliberately ADDITIVE, not destructive. The source doc's Phase 1 step 3
-- says to drop public.unresolved_entities and public.memory_fixture_events
-- outright. Both memory_source_events and memory_citations currently hold
-- an `on delete cascade` FK to memory_fixture_events - dropping that table
-- as written would silently cascade-delete every existing memory's
-- provenance rows, including real production memories already loaded for
-- real tenants this session. That's not what "retire the fixture-event
-- indirection" should mean. This migration instead:
--   1. Points new provenance rows at raw_events directly (the doc's actual
--      goal - ai-worker writing straight from raw_events, no intermediary).
--   2. Leaves memory_fixture_events and its existing FKs in place so no
--      existing data is destroyed.
-- Actually dropping memory_fixture_events/unresolved_entities is left as a
-- separate, explicit follow-up once there's a real data migration path for
-- whatever rows still reference them - not bundled into this PR silently.

-- ── 3-core-type taxonomy (memories.type) ──────────────────────────────
-- Was: Context, Change, Commitment, Decision, Rationale, Blocker, Outcome,
-- Requirement, CustomerSignal (9 types). Rationale/Outcome/Requirement/
-- Change/CustomerSignal collapse into Decision's payload per the doc's
-- Section 2 mapping table rather than being separate memory rows.
alter table public.memories drop constraint if exists memories_type_check;
alter table public.memories add constraint memories_type_check
  check (type in ('Decision', 'Commitment', 'Blocker'));

-- ── 3 relational entity types (entities.entity_type) ──────────────────
-- Was: Person, Team, Project, Customer, Product, Topic, System (7 types).
-- Customer/Product/Topic/System demote to searchable tags on memories
-- rather than relational entities - see memories.tags below.
alter table public.entities drop constraint if exists entities_entity_type_check;
alter table public.entities add constraint entities_entity_type_check
  check (entity_type in ('Person', 'Team', 'Project'));

-- ── Demoted concepts become searchable tags, not entity rows ──────────
-- Section 3 "Demotion of Content Concepts": System/Topic/Product mentions
-- no longer create entities or occupy the review queue - they're metadata
-- on the memory itself instead.
alter table public.memories add column if not exists tags text[] not null default '{}';
create index if not exists idx_memories_tags on public.memories using gin (tags);

-- ── Direct raw_events provenance (retires the fixture-event indirection
-- for new writes going forward) ───────────────────────────────────────
-- memory_source_events was originally keyed by a composite primary key,
-- primary key (memory_id, fixture_event_id) - unlike memory_citations,
-- which already uses a surrogate `id` PK and isn't affected by any of this.
-- Postgres refuses to drop NOT NULL on a column that's still part of a
-- primary key ("column ... is in a primary key"), so the very next
-- statement here would have failed outright and this migration could never
-- have applied at all. Caught in review (self-caught, re-verifying the
-- reconciliation fix's own INSERT/ON CONFLICT against this table's real
-- constraints) before this ever reached a real database. Fixed by moving
-- to the same surrogate-id-PK shape memory_citations already uses, then
-- replacing the uniqueness the old composite PK gave with two partial
-- unique indexes - one per provenance source - so a given memory can't
-- gain a duplicate source_events row from either path, and ON CONFLICT has
-- a real constraint to target.
alter table public.memory_source_events drop constraint if exists memory_source_events_pkey;
alter table public.memory_source_events add column if not exists id uuid not null default gen_random_uuid();
alter table public.memory_source_events add primary key (id);

alter table public.memory_source_events add column if not exists raw_event_id uuid references public.raw_events(id) on delete cascade;
alter table public.memory_source_events alter column fixture_event_id drop not null;
create index if not exists idx_memory_source_events_raw_event on public.memory_source_events(raw_event_id);
create unique index if not exists idx_memory_source_events_unique_fixture
  on public.memory_source_events(memory_id, fixture_event_id) where fixture_event_id is not null;
create unique index if not exists idx_memory_source_events_unique_raw
  on public.memory_source_events(memory_id, raw_event_id) where raw_event_id is not null;

alter table public.memory_citations add column if not exists raw_event_id uuid references public.raw_events(id) on delete cascade;
alter table public.memory_citations alter column fixture_event_id drop not null;
create index if not exists idx_memory_citations_raw_event on public.memory_citations(raw_event_id);

-- A provenance row must point at exactly one of the two sources - never
-- both, never neither - so it's always clear which pipeline a given
-- memory's evidence came from.
alter table public.memory_source_events drop constraint if exists memory_source_events_one_source;
alter table public.memory_source_events add constraint memory_source_events_one_source
  check ((raw_event_id is not null) <> (fixture_event_id is not null));

alter table public.memory_citations drop constraint if exists memory_citations_one_source;
alter table public.memory_citations add constraint memory_citations_one_source
  check ((raw_event_id is not null) <> (fixture_event_id is not null));

-- ── Deterministic entity anchors (Section 3) ───────────────────────────
-- The connector-native identifier a Person/Project/Team entity was
-- resolved from, so re-encountering the same actor_id/channel_id/
-- notion_db_id upserts the SAME entity with zero LLM/vector calls, instead
-- of going through embedding similarity or judgeEntityMatch. Unique per
-- (tenant, entity_type, anchor) so two different connectors' ids can never
-- collide across tenants or types.
-- Predicate is status = 'current', matching entities.status's real check
-- constraint (current | superseded, from
-- 20260822050000_entity_supersession_and_merge_review.sql) - not 'active',
-- which isn't a value this column accepts at all. Caught in review: an
-- earlier draft of this migration and ai-worker's own upsert both wrote
-- 'active' by mistake, which would have failed every single entity insert
-- with a check-constraint violation before this ever reached production.
alter table public.entities add column if not exists source_anchor text;
create unique index if not exists idx_entities_source_anchor
  on public.entities(tenant_id, entity_type, source_anchor)
  where source_anchor is not null and status = 'current';

-- ── Bounded reconciliation candidate lookup (Section 4) ────────────────
-- The exact index the doc's own pre-filter query needs: tenant + type +
-- attribute_key + status='current' + valid_until is null, ORDER BY
-- valid_from DESC LIMIT 3. Without this the "bounded" query still scans.
create index if not exists idx_memories_reconcile_candidates
  on public.memories(tenant_id, type, attribute_key, valid_from desc)
  where status = 'current' and valid_until is null;
