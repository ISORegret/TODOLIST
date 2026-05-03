import { createClient } from '@supabase/supabase-js'

const url = (import.meta.env.VITE_SUPABASE_URL ?? '').trim()
const anonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY ?? '').trim()

export const supabaseConfigured = Boolean(url && anonKey)

/** Only created when URL + anon key are set; otherwise createClient('','') throws and the app stays a white screen. */
export const supabase = supabaseConfigured ? createClient(url, anonKey) : null
