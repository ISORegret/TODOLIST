import { useState, useEffect, useRef, useCallback } from 'react'
import {
  supabase,
  supabaseConfigured,
  supabaseEnvPresent,
  supabaseInitError,
} from './lib/supabaseClient'
import './duo-todo.css'

const LS_ROOM = 'duo-room-id'
const LS_JOIN = 'duo-join-code'
const LS_NAME = 'duo-my-name'
const LS_FILTER_PREF = 'duo-filter-pref'
const LS_ASSIGN_PREF = 'duo-assign-pref'
const UNDO_TOAST_MS = 5200
const VAPID_PUBLIC_KEY = String(import.meta.env.VITE_VAPID_PUBLIC_KEY || '')
  .trim()
  .replace(/^[\u201C\u201D'"`]+|[\u201C\u201D'"`]+$/g, '')
  .trim()
const FILTER_OPTIONS = [
  ['all', 'All'],
  ['mine', 'Mine'],
  ['forme', 'For me'],
  ['done', 'Done'],
]
const VALID_FILTERS = new Set(FILTER_OPTIONS.map(([value]) => value))

const origTitle = "Today's list"

function dateStr() {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  })
}

function genToastId() {
  return Math.random().toString(36).slice(2, 9)
}

function normalizeAssignees(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.map((n) => (typeof n === 'string' ? n.trim() : '')).filter(Boolean))]
  }
  if (typeof value !== 'string') return []
  const trimmed = value.trim()
  if (!trimmed) return []
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed)
      if (Array.isArray(parsed)) return normalizeAssignees(parsed)
    } catch {
      /* ignore */
    }
  }
  return [trimmed]
}

function encodeAssignees(list) {
  const clean = normalizeAssignees(list)
  return clean.length ? JSON.stringify(clean) : null
}

function formatAssignees(list) {
  return normalizeAssignees(list).join(', ')
}

function urlBase64ToUint8Array(value) {
  const padded = `${value}${'='.repeat((4 - (value.length % 4)) % 4)}`
  const base64 = padded.replace(/-/g, '+').replace(/_/g, '/')
  const raw = window.atob(base64)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

function playChime(type = 'add') {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext
    const ctx = new Ctx()
    const notes =
      type === 'add'
        ? [523, 659]
        : type === 'ping'
          ? [784, 988, 784]
          : [659, 523, 784]
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.type = 'sine'
      osc.frequency.setValueAtTime(freq, ctx.currentTime + i * 0.13)
      gain.gain.setValueAtTime(0, ctx.currentTime + i * 0.13)
      gain.gain.linearRampToValueAtTime(0.12, ctx.currentTime + i * 0.13 + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.13 + 0.4)
      osc.start(ctx.currentTime + i * 0.13)
      osc.stop(ctx.currentTime + i * 0.13 + 0.4)
    })
  } catch {
    /* ignore */
  }
}

function mapRow(row) {
  return {
    id: row.id,
    text: row.text,
    by: row.created_by,
    assignedTo: normalizeAssignees(row.assigned_to),
    done: row.done,
    doneBy: row.done_by || null,
    at: new Date(row.created_at).getTime(),
  }
}

/** Shown in the member list and assignee dropdown when display_name is still empty */
function memberLabelFromRow(row) {
  const d = (row.display_name || '').trim()
  if (d) return d
  const raw = (row.user_id || '').replace(/-/g, '')
  return raw ? `Member ${raw.slice(0, 6)}` : 'Member'
}

