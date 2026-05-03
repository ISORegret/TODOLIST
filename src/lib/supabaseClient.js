import { createClient } from '@supabase/supabase-js'

/** Strip BOM, smart quotes, accidental wrapping; ignore literal "undefined" from mis-set CI vars */
function cleanEnv(raw) {
  let s = String(raw ?? '')
    .replace(/^\uFEFF/, '')
    .trim()
    .replace(/^[\u201C\u201D'"`]+|[\u201C\u201D'"`]+$/g, '')
    .trim()
  if (!s || s === 'undefined' || s === 'null') return ''
  return s
}

const urlRaw = cleanEnv(import.meta.env.VITE_SUPABASE_URL)
const anonRaw = cleanEnv(import.meta.env.VITE_SUPABASE_ANON_KEY)
/** JWT must be one line — remove line breaks often introduced when pasting into GitHub Secrets */
const anonKey = anonRaw.replace(/\s/g, '')
const url = urlRaw.replace(/\/+$/, '')

/** Env vars look configured after cleanup */
export const supabaseEnvPresent = Boolean(url && anonKey)

let client = null
/** Set when createClient throws (shown in UI so you do not need the console) */
export let supabaseInitError = ''

if (supabaseEnvPresent) {
  try {
    client = createClient(url, anonKey)
  } catch (err) {
    supabaseInitError = err?.message ? String(err.message) : String(err)
    console.error('Supabase createClient failed', err)
  }
}

/** True only when client was created successfully */
export const supabaseConfigured = supabaseEnvPresent && client != null

export const supabase = client
