import { createClient, SupabaseClient } from '@supabase/supabase-js';

let cachedSupabase: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient {
  if (cachedSupabase) {
    return cachedSupabase;
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl) {
    throw new Error('SUPABASE_URL is not set');
  }

  if (!supabaseKey) {
    throw new Error(
      'SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY must be set'
    );
  }

  cachedSupabase = createClient(supabaseUrl, supabaseKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  return cachedSupabase;
}
