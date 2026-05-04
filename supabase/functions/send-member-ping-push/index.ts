import { createClient } from '@supabase/supabase-js'
import webpush from 'npm:web-push@3.6.7'

type PushSubscriptionRow = {
  endpoint: string
  p256dh: string
  auth: string
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function decodeJwtSub(jwt: string) {
  const parts = jwt.split('.')
  if (parts.length < 2) return ''
  const payload = parts[1]
  try {
    const padded = payload.padEnd(Math.ceil(payload.length / 4) * 4, '=')
    const base64 = padded.replace(/-/g, '+').replace(/_/g, '/')
    const json = JSON.parse(atob(base64))
    return typeof json.sub === 'string' ? json.sub : ''
  } catch {
    return ''
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') || ''
  const serviceRole = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
  const vapidPublic = Deno.env.get('VAPID_PUBLIC_KEY') || ''
  const vapidPrivate = Deno.env.get('VAPID_PRIVATE_KEY') || ''
  const vapidSubject = Deno.env.get('VAPID_SUBJECT') || 'mailto:admin@example.com'
  if (!supabaseUrl || !serviceRole || !vapidPublic || !vapidPrivate) {
    return new Response(JSON.stringify({ error: 'Missing env configuration' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const body = await req.json().catch(() => ({}))
  const authHeader = req.headers.get('Authorization') || ''
  const jwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (!jwt) {
    return new Response(JSON.stringify({ error: 'Missing bearer token' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const senderUserId = decodeJwtSub(jwt)
  if (!senderUserId) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const toUserId = typeof body.toUserId === 'string' ? body.toUserId : ''
  const roomId = typeof body.roomId === 'string' ? body.roomId : ''
  const fromName = typeof body.fromName === 'string' ? body.fromName : 'Someone'
  const message = typeof body.message === 'string' ? body.message : `${fromName} pinged you`
  if (!toUserId || !roomId) {
    return new Response(JSON.stringify({ error: 'to_user_id and room_id are required' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const admin = createClient(supabaseUrl, serviceRole)
  webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate)

  const { data: memberRow, error: memberErr } = await admin
    .from('room_members')
    .select('room_id')
    .eq('room_id', roomId)
    .eq('user_id', senderUserId)
    .maybeSingle()

  if (memberErr || !memberRow) {
    return new Response(JSON.stringify({ error: 'Sender is not a room member' }), {
      status: 403,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const { data: subscriptions, error } = await admin
    .from('push_subscriptions')
    .select('endpoint, p256dh, auth')
    .eq('user_id', toUserId)
    .eq('enabled', true)

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const rows = (subscriptions || []) as PushSubscriptionRow[]
  if (rows.length === 0) {
    return new Response(JSON.stringify({ sent: 0, skipped: 'no_subscriptions' }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  let sent = 0
  for (const row of rows) {
    try {
      await webpush.sendNotification(
        {
          endpoint: row.endpoint,
          keys: {
            p256dh: row.p256dh,
            auth: row.auth,
          },
        },
        JSON.stringify({
          title: `Ping from ${fromName}`,
          body: message,
          room_id: roomId,
          url: '/',
          tag: `duo-ping-${toUserId}`,
        }),
        {
          TTL: 60,
          urgency: 'high',
        },
      )
      sent += 1
    } catch (err) {
      const statusCode =
        err && typeof err === 'object' && 'statusCode' in err
          ? Number((err as { statusCode?: number }).statusCode)
          : 0
      if (statusCode === 404 || statusCode === 410) {
        await admin
          .from('push_subscriptions')
          .delete()
          .eq('endpoint', row.endpoint)
          .eq('user_id', toUserId)
      }
      // Best-effort; continue delivering to remaining subscriptions.
    }
  }

  return new Response(JSON.stringify({ sent, total: rows.length }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
})
