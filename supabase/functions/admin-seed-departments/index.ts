// supabase/functions/admin-seed-departments/index.ts
//
// Seeds the standard department set and its corridors into a tenant.
//
// The taxonomy lives in _shared/departmentTemplate.ts, not in SQL, so this
// endpoint exists rather than a migration: one source of truth, written once
// in TypeScript and read here. A migration would have meant a second copy in
// SQL that drifts the first time somebody edits one and not the other.
//
// SEEDING IS INERT. Departments and corridors alone change nothing about
// what anybody sees. A department only starts applying when a scope is
// mapped to it in department_scopes, and this endpoint maps none - a record
// with no department has departmentId null, which makes its department
// default irrelevant and makes every routing rule refuse to fire. Mapping
// scopes is a separate, deliberate act, per tenant, by someone who knows
// which channel belongs to which department.
//
// Two-phase and safe to call repeatedly:
//   ?mode=preview (default) - read-only, reports what WOULD be created.
//   ?mode=apply             - creates what is missing. Existing rows are
//                             left alone rather than overwritten, so a
//                             tenant that has renamed or retuned a
//                             department does not lose that on a re-run.
//
// Requires a valid Supabase key in the Authorization header.

import { withAdmin } from "../_shared/db.ts";
import {
  CLASSIFICATION_RULES,
  CORRIDORS,
  DEPARTMENTS,
} from "../_shared/departmentTemplate.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-region",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

