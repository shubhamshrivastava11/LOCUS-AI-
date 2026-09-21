-- Structured facts extracted alongside a record, so routing corridors have
-- something to key on and carry.
--
-- Until now a decision carried four pieces of prose and nothing structured,
-- which is why every routing corridor was dormant: an allowlist naming
-- ship_date or estimated_monthly_cost could never match a record that had
-- no such field to give. This is the column those fields live in.
--
-- WHY A JSONB BAG rather than twenty-six columns. Most of these are null for
-- most records - a cost figure appears on spend decisions and nowhere else -
-- and twenty-six mostly-null columns is a schema that describes the
-- exceptions rather than the rule. The set also changes as corridors are
-- added, and a migration per attribute is friction that would stop anyone
-- adding one.
--
-- The tradeoff is that jsonb accepts anything, so the KEYS are whitelisted
-- in ai-worker before the insert. An unrecognised key is dropped rather than
-- stored: the model proposes, the server decides, exactly as it already does
-- for the sensitivity field.
--
-- Deliberately NOT part of the access rule. Attributes are content, and
-- content is governed by the record's classification like everything else.
-- Nothing here reads attributes to decide who sees what.

alter table public.decisions
  add column if not exists attributes jsonb not null default '{}'::jsonb;

-- An object, never a scalar or an array: the code indexes it by key.
alter table public.decisions drop constraint if exists decisions_attributes_object;
alter table public.decisions add constraint decisions_attributes_object
  check (jsonb_typeof(attributes) = 'object');

-- Routing asks "does this record carry X", which is a containment question.
-- Partial, because the overwhelming majority of rows carry nothing and
-- indexing an empty object on every row buys nothing.
create index if not exists idx_decisions_attributes
  on public.decisions using gin (attributes)
  where attributes <> '{}'::jsonb;

comment on column public.decisions.attributes is
  'Structured facts extracted from the source, keys whitelisted server-side. '
  'Read by routing corridors; never read by the access rule.';
