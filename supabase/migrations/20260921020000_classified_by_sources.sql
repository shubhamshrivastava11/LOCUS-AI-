-- decisions.classified_by records WHICH input decided a record's
-- classification, so a later reviewer can tell a deliberate policy from a
-- model guess from an untouched default. The rules engine adds three sources
-- the original constraint did not know about.
--
-- Found by checking the constraint before deploying rather than after: every
-- record from a department with a default, from a matching classification
-- rule, or emitted by a routing rule would have failed this CHECK on insert.
-- Since that insert is the last step of ingestion, the effect would have been
-- the entire pipeline stalling the moment a tenant configured a department -
-- silent, because the failure is inside a queue worker.
--
--   department   - the record's scope belongs to a department whose default
--                  classification was the highest of the inputs
--   rule         - a classification_rules row matched and set the level
--   routing_rule - the record is a derived one, created by routing; its
--                  level came from the corridor's emit_classification

alter table public.decisions drop constraint if exists decisions_classified_by_source;
alter table public.decisions add constraint decisions_classified_by_source
  check (classified_by = any (array[
    'default'::text,
    'model'::text,
    'user'::text,
    'scope_floor'::text,
    'department'::text,
    'rule'::text,
    'routing_rule'::text
  ]));
