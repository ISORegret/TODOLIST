# Duo Todo

Realtime shared to-do list built with React + Vite + Supabase.

## Environment variables

Copy `.env.example` to `.env` and fill values:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- `VITE_VAPID_PUBLIC_KEY` (for browser push subscription)

## Background push notifications (service worker + edge function)

Ping notifications can be delivered even when the page is closed if you configure Web Push.

### 1) Run required SQL migrations

Apply the latest migrations, including:

- `20260504190000_member_pings.sql`
- `20260504205000_web_push_subscriptions.sql`

### 2) Generate VAPID keys and set browser env

Generate VAPID keypair (example with Node's `web-push` package), then set:

- `VITE_VAPID_PUBLIC_KEY` in your web app env

### 3) Add function secrets in Supabase

Set these secrets for edge functions:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`
- `VAPID_SUBJECT` (example: `mailto:you@example.com`)

### 4) Deploy the edge function

Function path:

- `supabase/functions/send-member-ping-push`

Deploy with Supabase CLI (example):

```bash
supabase functions deploy send-member-ping-push
```

If you keep `verify_jwt = true` (recommended), your app must invoke with a signed-in user session (already handled in the client).

When users allow notifications, the app registers `public/sw.js` and stores a push subscription in `public.push_subscriptions`.
