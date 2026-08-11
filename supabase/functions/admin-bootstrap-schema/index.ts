// supabase/functions/admin-bootstrap-schema/index.ts
//
// One-off trigger to run idempotent schema bootstraps immediately, instead
// of waiting for the next real OAuth connect to lazily create a column the
// frontend already expects to exist (which would 500 on every page load
// for every existing user until then).

import { ensureSourceConnectionDisplayNameColumn } from "../_shared/sourceConnectionSchema.ts";

Deno.serve(async () => {
  await ensureSourceConnectionDisplayNameColumn();
  return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
});
