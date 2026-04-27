import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabaseConfig.js';

try {
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  console.log("Success");
} catch (err) {
  console.error("Error creating client:", err);
}