export default function App() {
  const [session, setSession] = useState(null)
  const [authReady, setAuthReady] = useState(false)
  const [authError, setAuthError] = useState(null)
  const [emailIn, setEmailIn] = useState('')
  const [passwordIn, setPasswordIn] = useState('')
  const [accountBusy, setAccountBusy] = useState(false)
  const [accountError, setAccountError] = useState('')
  const [accountSuccess, setAccountSuccess] = useState('')
  const [roomId, setRoomId] = useState(() => localStorage.getItem(LS_ROOM) || '')
  const [joinCodeDisplay, setJoinCodeDisplay] = useState(
    () => localStorage.getItem(LS_JOIN) || '',
  )
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [isRoomCreator, setIsRoomCreator] = useState(false)
  const [customCodeDraft, setCustomCodeDraft] = useState('')
  const [customCodeBusy, setCustomCodeBusy] = useState(false)
  const [customCodeMsg, setCustomCodeMsg] = useState('')
  const [roomTitle, setRoomTitle] = useState('')
  const [newListTitle, setNewListTitle] = useState('')
  const [listTitleDraft, setListTitleDraft] = useState('')
  const [listTitleBusy, setListTitleBusy] = useState(false)
  const [listTitleMsg, setListTitleMsg] = useState('')
  const [leaveListBusy, setLeaveListBusy] = useState(false)
  const [myName, setMyName] = useState(() => localStorage.getItem(LS_NAME) || '')
  const [nameIn, setNameIn] = useState('')
  const [joinCodeIn, setJoinCodeIn] = useState('')
  const [roomBusy, setRoomBusy] = useState(false)
  const [roomError, setRoomError] = useState('')

  /** True while changing name / list without leaving current room yet */
  const [setupPhase, setSetupPhase] = useState(false)
  /** Sorted unique display labels (assign / filters) */
  const [members, setMembers] = useState([])
  /** Full rows for UI: who is on this list */
  const [membersDetail, setMembersDetail] = useState([])

  const [tasks, setTasks] = useState([])
  const [filter, setFilter] = useState('all')
  const [addIn, setAddIn] = useState('')
  const [assignTo, setAssignTo] = useState([])
  const [toasts, setToasts] = useState([])
  const [bulkBusy, setBulkBusy] = useState(false)
  const [pingingUserId, setPingingUserId] = useState('')
  const [notifPerm, setNotifPerm] = useState(() =>
    typeof window !== 'undefined' && 'Notification' in window
      ? Notification.permission
      : 'default',
  )
  const [unread, setUnread] = useState(0)
  const [newIds, setNewIds] = useState(() => new Set())
  /** Rooms the current user belongs to (home screen) */
  const [myLists, setMyLists] = useState([])
  const [myListsLoading, setMyListsLoading] = useState(false)

  const prevTasksRef = useRef([])
  const myNameRef = useRef(myName)
  const roomIdRef = useRef(roomId)
  const addRef = useRef(null)
  const setupDoneRef = useRef(false)
  const prefsScopeRef = useRef('')
  const pingCooldownRef = useRef(new Map())
  const seenPingIdsRef = useRef(new Set())
  const lastPingAtRef = useRef('')
  const swRegRef = useRef(null)

  useEffect(() => {
    myNameRef.current = myName
  }, [myName])
  useEffect(() => {
    roomIdRef.current = roomId
  }, [roomId])

  const prefsScope =
    roomId && session?.user?.id ? `${session.user.id}:${roomId}` : ''

  useEffect(() => {
    if (typeof localStorage === 'undefined') return
    if (!prefsScope) return
    prefsScopeRef.current = prefsScope
    const savedFilter = localStorage.getItem(`${LS_FILTER_PREF}:${prefsScope}`) || ''
    const nextFilter = VALID_FILTERS.has(savedFilter) ? savedFilter : 'all'
    setFilter(nextFilter)
    const savedAssignRaw = localStorage.getItem(`${LS_ASSIGN_PREF}:${prefsScope}`) || ''
    if (!savedAssignRaw) {
      setAssignTo([])
      return
    }
    try {
      const parsed = JSON.parse(savedAssignRaw)
      setAssignTo(normalizeAssignees(parsed))
    } catch {
      setAssignTo([])
    }
  }, [prefsScope])

  useEffect(() => {
    if (typeof localStorage === 'undefined') return
    if (!prefsScope || prefsScopeRef.current !== prefsScope) return
    localStorage.setItem(`${LS_FILTER_PREF}:${prefsScope}`, filter)
  }, [filter, prefsScope])

  useEffect(() => {
    if (typeof localStorage === 'undefined') return
    if (!prefsScope || prefsScopeRef.current !== prefsScope) return
    localStorage.setItem(
      `${LS_ASSIGN_PREF}:${prefsScope}`,
      JSON.stringify(normalizeAssignees(assignTo)),
    )
  }, [assignTo, prefsScope])

  useEffect(() => {
    if (unread > 0) document.title = `(${unread}) ${origTitle}`
    else document.title = origTitle
  }, [unread])

  useEffect(() => {
    const onFocus = () => setUnread(0)
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return
    let cancelled = false
    navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL })
      .then((reg) => {
        if (cancelled) return
        swRegRef.current = reg
      })
      .catch((err) => {
        console.error('service worker registration failed', err)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const dismissToast = useCallback((id) => {
    setToasts((t) => t.filter((x) => x.id !== id))
  }, [])

  const showToast = useCallback((msg, options = {}) => {
    const id = genToastId()
    const timeoutMs = Number.isFinite(options.timeoutMs) ? Number(options.timeoutMs) : 3200
    setToasts((t) => [
      ...t,
      {
        id,
        msg,
        actionLabel: options.actionLabel || '',
        onAction: typeof options.onAction === 'function' ? options.onAction : null,
      },
    ])
    setTimeout(() => dismissToast(id), timeoutMs)
  }, [dismissToast])

  const sendBrowserNotif = useCallback((title, body) => {
    if ('Notification' in window && Notification.permission === 'granted') {
      try {
        new Notification(title, { body })
      } catch {
        /* ignore */
      }
    }
  }, [])

  const syncPushSubscription = useCallback(async () => {
    if (!supabase || !session?.user?.id) return
    if (notifPerm !== 'granted') return
    if (!VAPID_PUBLIC_KEY) return
    if (typeof window === 'undefined') return
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return
    try {
      const reg = swRegRef.current || (await navigator.serviceWorker.ready)
      if (!reg) return
      swRegRef.current = reg
      let sub = await reg.pushManager.getSubscription()
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
        })
      }
      const json = sub.toJSON()
      const p256dh = json?.keys?.p256dh || ''
      const auth = json?.keys?.auth || ''
      if (!sub.endpoint || !p256dh || !auth) return
      const { error } = await supabase.from('push_subscriptions').upsert(
        {
          user_id: session.user.id,
          endpoint: sub.endpoint,
          p256dh,
          auth,
          enabled: true,
          user_agent: navigator.userAgent || '',
          updated_at: new Date().toISOString(),
          last_seen_at: new Date().toISOString(),
        },
        { onConflict: 'endpoint' },
      )
      if (error) console.error('push_subscriptions upsert', error)
    } catch (err) {
      console.error('sync push subscription failed', err)
    }
  }, [notifPerm, session?.user?.id, supabase])

  useEffect(() => {
    if (notifPerm !== 'granted') return
    void syncPushSubscription()
  }, [notifPerm, session?.user?.id, syncPushSubscription])

  const handleIncomingPing = useCallback(
    (row, targetUserId) => {
      if (!row || !targetUserId) return
      if (row.to_user_id !== targetUserId) return
      const pingId = typeof row.id === 'string' ? row.id : ''
      if (pingId && seenPingIdsRef.current.has(pingId)) return
      if (pingId) {
        seenPingIdsRef.current.add(pingId)
        // Keep dedupe memory bounded for long-running sessions.
        if (seenPingIdsRef.current.size > 300) {
          const ids = [...seenPingIdsRef.current]
          seenPingIdsRef.current = new Set(ids.slice(-180))
        }
      }
      const createdAt = typeof row.created_at === 'string' ? row.created_at : ''
      if (createdAt && (!lastPingAtRef.current || createdAt > lastPingAtRef.current)) {
        lastPingAtRef.current = createdAt
      }
      const sender = (row.from_name || '').trim() || 'Someone'
      const body = (row.message || '').trim() || `${sender} pinged you`
      showToast(`📣 Ping from ${sender}`, { timeoutMs: 5200 })
      sendBrowserNotif(`Ping from ${sender}`, body)
      playChime('ping')
      if (!document.hasFocus()) setUnread((u) => u + 1)
    },
    [showToast, sendBrowserNotif],
  )

  const handleDiff = useCallback(
    (prev, next, me) => {
      if (!setupDoneRef.current || !me) return
      const prevIds = new Set(prev.map((t) => t.id))
      const freshIds = new Set()

      next.forEach((t) => {
        if (t.by === me) return

        if (!prevIds.has(t.id)) {
          freshIds.add(t.id)
          const assignHint = t.assignedTo.length ? ` → ${formatAssignees(t.assignedTo)}` : ''
          const msg = `📋 ${t.by} added: "${t.text}"${assignHint}`
          showToast(msg)
          sendBrowserNotif(`${t.by} added a task`, t.text)
          playChime('add')
          if (!document.hasFocus()) setUnread((u) => u + 1)
        }
      })

      next.forEach((t) => {
        const old = prev.find((p) => p.id === t.id)
        if (!old) return

        if (!old.done && t.done && t.doneBy && t.doneBy !== me) {
          showToast(`✅ ${t.doneBy} completed: "${t.text}"`)
          sendBrowserNotif(`${t.doneBy} completed a task`, t.text)
          playChime('done')
          if (!document.hasFocus()) setUnread((u) => u + 1)
        }

        if (!old.assignedTo.includes(me) && t.assignedTo.includes(me) && t.by !== me) {
          showToast(`👤 ${t.by} assigned you: "${t.text}"`)
          sendBrowserNotif('Task assigned to you', t.text)
          playChime('add')
          if (!document.hasFocus()) setUnread((u) => u + 1)
        }
      })

      if (freshIds.size > 0) setNewIds((ids) => new Set([...ids, ...freshIds]))
      if (freshIds.size > 0) {
        setTimeout(() => {
          setNewIds((ids) => {
            const s = new Set(ids)
            freshIds.forEach((id) => s.delete(id))
            return s
          })
        }, 700)
      }
    },
    [showToast, sendBrowserNotif],
  )

  async function requestNotif() {
    if (!('Notification' in window)) return
    const perm = await Notification.requestPermission()
    setNotifPerm(perm)
    if (perm === 'granted') await syncPushSubscription()
  }

  const continueAsGuest = useCallback(async () => {
    if (!supabase) return { ok: false, message: 'App is not connected.' }
    const { data: { session: s0 } } = await supabase.auth.getSession()
    if (s0?.user) return { ok: true }
    const { error } = await supabase.auth.signInAnonymously()
    if (error) return { ok: false, message: error.message || String(error) }
    const { data: { session: s1 } } = await supabase.auth.getSession()
    if (!s1?.user) {
      return { ok: false, message: 'No session after anonymous sign-in.' }
    }
    return { ok: true }
  }, [supabase])

  const loadMembers = useCallback(async (rid) => {
    if (!supabase) return
    const { data, error } = await supabase
      .from('room_members')
      .select('user_id, display_name')
      .eq('room_id', rid)
    if (error) return
    const rows = data || []
    const detail = rows.map((r) => ({
      userId: r.user_id,
      name: memberLabelFromRow(r),
    }))
    detail.sort((a, b) => a.name.localeCompare(b.name))
    setMembersDetail(detail)
    setMembers([...new Set(detail.map((d) => d.name))])
  }, [])

  const loadMyLists = useCallback(async () => {
    if (!supabase) return
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      setMyLists([])
      return
    }
    setMyListsLoading(true)
    const { data, error } = await supabase
      .from('room_members')
      .select('room_id, display_name, rooms(join_code, title)')
      .eq('user_id', user.id)
    setMyListsLoading(false)
    if (error) {
      console.error('loadMyLists', error)
      return
    }
    const rows = (data || [])
      .map((r) => {
        const rel = r.rooms
        const joinCode =
          rel && typeof rel === 'object' && !Array.isArray(rel)
            ? rel.join_code
            : Array.isArray(rel) && rel[0]
              ? rel[0].join_code
              : ''
        const listTitle =
          rel && typeof rel === 'object' && !Array.isArray(rel)
            ? rel.title
            : Array.isArray(rel) && rel[0]
              ? rel[0].title
              : ''
        return {
          roomId: r.room_id,
          joinCode: joinCode || '',
          listTitle: typeof listTitle === 'string' ? listTitle : '',
          displayName: (r.display_name || '').trim(),
        }
      })
      .filter((x) => x.roomId && x.joinCode)
    rows.sort((a, b) => {
      const ta = (a.listTitle || '').trim().toLowerCase()
      const tb = (b.listTitle || '').trim().toLowerCase()
      if (ta !== tb) return ta.localeCompare(tb)
      return a.joinCode.localeCompare(b.joinCode)
    })
    setMyLists(rows)
  }, [supabase])

  useEffect(() => {
    if (!authReady || !supabaseConfigured || !supabase) return
    if (!session) {
      setMyLists([])
      setMyListsLoading(false)
      return
    }
    if (roomId && !setupPhase) return
    loadMyLists()
  }, [authReady, session?.user?.id, roomId, setupPhase, loadMyLists, supabase, supabaseConfigured])

  useEffect(() => {
    if (!supabase) {
      setAuthReady(true)
      return
    }
    let cancelled = false

    supabase.auth
      .getSession()
      .then(({ data: { session: s }, error }) => {
        if (cancelled) return
        if (error) setAuthError(error.message || String(error))
        else setAuthError(null)
        setSession(s ?? null)
        setAuthReady(true)
      })
      .catch((e) => {
        if (cancelled) return
        setAuthError(e?.message ? String(e.message) : String(e))
        setAuthReady(true)
      })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s ?? null)
      setAuthError(null)
    })

    return () => {
      cancelled = true
      subscription.unsubscribe()
    }
  }, [supabase])

  const loadTasks = useCallback(async () => {
    const rid = roomIdRef.current
    if (!rid || !supabaseConfigured || !supabase) return
    const { data, error } = await supabase
      .from('tasks')
      .select('*')
      .eq('room_id', rid)
      .order('created_at', { ascending: true })
    if (error) return
    const next = (data || []).map(mapRow)
    setTasks(() => {
      handleDiff(prevTasksRef.current, next, myNameRef.current)
      prevTasksRef.current = next
      return next
    })
  }, [handleDiff])

  const persistMyName = useCallback(
    async (name) => {
      if (!supabase) return
      const rid = roomIdRef.current
      if (!rid || !name.trim()) return
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return
      await supabase
        .from('room_members')
        .update({ display_name: name.trim() })
        .eq('room_id', rid)
        .eq('user_id', user.id)
      await loadMembers(rid)
    },
    [loadMembers],
  )

  const leaveRoom = useCallback(() => {
    setupDoneRef.current = false
    roomIdRef.current = ''
    localStorage.removeItem(LS_ROOM)
    localStorage.removeItem(LS_JOIN)
    setRoomId('')
    setJoinCodeDisplay('')
    setRoomTitle('')
    setNewListTitle('')
    setMembers([])
    setMembersDetail([])
    setTasks([])
    prevTasksRef.current = []
    setSetupPhase(false)
    setSettingsOpen(false)
    setIsRoomCreator(false)
    setCustomCodeMsg('')
    setListTitleMsg('')
    setPingingUserId('')
    pingCooldownRef.current = new Map()
    seenPingIdsRef.current = new Set()
    lastPingAtRef.current = ''
  }, [])

  const leaveListFlightRef = useRef(false)
  const confirmLeaveList = useCallback(async () => {
    if (leaveListFlightRef.current) return
    if (!supabase || !roomId) {
      leaveRoom()
      return
    }
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      leaveRoom()
      return
    }
    leaveListFlightRef.current = true
    setLeaveListBusy(true)
    const rid = roomId
    let error = null
    try {
      const res = await supabase
        .from('room_members')
        .delete()
        .eq('room_id', rid)
        .eq('user_id', user.id)
      error = res.error
    } finally {
      leaveListFlightRef.current = false
      setLeaveListBusy(false)
    }
    if (error) {
      console.error('leave list', error)
      showToast(
        error.code === '42501' || /row-level security|RLS|permission denied/i.test(error.message || '')
          ? 'Could not leave — run the latest Supabase migration (room title + leave).'
          : `Could not leave: ${error.message || 'Unknown error'}`,
      )
      return
    }
    roomIdRef.current = ''
    leaveRoom()
    showToast('You left the list')
  }, [supabase, roomId, leaveRoom, showToast])

  useEffect(() => {
    if (!authReady || !roomId || !supabaseConfigured || setupPhase || !supabase) return
    const ridAtStart = roomId
    setupDoneRef.current = Boolean(myName.trim())
    const chRef = { current: null }
    const pollTimerRef = { current: null }
    let cancelled = false

    ;(async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (cancelled || roomIdRef.current !== ridAtStart) return
      if (!user) return

      let mem = null
      for (let attempt = 0; attempt < 10; attempt++) {
        const { data, error } = await supabase
          .from('room_members')
          .select('user_id')
          .eq('room_id', ridAtStart)
          .eq('user_id', user.id)
          .maybeSingle()
        if (error) {
          console.error('room_members check', error)
          if (!cancelled && roomIdRef.current === ridAtStart) {
            showToast(`Could not verify list: ${error.message}`)
          }
          return
        }
        mem = data
        if (mem) break
        await new Promise((r) => setTimeout(r, 100))
        if (cancelled || roomIdRef.current !== ridAtStart) return
      }

      if (cancelled || roomIdRef.current !== ridAtStart) return

      if (!mem) {
        showToast('This browser is no longer on the list — join again with your room code.')
        if (!cancelled && roomIdRef.current === ridAtStart) leaveRoom()
        return
      }

      if (myName.trim()) await persistMyName(myName)
      if (cancelled || roomIdRef.current !== ridAtStart) return

      await loadMembers(ridAtStart)
      if (cancelled || roomIdRef.current !== ridAtStart) return

      const { data: roomRow } = await supabase
        .from('rooms')
        .select('join_code, creator_user_id, title')
        .eq('id', ridAtStart)
        .maybeSingle()
      if (!cancelled && roomIdRef.current === ridAtStart && roomRow?.join_code) {
        setJoinCodeDisplay(roomRow.join_code)
        localStorage.setItem(LS_JOIN, roomRow.join_code)
      }
      if (!cancelled && roomIdRef.current === ridAtStart) {
        setRoomTitle(typeof roomRow?.title === 'string' ? roomRow.title : '')
      }
      const { data: { user: roomUser } } = await supabase.auth.getUser()
      const roomUserId = roomUser?.id || ''
      if (!roomUserId) return
      if (!cancelled && roomIdRef.current === ridAtStart) {
        setIsRoomCreator(
          Boolean(
            roomUserId &&
              roomRow?.creator_user_id &&
              roomUserId === roomRow.creator_user_id,
          ),
        )
      }

      seenPingIdsRef.current = new Set()
      lastPingAtRef.current = new Date().toISOString()

      const pollForPings = async () => {
        if (cancelled || roomIdRef.current !== ridAtStart) return
        const since = lastPingAtRef.current || new Date(0).toISOString()
        const { data: pingRows, error: pingErr } = await supabase
          .from('member_pings')
          .select('id, to_user_id, from_name, message, created_at')
          .eq('room_id', ridAtStart)
          .eq('to_user_id', roomUserId)
          .gt('created_at', since)
          .order('created_at', { ascending: true })
          .limit(24)
        if (pingErr) return
        ;(pingRows || []).forEach((row) => handleIncomingPing(row, roomUserId))
      }

      await loadTasks()
      if (cancelled || roomIdRef.current !== ridAtStart) return

      await pollForPings()
      if (cancelled || roomIdRef.current !== ridAtStart) return
      pollTimerRef.current = window.setInterval(pollForPings, 5000)

      chRef.current = supabase
        .channel(`room-sync:${ridAtStart}`)
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'tasks',
            filter: `room_id=eq.${ridAtStart}`,
          },
          () => {
            loadTasks()
          },
        )
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'room_members',
            filter: `room_id=eq.${ridAtStart}`,
          },
          () => {
            loadMembers(ridAtStart)
          },
        )
        .on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: 'member_pings',
            filter: `room_id=eq.${ridAtStart}`,
          },
          (payload) => {
            const row = payload?.new
            handleIncomingPing(row, roomUserId)
          },
        )
        .subscribe()
    })()

    return () => {
      cancelled = true
      const c = chRef.current
      chRef.current = null
      if (c && supabase) supabase.removeChannel(c)
      if (pollTimerRef.current) window.clearInterval(pollTimerRef.current)
    }
  }, [
    authReady,
    session?.user?.id,
    roomId,
    setupPhase,
    myName,
    loadTasks,
    persistMyName,
    loadMembers,
    handleIncomingPing,
    showToast,
    leaveRoom,
  ])

  function beginSetup() {
    setSetupPhase(true)
    setNameIn(myName || '')
  }

  async function handleSignIn(ev) {
    ev?.preventDefault?.()
    if (!supabase) return
    const email = emailIn.trim()
    if (!email || !passwordIn) {
      setAccountError('Enter email and password.')
      return
    }
    setAccountBusy(true)
    setAccountError('')
    setAccountSuccess('')
    const { error } = await supabase.auth.signInWithPassword({ email, password: passwordIn })
    setAccountBusy(false)
    if (error) {
      setAccountError(error.message || 'Could not sign in')
      return
    }
    setPasswordIn('')
  }

  async function handleSignUp(ev) {
    ev?.preventDefault?.()
    if (!supabase) return
    const email = emailIn.trim()
    if (!email || passwordIn.length < 6) {
      setAccountError('Use a valid email and a password of at least 6 characters.')
      return
    }
    setAccountBusy(true)
    setAccountError('')
    setAccountSuccess('')
    const { data, error } = await supabase.auth.signUp({ email, password: passwordIn })
    setAccountBusy(false)
    if (error) {
      setAccountError(error.message || 'Could not sign up')
      return
    }
    setPasswordIn('')
    if (data.session) {
      setAccountSuccess('')
    } else {
      setAccountSuccess(
        'Check your email for a confirmation link (if required by your project), then sign in here.',
      )
    }
  }

  async function handleForgotPassword() {
    if (!supabase) return
    const email = emailIn.trim()
    if (!email) {
      setAccountError('Enter your email, then tap forgot password again.')
      return
    }
    setAccountBusy(true)
    setAccountError('')
    setAccountSuccess('')
    const origin = `${window.location.origin}${window.location.pathname || '/'}`
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: origin })
    setAccountBusy(false)
    if (error) setAccountError(error.message || 'Could not send reset email')
    else setAccountSuccess('If that address has an account, a reset link was sent.')
  }

  async function handleContinueGuest() {
    setAccountBusy(true)
    setAccountError('')
    setAccountSuccess('')
    const r = await continueAsGuest()
    setAccountBusy(false)
    if (!r.ok) {
      setAccountError(
        `${r.message || 'Guest sign-in failed'} Turn on Anonymous under Authentication → Providers in Supabase, or use email.`,
      )
    }
  }

  async function handleSignOut() {
    if (!supabase) return
    setSettingsOpen(false)
    setMyLists([])
    await supabase.auth.signOut()
    leaveRoom()
  }

  async function openExistingList(entry) {
    if (!supabase) return
    setRoomError('')
    setRoomTitle('')
    const resolved =
      nameIn.trim() ||
      entry.displayName ||
      (typeof localStorage !== 'undefined' ? localStorage.getItem(LS_NAME) : '') ||
      ''
    if (!resolved.trim()) {
      setRoomError('Enter your display name in the box below, then open the list again.')
      return
    }
    const name = resolved.trim()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return
    const rid = entry.roomId
    const code = entry.joinCode
    localStorage.setItem(LS_ROOM, rid)
    localStorage.setItem(LS_JOIN, code)
    localStorage.setItem(LS_NAME, name)
    setRoomId(rid)
    setJoinCodeDisplay(code)
    setMyName(name)
    myNameRef.current = name
    roomIdRef.current = rid
    setupDoneRef.current = true
    setSetupPhase(false)
    setJoinCodeIn('')
    await supabase
      .from('room_members')
      .update({ display_name: name })
      .eq('room_id', rid)
      .eq('user_id', user.id)
    prevTasksRef.current = []
    setTasks([])
  }

  async function handleCreateRoom() {
    if (!nameIn.trim() || !supabase) return
    setRoomBusy(true)
    setRoomError('')
    try {
      const { data: { session: s } } = await supabase.auth.getSession()
      if (!s?.user) {
        setRoomError('Sign in with email (or continue as guest) before creating a list.')
        return
      }
      const { data, error } = await supabase.rpc('create_room')
      if (error) {
        console.error('create_room', error)
        const hint =
          /permission denied|function public.create_room|not authenticated/i.test(
            error.message || '',
          )
            ? ' Check that the SQL migration ran and Anonymous sign-in is enabled.'
            : ''
        setRoomError((error.message || 'Could not create list') + hint)
        return
      }
      const row = Array.isArray(data) ? data[0] : data
      const rid = row?.room_id
      const code = row?.join_code
      if (!rid || !code) {
        setRoomError('Unexpected response from server')
        return
      }
      localStorage.setItem(LS_ROOM, rid)
      localStorage.setItem(LS_JOIN, code)
      localStorage.setItem(LS_NAME, nameIn.trim())
      setRoomId(rid)
      setJoinCodeDisplay(code)
      setMyName(nameIn.trim())
      myNameRef.current = nameIn.trim()
      roomIdRef.current = rid
      setupDoneRef.current = true
      setSetupPhase(false)
      await persistMyName(nameIn.trim())
      const title = newListTitle.trim()
      if (title) {
        const { error: titleErr } = await supabase.rpc('set_room_title', {
          p_room_id: rid,
          p_title: title,
        })
        if (!titleErr) setRoomTitle(title)
      } else {
        setRoomTitle('')
      }
      setNewListTitle('')
      prevTasksRef.current = []
      setTasks([])
    } finally {
      setRoomBusy(false)
    }
  }

  async function handleJoinRoom() {
    if (!nameIn.trim() || !joinCodeIn.trim() || !supabase) return
    setRoomBusy(true)
    setRoomError('')
    const { data: { session: s } } = await supabase.auth.getSession()
    if (!s?.user) {
      setRoomBusy(false)
      setRoomError('Sign in with email (or continue as guest) before joining.')
      return
    }
    const { data: rid, error } = await supabase.rpc('join_room', {
      p_code: joinCodeIn.trim(),
    })
    setRoomBusy(false)
    if (error) {
      setRoomError(error.message === 'invalid code' ? 'Invalid code' : error.message)
      return
    }
    setRoomTitle('')
    const joinedCode = joinCodeIn.trim().toUpperCase()
    localStorage.setItem(LS_ROOM, rid)
    localStorage.setItem(LS_JOIN, joinedCode)
    localStorage.setItem(LS_NAME, nameIn.trim())
    setRoomId(rid)
    setJoinCodeDisplay(joinedCode)
    setMyName(nameIn.trim())
    myNameRef.current = nameIn.trim()
    roomIdRef.current = rid
    setupDoneRef.current = true
    setSetupPhase(false)
    setJoinCodeIn('')
    await persistMyName(nameIn.trim())
    prevTasksRef.current = []
    setTasks([])
  }

  function cancelSetup() {
    setRoomError('')
    setSetupPhase(false)
    setNameIn('')
    setJoinCodeIn('')
  }

  function openListSettings() {
    setCustomCodeDraft(joinCodeDisplay || '')
    setCustomCodeMsg('')
    setListTitleDraft(roomTitle)
    setListTitleMsg('')
    setSettingsOpen(true)
  }

  async function handleSaveListTitle() {
    if (!supabase || !roomId) return
    setListTitleBusy(true)
    setListTitleMsg('')
    const { error } = await supabase.rpc('set_room_title', {
      p_room_id: roomId,
      p_title: listTitleDraft,
    })
    setListTitleBusy(false)
    if (error) {
      setListTitleMsg(error.message || 'Could not save name')
      return
    }
    const next = listTitleDraft.trim()
    setRoomTitle(next)
    setListTitleMsg('Saved.')
  }

  async function copyJoinCode() {
    const c = joinCodeDisplay || ''
    if (!c) return
    try {
      await navigator.clipboard.writeText(c)
      showToast('Code copied')
    } catch {
      showToast(`Code: ${c}`)
    }
  }

  async function sendPing(toUserId, toName) {
    if (!supabase || !roomId || !toUserId || !toName) return
    const fromUserId = session?.user?.id
    if (!fromUserId || fromUserId === toUserId) return
    const now = Date.now()
    const lastAt = pingCooldownRef.current.get(toUserId) || 0
    if (now - lastAt < 6000) {
      showToast(`Give ${toName} a moment before pinging again`)
      return
    }
    setPingingUserId(toUserId)
    const { error } = await supabase.from('member_pings').insert({
      room_id: roomId,
      from_user_id: fromUserId,
      to_user_id: toUserId,
      from_name: myName,
      message: `${myName} pinged you`,
    })
    setPingingUserId('')
    if (error) {
      console.error('sendPing', error)
      const msg = error.message || ''
      const missingMigration =
        error.code === '42P01' ||
        /member_pings/i.test(msg) &&
          (/does not exist|schema cache|not found|relation/i.test(msg))
      const rls =
        error.code === '42501' ||
        /row-level security|RLS|permission denied|not a member/i.test(msg)
      if (missingMigration) {
        showToast('Ping setup missing — run the latest Supabase migration for member pings.')
      } else if (rls) {
        showToast('Could not send ping — rejoin this list with your code, then retry.')
      } else {
        showToast(`Could not send ping: ${msg || error.code || 'unknown error'}`)
      }
      return
    }
    pingCooldownRef.current.set(toUserId, now)
    void supabase.functions
      .invoke('send-member-ping-push', {
        body: {
          toUserId,
          roomId,
          fromName: myName,
          message: `${myName} pinged you`,
        },
      })
      .then(({ error: pushErr }) => {
        if (pushErr) console.error('sendPing push invoke', pushErr)
      })
    showToast(`📣 Pinged ${toName}`)
  }

  async function handleApplyCustomCode() {
    if (!supabase || !roomId || !customCodeDraft.trim()) return
    setCustomCodeBusy(true)
    setCustomCodeMsg('')
    const { data: newCode, error } = await supabase.rpc('change_join_code', {
      p_room_id: roomId,
      p_new_code: customCodeDraft.trim(),
    })
    setCustomCodeBusy(false)
    if (error) {
      setCustomCodeMsg(error.message || 'Could not update code')
      return
    }
    const code = typeof newCode === 'string' ? newCode : String(newCode ?? '')
    setJoinCodeDisplay(code)
    localStorage.setItem(LS_JOIN, code)
    setCustomCodeMsg('Updated. Everyone must use this new code to open the list.')
    setCustomCodeDraft(code)
  }

  async function addTask() {
    if (!addIn.trim() || !roomId || !supabase) return
    const assigned = encodeAssignees(assignTo)
    const row = {
      room_id: roomId,
      text: addIn.trim(),
      created_by: myName,
      assigned_to: assigned,
      done: false,
      done_by: null,
    }
    const { error } = await supabase.from('tasks').insert(row)
    if (error) {
      console.error('addTask', error)
      const rls =
        error.code === '42501' ||
        /row-level security|RLS|permission denied/i.test(error.message || '')
      showToast(
        rls
          ? 'Not allowed to add tasks here — join the list again with your room code (session changed).'
          : `Could not add task: ${error.message || error.code || 'unknown error'}`,
      )
      return
    }
    setAddIn('')
    addRef.current?.focus()
    await loadTasks()
  }

  async function setTaskDone(id, nextDone, doneBy = null) {
    if (!supabase) return false
    const payload = nextDone
      ? { done: true, done_by: doneBy || myName, updated_at: new Date().toISOString() }
      : { done: false, done_by: null, updated_at: new Date().toISOString() }
    const { error } = await supabase.from('tasks').update(payload).eq('id', id)
    if (error) {
      showToast('Could not update task')
      return false
    }
    await loadTasks()
    return true
  }

  async function toggleDone(id) {
    const t = tasks.find((x) => x.id === id)
    if (!t) return
    const nextDone = !t.done
    const ok = await setTaskDone(id, nextDone, myName)
    if (!ok) return
    showToast(nextDone ? 'Marked done' : 'Marked active', {
      actionLabel: 'Undo',
      timeoutMs: UNDO_TOAST_MS,
      onAction: async () => {
        const restoredDoneBy = t.done ? t.doneBy || myName : null
        const reverted = await setTaskDone(id, t.done, restoredDoneBy)
        if (!reverted) showToast('Could not undo')
      },
    })
  }

  async function updateAssigned(id, values) {
    if (!supabase) return
    const assigned = encodeAssignees(values)
    const { error } = await supabase
      .from('tasks')
      .update({ assigned_to: assigned, updated_at: new Date().toISOString() })
      .eq('id', id)
    if (error) {
      showToast('Could not update assignee')
      return
    }
    await loadTasks()
  }

  async function toggleTaskAssignee(id, name) {
    const t = tasks.find((x) => x.id === id)
    if (!t) return
    const hasName = t.assignedTo.includes(name)
    const next = hasName ? t.assignedTo.filter((x) => x !== name) : [...t.assignedTo, name]
    await updateAssigned(id, next)
  }

  async function delTask(id) {
    if (!supabase) return
    const t = tasks.find((x) => x.id === id)
    const { error } = await supabase.from('tasks').delete().eq('id', id)
    if (error) {
      showToast('Could not delete')
      return
    }
    await loadTasks()
    if (!t || !roomId) return
    showToast('Task deleted', {
      actionLabel: 'Undo',
      timeoutMs: UNDO_TOAST_MS,
      onAction: async () => {
        const restoreRow = {
          room_id: roomId,
          text: t.text,
          created_by: t.by,
          assigned_to: encodeAssignees(t.assignedTo),
          done: t.done,
          done_by: t.doneBy || null,
        }
        const { error: restoreErr } = await supabase.from('tasks').insert(restoreRow)
        if (restoreErr) {
          showToast('Could not undo delete')
          return
        }
        await loadTasks()
      },
    })
  }

  async function markAllDone() {
    if (!supabase || !roomId || bulkBusy) return
    setBulkBusy(true)
    const { data, error } = await supabase
      .from('tasks')
      .update({
        done: true,
        done_by: myName,
        updated_at: new Date().toISOString(),
      })
      .eq('room_id', roomId)
      .eq('done', false)
      .select('id')
    setBulkBusy(false)
    if (error) {
      showToast('Could not mark all done')
      return
    }
    await loadTasks()
    const count = Array.isArray(data) ? data.length : 0
    showToast(
      count > 0
        ? `Marked ${count} task${count === 1 ? '' : 's'} done`
        : 'Everything is already done',
    )
  }

  async function clearDoneTasks() {
    if (!supabase || !roomId || bulkBusy) return
    setBulkBusy(true)
    const { data, error } = await supabase
      .from('tasks')
      .delete()
      .eq('room_id', roomId)
      .eq('done', true)
      .select('id')
    setBulkBusy(false)
    if (error) {
      showToast('Could not clear done tasks')
      return
    }
    await loadTasks()
    const count = Array.isArray(data) ? data.length : 0
    showToast(
      count > 0
        ? `Cleared ${count} done task${count === 1 ? '' : 's'}`
        : 'No done tasks to clear',
    )
  }

  const isMe = (n) => n === myName

  const uniqueAssign = [...new Set([...members, myName].filter(Boolean))].sort((a, b) =>
    a.localeCompare(b),
  )

  const myUserId = session?.user?.id
  const othersLabel =
    membersDetail.filter((m) => m.userId !== myUserId).map((m) => m.name).join(', ') || 'your group'

  const vis = tasks.filter((t) => {
    if (filter === 'done') return t.done
    if (filter === 'mine') return t.by === myName && !t.done
    if (filter === 'forme') return t.assignedTo.includes(myName) && !t.done
    return !t.done
  })

  const active = filter === 'done' ? [] : vis
  const done = filter === 'done' ? vis : []
  const hasDoneTasks = tasks.some((t) => t.done)
  const hasOpenTasks = tasks.some((t) => !t.done)
  const pct = tasks.length
    ? Math.round((tasks.filter((t) => t.done).length / tasks.length) * 100)
    : 0

  if (!supabaseConfigured) {
    const invalid =
      supabaseEnvPresent &&
      'Supabase URL or anon key is set but failed to initialize. Fix the values below (common: smart quotes, line breaks inside the JWT, or the secret name pasted into the value). Use Repository secrets (Settings → Secrets and variables → Actions), not only the Pages environment.'
    const missing =
      'In the project folder, copy .env.example to .env. In Supabase: Project Settings → API, set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY, then restart npm run dev. For the live site, set the same names in the GitHub repository Actions secrets and redeploy.'
    return (
      <div className="app">
        <div className="setup-screen">
          <div className="config-missing">
            <p>{invalid || missing}</p>
            {supabaseInitError && (
              <pre
                style={{
                  marginTop: 14,
                  textAlign: 'left',
                  fontSize: 12,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  color: '#c9a0a0',
                }}
              >
                {supabaseInitError}
              </pre>
            )}
          </div>
        </div>
      </div>
    )
  }

  if (!authReady) {
    return (
      <div className="app">
        <div className="setup-screen">
          <div className="setup-label">Connecting…</div>
        </div>
      </div>
    )
  }

  if (authError) {
    return (
      <div className="app">
        <div className="setup-screen">
          <div className="config-missing">
            <p style={{ marginBottom: 12 }}>{authError}</p>
            <button type="button" className="setup-go" onClick={() => window.location.reload()}>
              Reload page
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (!session || !roomId || setupPhase) {
    const sessionEmail = session?.user?.email
    const isGuestSession = Boolean(session?.user && !sessionEmail)

    return (
      <div className="app">
        <div className="setup-screen home-screen">
          <div>
            <div className="header-date" style={{ textAlign: 'center', marginBottom: 10 }}>
              {dateStr()}
            </div>
            <div className="setup-label">
              {!session ? (
                <>
                  Sign in <em>first</em>
                </>
              ) : (
                <>
                  Your <em>lists</em>
                </>
              )}
            </div>
          </div>

          {!session ? (
            <>
              <p className="setup-sub">
                Use the same email on every device so you show up once on each list. After you sign in,
                pick a display name, then create or join a list.
              </p>
              <form
                className="setup-fields account-form"
                onSubmit={(e) => {
                  e.preventDefault()
                  handleSignIn(e)
                }}
              >
                <input
                  className="setup-input"
                  type="email"
                  autoComplete="email"
                  placeholder="Email"
                  value={emailIn}
                  autoFocus
                  onChange={(e) => {
                    setEmailIn(e.target.value)
                    setAccountError('')
                    setAccountSuccess('')
                  }}
                />
                <input
                  className="setup-input"
                  type="password"
                  autoComplete="current-password"
                  placeholder="Password"
                  value={passwordIn}
                  onChange={(e) => {
                    setPasswordIn(e.target.value)
                    setAccountError('')
                  }}
                />
                <div className="setup-row-btns">
                  <button type="submit" className="setup-go" disabled={accountBusy}>
                    Sign in
                  </button>
                  <button
                    type="button"
                    className="setup-go secondary"
                    disabled={accountBusy}
                    onClick={handleSignUp}
                  >
                    Create account
                  </button>
                </div>
                <button
                  type="button"
                  className="switch-link"
                  disabled={accountBusy}
                  onClick={handleForgotPassword}
                >
                  Forgot password?
                </button>
                <p className="setup-sub" style={{ marginTop: 8 }}>
                  Or continue without email (same device only; enable Anonymous in Supabase):
                </p>
                <button
                  type="button"
                  className="setup-go secondary"
                  disabled={accountBusy}
                  onClick={handleContinueGuest}
                >
                  Continue as guest
                </button>
                {accountError && (
                  <p className="setup-sub" style={{ color: '#c0392b', marginTop: 8 }}>
                    {accountError}
                  </p>
                )}
                {accountSuccess && (
                  <p className="setup-sub" style={{ color: '#8CB4D4', marginTop: 8 }}>
                    {accountSuccess}
                  </p>
                )}
              </form>
            </>
          ) : (
            <>
              <div className="home-session-bar">
                <p className="home-session-email">
                  Signed in as <strong>{sessionEmail || 'Guest (this device only)'}</strong>
                </p>
                <button
                  type="button"
                  className="setup-go secondary home-signout-btn"
                  onClick={handleSignOut}
                >
                  Sign out
                </button>
              </div>

              <div className="home-lists-section">
                <p className="home-lists-heading">Lists you&apos;re on</p>
                {myListsLoading && (
                  <p className="setup-sub home-lists-status">Loading your lists…</p>
                )}
                {!myListsLoading && myLists.length === 0 && (
                  <p className="setup-sub home-lists-status">
                    {isGuestSession
                      ? 'Guest mode keeps lists on this browser only. Use email sign-in to see the same lists on every device.'
                      : 'No lists yet — create one or join with a code below.'}
                  </p>
                )}
                {!myListsLoading && myLists.length > 0 && (
                  <ul className="home-lists-ul" aria-label="Lists you belong to">
                    {myLists.map((row) => (
                      <li key={row.roomId}>
                        <button
                          type="button"
                          className="home-list-open"
                          onClick={() => openExistingList(row)}
                        >
                          <span className="home-list-title">
                            {(row.listTitle || '').trim() || 'Untitled list'}
                          </span>
                          <span className="home-list-code-row">
                            Code <span className="home-list-code-mono">{row.joinCode}</span>
                          </span>
                          <span className="home-list-as">
                            {row.displayName ? `You as ${row.displayName}` : 'Tap to open — add your display name below if needed'}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <hr className="home-divider" />

              <p className="setup-sub">
                Display name is how others see you. Create a list and share its code, or join with someone
                else&apos;s code. Notifications can alert you when the list changes.
              </p>
              <div className="setup-fields">
                <input
                  className="setup-input"
                  placeholder="Your display name"
                  value={nameIn}
                  onChange={(e) => setNameIn(e.target.value)}
                  maxLength={24}
                  autoFocus
                />
                <input
                  className="setup-input"
                  placeholder="List name (optional — only when you tap New list)"
                  value={newListTitle}
                  onChange={(e) => setNewListTitle(e.target.value)}
                  maxLength={48}
                />
                <div className="setup-row-btns">
                  <button
                    type="button"
                    className="setup-go"
                    disabled={roomBusy || !nameIn.trim()}
                    onClick={handleCreateRoom}
                  >
                    New list
                  </button>
                </div>
                <input
                  className="setup-input"
                  placeholder="Join code (6 letters)"
                  value={joinCodeIn}
                  onChange={(e) => setJoinCodeIn(e.target.value.toUpperCase())}
                  onKeyDown={(e) => e.key === 'Enter' && handleJoinRoom()}
                  maxLength={8}
                />
                <button
                  type="button"
                  className="setup-go secondary"
                  disabled={roomBusy || !nameIn.trim() || !joinCodeIn.trim()}
                  onClick={handleJoinRoom}
                >
                  Join with code
                </button>
                {roomId && (
                  <button type="button" className="switch-link" onClick={cancelSetup}>
                    ← Back to list
                  </button>
                )}
                {roomError && (
                  <p className="setup-sub" style={{ color: '#c0392b', marginTop: 4 }}>
                    {roomError}
                  </p>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="toast-wrap">
        {toasts.map((t) => (
          <div key={t.id} className="toast">
            <span>{t.msg}</span>
            {t.actionLabel && t.onAction && (
              <button
                type="button"
                className="toast-action"
                onClick={async () => {
                  dismissToast(t.id)
                  await t.onAction()
                }}
              >
                {t.actionLabel}
              </button>
            )}
          </div>
        ))}
      </div>

      <div className="app">
        <div className="header">
          <div className="header-top">
            <div className="header-left-block">
              <div className="header-date">{dateStr()}</div>
              <h1 className="header-title">
                Today&apos;s <em>list</em>
              </h1>
              {(roomTitle || '').trim() ? (
                <p className="header-list-subtitle">{(roomTitle || '').trim()}</p>
              ) : null}
            </div>
            <div className="header-right">
              <div className="who-badge">
                <span className="who-name">{myName}</span>
              </div>
              <button type="button" className="settings-btn" onClick={openListSettings}>
                List info
              </button>
              <button
                type="button"
                className="leave-list-btn"
                disabled={leaveListBusy}
                onClick={confirmLeaveList}
              >
                {leaveListBusy ? 'Leaving…' : 'Leave list'}
              </button>
              <button
                type="button"
                className="switch-link"
                onClick={() => {
                  setupDoneRef.current = false
                  beginSetup()
                }}
              >
                switch list / name
              </button>
              <button type="button" className="switch-link" onClick={handleSignOut}>
                sign out
              </button>
            </div>
          </div>
        </div>

        {joinCodeDisplay ? (
          <div className="room-banner">
            {(roomTitle || '').trim() ? (
              <>
                <span className="room-banner-title">{(roomTitle || '').trim()}</span>
                <span className="room-banner-meta">
                  {' '}
                  · Share code: <strong>{joinCodeDisplay}</strong>
                </span>
              </>
            ) : (
              <>
                Share code: <strong>{joinCodeDisplay}</strong>
              </>
            )}
            <span className="hint">
              Tap <strong>List info</strong> to set a list name, copy the code, or change the code (creator). Others
              join under &quot;Join with code&quot; on the home screen.
            </span>
          </div>
        ) : (
          <div className="room-banner">
            <span className="hint">Loading share code… If it stays blank, open List info after a moment.</span>
          </div>
        )}

        {membersDetail.length > 0 && (
          <div className="members-bar" aria-label="People on this list">
            <span className="members-bar-label">On this list (tap a person to ping)</span>
            <div className="members-bar-chips">
              {membersDetail.map((m) =>
                m.userId === myUserId ? (
                  <span key={m.userId} className="member-chip member-chip-me">
                    {m.name} (you)
                  </span>
                ) : (
                  <button
                    type="button"
                    key={m.userId}
                    className="member-chip pingable"
                    disabled={pingingUserId === m.userId}
                    onClick={() => sendPing(m.userId, m.name)}
                  >
                    {m.name}
                  </button>
                ),
              )}
            </div>
          </div>
        )}

        {notifPerm === 'default' && (
          <div className="notif-bar">
            <span>🔔 Get alerts when {othersLabel} updates the list</span>
            <button type="button" onClick={requestNotif}>
              Allow
            </button>
          </div>
        )}
        {notifPerm === 'granted' && (
          <div className="notif-bar">
            <span className="notif-granted">
              🔔 Notifications on — we&apos;ll ping you for adds, completions, assignments, and member pings
            </span>
          </div>
        )}
        {notifPerm === 'denied' && (
          <div className="notif-bar">
            <span className="notif-denied">
              🔕 Notifications blocked — enable in browser settings
            </span>
          </div>
        )}

        <div className="progress-row">
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${pct}%` }} />
          </div>
          <span className="progress-label">
            {tasks.filter((t) => t.done).length}/{tasks.length} done
          </span>
        </div>

        <div className="filters">
          {FILTER_OPTIONS.map(([v, l]) => (
            <button
              key={v}
              type="button"
              className={`filter-btn${filter === v ? ' active' : ''}`}
              onClick={() => setFilter(v)}
            >
              {l}
            </button>
          ))}
        </div>
        <div className="list-actions">
          <button
            type="button"
            className="list-action-btn"
            disabled={bulkBusy || !hasOpenTasks}
            onClick={markAllDone}
          >
            Mark all done
          </button>
          <button
            type="button"
            className="list-action-btn danger"
            disabled={bulkBusy || !hasDoneTasks}
            onClick={clearDoneTasks}
          >
            Clear done
          </button>
        </div>

        <div className="tasks">
          {active.length === 0 && done.length === 0 && (
            <div className="empty">Nothing here yet — add a task below</div>
          )}

          {active.map((t) => (
            <div key={t.id} className={`task-item${newIds.has(t.id) ? ' flash' : ''}`}>
              <button type="button" className="check-btn" onClick={() => toggleDone(t.id)} />
              <div className="task-body">
                <div className="task-text">{t.text}</div>
                <div className="task-meta">
                  <span className={`chip ${isMe(t.by) ? 'chip-me' : 'chip-cw'}`}>
                    {t.by}
                  </span>
                  {t.assignedTo.length > 0 && (
                    <span className="chip chip-assign">→ {formatAssignees(t.assignedTo)}</span>
                  )}
                </div>
                <div className="task-assign-picker" aria-label="Assign task">
                  <button
                    type="button"
                    className={`task-assign-chip${t.assignedTo.length === 0 ? ' active' : ''}`}
                    onClick={() => updateAssigned(t.id, [])}
                  >
                    Anyone
                  </button>
                  {uniqueAssign.map((m) => (
                    <button
                      key={m}
                      type="button"
                      className={`task-assign-chip${t.assignedTo.includes(m) ? ' active' : ''}`}
                      onClick={() => toggleTaskAssignee(t.id, m)}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              </div>
              {isMe(t.by) && (
                <button type="button" className="task-del" onClick={() => delTask(t.id)}>
                  ×
                </button>
              )}
            </div>
          ))}

          {done.length > 0 && (
            <>
              <div className="section-label">Done</div>
              {done.map((t) => (
                <div key={t.id} className="task-item done">
                  <button
                    type="button"
                    className={`check-btn ${isMe(t.doneBy) ? 'me' : 'cw'}`}
                    onClick={() => toggleDone(t.id)}
                  >
                    ✓
                  </button>
                  <div className="task-body">
                    <div className="task-text done">{t.text}</div>
                    <div className="task-meta">
                      <span className={`chip ${isMe(t.by) ? 'chip-me' : 'chip-cw'}`}>
                        {t.by}
                      </span>
                      {t.assignedTo.length > 0 && (
                        <span className="chip chip-assign">→ {formatAssignees(t.assignedTo)}</span>
                      )}
                      <span
                        className={`chip ${isMe(t.doneBy) ? 'chip-done-me' : 'chip-done-cw'}`}
                      >
                        ✓ {t.doneBy}
                      </span>
                    </div>
                  </div>
                  {isMe(t.by) && (
                    <button type="button" className="task-del" onClick={() => delTask(t.id)}>
                      ×
                    </button>
                  )}
                </div>
              ))}
            </>
          )}
        </div>

        <div className="sticky-add-shell">
          <div className="add-row">
            <input
              ref={addRef}
              className="add-input"
              value={addIn}
              onChange={(e) => setAddIn(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addTask()}
              placeholder="Add a task…"
              maxLength={200}
            />
            <div className="add-assign-picker" aria-label="Assign new task">
              <button
                type="button"
                className={`add-assign-chip${assignTo.length === 0 ? ' active' : ''}`}
                onClick={() => setAssignTo([])}
              >
                Anyone
              </button>
              {uniqueAssign.map((m) => (
                <button
                  key={m}
                  type="button"
                  className={`add-assign-chip${assignTo.includes(m) ? ' active' : ''}`}
                  onClick={() =>
                    setAssignTo((prev) =>
                      prev.includes(m) ? prev.filter((x) => x !== m) : [...prev, m],
                    )
                  }
                >
                  {m}
                </button>
              ))}
            </div>
            <button type="button" className="add-btn" onClick={addTask}>
              +
            </button>
          </div>
        </div>

        <div className="footer-leave-wrap">
          <button
            type="button"
            className="leave-list-btn leave-list-btn--footer"
            disabled={leaveListBusy}
            onClick={confirmLeaveList}
          >
            {leaveListBusy ? 'Leaving…' : 'Leave this list'}
          </button>
          <p className="footer-hint">Realtime sync — you stay in the list until you leave or sign out.</p>
        </div>
      </div>

      {settingsOpen && (
        <div className="list-modal-root" role="dialog" aria-modal="true" aria-label="List information">
          <button
            type="button"
            className="list-modal-backdrop"
            aria-label="Close"
            onClick={() => setSettingsOpen(false)}
          />
          <div className="list-modal-panel">
            <div className="list-modal-header">
              <h2 className="list-modal-title">This list</h2>
              <button
                type="button"
                className="list-modal-close"
                aria-label="Close"
                onClick={() => setSettingsOpen(false)}
              >
                ×
              </button>
            </div>
            <div className="list-modal-body">
              <p className="list-modal-label">List name</p>
              <p className="list-modal-hint">Shown on your home screen and in the header (everyone on the list can edit).</p>
              <div className="list-modal-code-row list-modal-code-row--stack">
                <input
                  className="setup-input"
                  value={listTitleDraft}
                  onChange={(e) => {
                    setListTitleDraft(e.target.value)
                    setListTitleMsg('')
                  }}
                  maxLength={48}
                  placeholder="e.g. Groceries, Weekend chores"
                />
                <button
                  type="button"
                  className="setup-go"
                  disabled={listTitleBusy || !roomId}
                  onClick={handleSaveListTitle}
                >
                  Save name
                </button>
              </div>
              {listTitleMsg && <p className="list-modal-msg">{listTitleMsg}</p>}

              <hr className="list-modal-divider" />
              <p className="list-modal-label">Join code</p>
              <div className="list-modal-code-row">
                <code className="list-modal-code">{joinCodeDisplay || '—'}</code>
                <button
                  type="button"
                  className="setup-go secondary"
                  onClick={copyJoinCode}
                  disabled={!joinCodeDisplay}
                >
                  Copy
                </button>
              </div>
              <p className="list-modal-hint">
                Share this code so others can join from the home screen under &quot;Join with code&quot;.
              </p>

              {isRoomCreator ? (
                <>
                  <hr className="list-modal-divider" />
                  <p className="list-modal-label">Custom join code (you created this list)</p>
                  <p className="list-modal-hint">
                    4–8 letters or numbers. Anyone already in the list should use the new code after you save.
                  </p>
                  <div className="list-modal-code-row list-modal-code-row--stack">
                    <input
                      className="setup-input"
                      value={customCodeDraft}
                      onChange={(e) => setCustomCodeDraft(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
                      maxLength={8}
                      placeholder="E.g. FAMILY1"
                    />
                    <button
                      type="button"
                      className="setup-go"
                      disabled={customCodeBusy || customCodeDraft.length < 4}
                      onClick={handleApplyCustomCode}
                    >
                      Save new code
                    </button>
                  </div>
                  {customCodeMsg && <p className="list-modal-msg">{customCodeMsg}</p>}
                </>
              ) : (
                <p className="list-modal-hint" style={{ marginTop: 14 }}>
                  Only the person who tapped &quot;New list&quot; can change the code. Lists created before the
                  database update may not show this option until you run the latest SQL migration in Supabase.
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
