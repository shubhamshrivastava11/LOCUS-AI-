-- A corridor aimed at a narrow subject was firing on everything.
--
-- "Infrastructure spend to Finance" matches record_type "decision", which is
-- the generic type, and its allowlist includes decision_statement, which
-- every record carries. The effect: a Finance record emitted for every
-- Engineering decision ever captured. Found by reading the live corridor
-- list after mapping scopes, not by a test - the data was internally valid
-- and every constraint passed.
--
-- when_has_fields is the missing condition: the fields a source must
-- actually carry for the rule to be relevant. Deliberately separate from
-- carry_fields, because what makes a rule RELEVANT is not what it is
-- allowed to CARRY, and merging them would widen a corridor's trigger every
-- time somebody wanted one more field to cross.

alter table public.routing_rules
  add column if not exists when_has_fields text[] not null default '{}';

comment on column public.routing_rules.when_has_fields is
  'Fields the source record must carry, non-null and non-empty, for this '
  'rule to fire. Empty means no such requirement.';
