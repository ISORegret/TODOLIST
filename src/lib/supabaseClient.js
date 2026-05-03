import { createClient } from '@supabase/supabase-js'

const url = (import.meta.env.VITE_SUPABASE_URL ?? '').trim()
const anonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY ?? '').trim()

/** Env vars are non-empty (may still fail createClient if malformed) */
export const supabaseEnvPresent = Boolean(url && anonKey)

let client = null
if (supabaseEnvPresent) {
  try {
    client = createClient(url, anonKey)
  } catch (err) {
    console.error('Supabase createClient failed', err)
  }
}

/** True only when client was created successfully */
export const supabaseConfigured = supabaseEnvPresent && client != null

export const supabase = client