type Plan = {
  tenantId: string;
  tenantName: string | null;
  departmentsToCreate: string[];
  corridorsToCreate: string[];
  departmentsExisting: number;
  corridorsExisting: number;
  rulesToCreate: string[];
  rulesExisting: number;
  skippedCorridors: { name: string; why: string }[];
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const url = new URL(req.url);
  const mode = url.searchParams.get("mode") ?? "preview";
  if (mode !== "preview" && mode !== "apply") {
    return json({ error: "mode must be preview or apply" }, 400);
  }
  // Optional: seed one tenant rather than all of them.
  const onlyTenant = url.searchParams.get("tenant_id");

  try {
    const plans = await withAdmin(async (sql) => {
      const tenants = onlyTenant
        ? await sql`SELECT id, name FROM public.tenants WHERE id = ${onlyTenant}::uuid`
        : await sql`SELECT id, name FROM public.tenants ORDER BY created_at`;

      const out: Plan[] = [];

      for (const t of tenants) {
        const tenantId = t.id as string;

        const existingDepts = await sql`
          SELECT id, name FROM public.departments WHERE tenant_id = ${tenantId}::uuid
        `;
        const byName = new Map<string, string>(
          existingDepts.map((r: Record<string, unknown>) => [r.name as string, r.id as string]),
        );

        const existingRules = await sql`
          SELECT name FROM public.routing_rules WHERE tenant_id = ${tenantId}::uuid
        `;
        const ruleNames = new Set(
          existingRules.map((r: Record<string, unknown>) => r.name as string),
        );

        const existingClass = await sql`
          SELECT name FROM public.classification_rules WHERE tenant_id = ${tenantId}::uuid
        `;
        const classNames = new Set(
          existingClass.map((r: Record<string, unknown>) => r.name as string),
        );

        const plan: Plan = {
          tenantId,
          tenantName: (t.name as string) ?? null,
          departmentsToCreate: DEPARTMENTS.filter((d) => !byName.has(d.name)).map((d) => d.name),
          corridorsToCreate: CORRIDORS.filter((c) => !ruleNames.has(c.name)).map((c) => c.name),
          departmentsExisting: existingDepts.length,
          corridorsExisting: existingRules.length,
          rulesToCreate: CLASSIFICATION_RULES.filter((r) => !classNames.has(r.name)).map((r) =>
            r.name
          ),
          rulesExisting: existingClass.length,
          skippedCorridors: [],
        };

        if (mode === "apply") {
          // Departments first: a corridor cannot reference a department that
          // does not exist yet, and both endpoints must resolve.
          for (const d of DEPARTMENTS) {
            if (byName.has(d.name)) continue;
            const rows = await sql`
              INSERT INTO public.departments (tenant_id, name, default_classification)
              VALUES (${tenantId}::uuid, ${d.name}, ${d.defaultClassification})
              ON CONFLICT (tenant_id, name) DO NOTHING
              RETURNING id
            `;
            if (rows.length > 0) byName.set(d.name, rows[0].id as string);
          }

          // Re-read rather than trusting the map: ON CONFLICT DO NOTHING
          // returns no row when another caller inserted concurrently, and a
          // corridor pointing at an undefined id would fail the not-null.
          const afterDepts = await sql`
            SELECT id, name FROM public.departments WHERE tenant_id = ${tenantId}::uuid
          `;
          const nameToId = new Map<string, string>(
            afterDepts.map((r: Record<string, unknown>) => [r.name as string, r.id as string]),
          );
          const keyToId = new Map<string, string>(
            DEPARTMENTS
              .map((d) => [d.key, nameToId.get(d.name)] as const)
              .filter((pair): pair is readonly [string, string] => Boolean(pair[1]))
              .map(([k, v]) => [k, v]),
          );

          for (const c of CORRIDORS) {
            if (ruleNames.has(c.name)) continue;
            const from = keyToId.get(c.from);
            const to = keyToId.get(c.to);
            if (!from || !to) {
              // Only reachable if a department insert failed. Recorded rather
              // than thrown so one bad corridor does not abandon the rest.
              plan.skippedCorridors.push({
                name: c.name,
                why: `missing department ${!from ? c.from : c.to}`,
              });
              continue;
            }
            await sql`
              INSERT INTO public.routing_rules (
                tenant_id, name, from_department_id, to_department_id,
                when_record_type, when_min_classification, when_has_fields,
                emit_classification, carry_fields, purpose
              ) VALUES (
                ${tenantId}::uuid, ${c.name}, ${from}::uuid, ${to}::uuid,
                ${c.when_record_type}, ${c.when_min_classification}, ${c.when_has_fields ?? []},
                ${c.emit_classification}, ${c.carry_fields}, ${c.purpose}
              )
              ON CONFLICT DO NOTHING
            `;
          }

          // Classification rules last: they reference a department by id
          // too, and a tenant-wide rule has none, so both cases are handled
          // here rather than in the corridor loop above.
          for (const r of CLASSIFICATION_RULES) {
            if (classNames.has(r.name)) continue;
            const deptId = r.department === null ? null : keyToId.get(r.department) ?? null;
            if (r.department !== null && deptId === null) {
              plan.skippedCorridors.push({
                name: r.name,
                why: `missing department ${r.department}`,
              });
              continue;
            }
            await sql`
              INSERT INTO public.classification_rules (
                tenant_id, department_id, name, match_type, match_terms,
                set_classification, set_compartment, priority
              ) VALUES (
                ${tenantId}::uuid, ${deptId}, ${r.name}, ${r.match_type}, ${r.match_terms},
                ${r.set_classification}, ${r.set_compartment}, ${r.priority}
              )
              ON CONFLICT DO NOTHING
            `;
          }
        }

        out.push(plan);
      }

      return out;
    });

    const created = plans.reduce(
      (acc, p) => ({
        departments: acc.departments + p.departmentsToCreate.length,
        corridors: acc.corridors + p.corridorsToCreate.length,
        classificationRules: acc.classificationRules + p.rulesToCreate.length,
      }),
      { departments: 0, corridors: 0, classificationRules: 0 },
    );

    return json({
      mode,
      tenants: plans.length,
      [mode === "apply" ? "created" : "would_create"]: created,
      note:
        "Seeding is inert until scopes are mapped to departments in department_scopes. " +
        "A record with no department ignores department defaults and matches no routing rule.",
      plans,
    });
  } catch (e) {
    return json({ error: String(e instanceof Error ? e.message : e) }, 500);
  }
});
