import { createClient, type SupabaseClient } from '@supabase/supabase-js'

let supabase: SupabaseClient | undefined

export function isSupabaseConfigured() {
  return Boolean(
    import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY,
  )
}

export function getSupabaseClient() {
  if (supabase) return supabase

  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
  const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(
      'Supabase is not configured. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to frontend/.env.',
    )
  }

  supabase = createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      flowType: 'pkce',
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
    global: {
      // Pins Edge Function execution to the database's own region. Without
      // it, functions run near the user and every database round trip
      // crosses an ocean - measured at 7,422ms vs 133ms for identical work
      // (see FUNCTION_REGION in lib/api.ts for the full reasoning).
      //
      // Harmless on the PostgREST calls this client also makes: those are
      // served alongside the database already and simply ignore the header.
      headers: { 'x-region': 'us-west-1' },
    },
  })

  return supabase
}
