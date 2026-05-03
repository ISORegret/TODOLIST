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

function initLetter(n) {
  return (n || '?')[0].toUpperCase()
}

function playChime(type = 'add') {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext
    const ctx = new Ctx()
    const notes = type === 'add' ? [523, 659] : [659, 523, 784]
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
    assignedTo: row.assigned_to || null,
    done: row.done,
    doneBy: row.done_by || null,
    at: new Date(row.created_at).getTime(),
  }
}

export default function App() {
  const [authReady, setAuthReady] = useState(false)
  const [roomId, setRoomId] = useState(() => localStorage.getItem(LS_ROOM) || '')
  const [joinCodeDisplay, setJoinCodeDisplay] = useState(
    () => localStorage.getItem(LS_JOIN) || '',
  )
  const [myName, setMyName] = useState(() => localStorage.getItem(LS_NAME) || '')
  const [nameIn, setNameIn] = useState('')
  const [joinCodeIn, setJoinCodeIn] = useState('')
  const [roomBusy, setRoomBusy] = useState(false)
  const [roomError, setRoomError] = useState('')

  /** True while changing name / list without leaving current room yet */
  const [setupPhase, setSetupPhase] = useState(false)
  const [members, setMembers] = useState([])

  const [tasks, setTasks] = useState([])
  const [filter, setFilter] = useState('all')
  const [addIn, setAddIn] = useState('')
  const [assignTo, setAssignTo] = useState('')
  const [toasts, setToasts] = useState([])
  const [notifPerm, setNotifPerm] = useState(() =>
    typeof window !== 'undefined' && 'Notification' in window
      ? Notification.permission
      : 'default',
  )
  const [unread, setUnread] = useState(0)
  const [newIds, setNewIds] = useState(() => new Set())

  const prevTasksRef = useRef([])
  const myNameRef = useRef(myName)
  const roomIdRef = useRef(roomId)
  const addRef = useRef(null)
  const setupDoneRef = useRef(false)

  useEffect(() => {
    myNameRef.current = myName
  }, [myName])
  useEffect(() => {
    roomIdRef.current = roomId
  }, [roomId])

  useEffect(() => {
    if (unread > 0) document.title = `(${unread}) ${origTitle}`
    else document.title = origTitle
  }, [unread])

  useEffect(() => {
    const onFocus = () => setUnread(0)
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  const showToast = useCallback((msg) => {
    const id = genToastId()
    setToasts((t) => [...t, { id, msg }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3200)
  }, [])

  const sendBrowserNotif = useCallback((title, body) => {
    if ('Notification' in window && Notification.permission === 'granted') {
      try {
        new Notification(title, { body })
      } catch {
        /* ignore */
      }
    }
  }, [])

  const handleDiff = useCallback(
    (prev, next, me) => {
      if (!setupDoneRef.current || !me) return
      const prevIds = new Set(prev.map((t) => t.id))
      const freshIds = new Set()

      next.forEach((t) => {
        if (t.by === me) return

        if (!prevIds.has(t.id)) {
          freshIds.add(t.id)
          const assignHint = t.assignedTo ? ` → ${t.assignedTo}` : ''
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

        if (
          old.assignedTo !== t.assignedTo &&
          t.assignedTo === me &&
          t.by !== me
        ) {
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
  }

  const loadMembers = useCallback(async (rid) => {
    if (!supabase) return
    const { data, error } = await supabase
      .from('room_members')
      .select('display_name')
      .eq('room_id', rid)
    if (error) return
    const names = [...new Set((data || []).map((r) => r.display_name).filter(Boolean))]
    names.sort()
    setMembers(names)
  }, [])

  useEffect(() => {
    if (!supabase) return
    let cancelled = false
    ;(async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) {
        const { error } = await supabase.auth.signInAnonymously()
        if (error) {
          console.error(error)
          if (!cancelled) {
            showToast('Could not sign in. Enable Anonymous auth in Supabase.')
          }
        }
      }
      if (!cancelled) setAuthReady(true)
    })()
    const { data: sub } = supabase.auth.onAuthStateChange(() => {
      if (!cancelled) setAuthReady(true)
    })
    return () => {
      cancelled = true
      sub.subscription.unsubscribe()
    }
  }, [showToast])

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
    localStorage.removeItem(LS_ROOM)
    localStorage.removeItem(LS_JOIN)
    setRoomId('')
    setJoinCodeDisplay('')
    setMembers([])
    setTasks([])
    prevTasksRef.current = []
    setSetupPhase(false)
  }, [])

  useEffect(() => {
    if (!authReady || !roomId || !supabaseConfigured || setupPhase || !supabase) return
    const ridAtStart = roomId
    setupDoneRef.current = Boolean(myName.trim())
    const chRef = { current: null }
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

      await loadTasks()
      if (cancelled || roomIdRef.current !== ridAtStart) return

      chRef.current = supabase
        .channel(`tasks:${ridAtStart}`)
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
        .subscribe()
    })()

    return () => {
      cancelled = true
      const c = chRef.current
      chRef.current = null
      if (c && supabase) supabase.removeChannel(c)
    }
  }, [
    authReady,
    roomId,
    setupPhase,
    myName,
    loadTasks,
    persistMyName,
    loadMembers,
    showToast,
    leaveRoom,
  ])

  function beginSetup() {
    setSetupPhase(true)
    setNameIn(myName || '')
  }

  async function handleCreateRoom() {
    if (!nameIn.trim() || !supabase) return
    setRoomBusy(true)
    setRoomError('')
    const { data, error } = await supabase.rpc('create_room')
    setRoomBusy(false)
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
    prevTasksRef.current = []
    setTasks([])
  }

  async function handleJoinRoom() {
    if (!nameIn.trim() || !joinCodeIn.trim() || !supabase) return
    setRoomBusy(true)
    setRoomError('')
    const { data: rid, error } = await supabase.rpc('join_room', {
      p_code: joinCodeIn.trim(),
    })
    setRoomBusy(false)
    if (error) {
      setRoomError(error.message === 'invalid code' ? 'Invalid code' : error.message)
      return
    }
    localStorage.setItem(LS_ROOM, rid)
    localStorage.removeItem(LS_JOIN)
    localStorage.setItem(LS_NAME, nameIn.trim())
    setRoomId(rid)
    setJoinCodeDisplay('')
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

  async function addTask() {
    if (!addIn.trim() || !roomId || !supabase) return
    const assigned = assignTo.trim() || null
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

  async function toggleDone(id) {
    if (!supabase) return
    const t = tasks.find((x) => x.id === id)
    if (!t) return
    const nextDone = !t.done
    const payload = nextDone
      ? { done: true, done_by: myName, updated_at: new Date().toISOString() }
      : { done: false, done_by: null, updated_at: new Date().toISOString() }
    const { error } = await supabase.from('tasks').update(payload).eq('id', id)
    if (error) {
      showToast('Could not update task')
      return
    }
    await loadTasks()
  }

  async function updateAssigned(id, value) {
    if (!supabase) return
    const assigned = value === '' || value === '__anyone' ? null : value
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

  async function delTask(id) {
    if (!supabase) return
    const { error } = await supabase.from('tasks').delete().eq('id', id)
    if (error) {
      showToast('Could not delete')
      return
    }
    await loadTasks()
  }

  const isMe = (n) => n === myName

  const uniqueAssign = [...new Set([...members, myName].filter(Boolean))].sort(
    (a, b) => a.localeCompare(b),
  )

  const vis = tasks.filter((t) => {
    if (filter === 'mine') return t.by === myName
    if (filter === 'forme') return t.assignedTo === myName && !t.done
    if (filter === 'done') return t.done
    return true
  })

  const active = vis.filter((t) => !t.done)
  const done = vis.filter((t) => t.done)
  const pct = tasks.length
    ? Math.round((tasks.filter((t) => t.done).length / tasks.length) * 100)
    : 0

  const othersLabel =
    members.filter((m) => m && m !== myName).join(', ') || 'your group'

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

  if (!roomId || setupPhase) {
    return (
      <div className="app">
        <div className="setup-screen">
          <div>
            <div className="header-date" style={{ textAlign: 'center', marginBottom: 10 }}>
              {dateStr()}
            </div>
            <div className="setup-label">
              Shared list for <em>every device</em>
            </div>
          </div>
          <p className="setup-sub">
            Sign in is automatic. Create a list and share the 6-letter code, or join someone
            else&apos;s. Turn on notifications for alerts when others add or complete tasks.
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
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="toast-wrap">
        {toasts.map((t) => (
          <div key={t.id} className="toast">
            {t.msg}
          </div>
        ))}
      </div>

      <div className="app">
        <div className="header">
          <div className="header-top">
            <div>
              <div className="header-date">{dateStr()}</div>
              <h1 className="header-title">
                Today&apos;s <em>list</em>
              </h1>
            </div>
            <div className="header-right">
              <div className="who-badge">
                <div className="who-dot">{initLetter(myName)}</div>
                <span className="who-name">{myName}</span>
              </div>
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
            </div>
          </div>
        </div>

        {joinCodeDisplay && (
          <div className="room-banner">
            Share code: <strong>{joinCodeDisplay}</strong>
            <span className="hint">Others enter this under &quot;Join with code&quot; with their name.</span>
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
              🔔 Notifications on — we&apos;ll ping you for adds, completions, and assignments
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
          {[
            ['all', 'All'],
            ['mine', 'Mine'],
            ['forme', 'For me'],
            ['done', 'Done'],
          ].map(([v, l]) => (
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
                    {initLetter(t.by)} {t.by}
                  </span>
                  {t.assignedTo && (
                    <span className="chip chip-assign">→ {t.assignedTo}</span>
                  )}
                </div>
                <select
                  className="task-assign-select"
                  aria-label="Assign to"
                  value={t.assignedTo || '__anyone'}
                  onChange={(e) => updateAssigned(t.id, e.target.value)}
                >
                  <option value="__anyone">Anyone</option>
                  {uniqueAssign.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
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
              <div className="section-label">Completed</div>
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
                        {initLetter(t.by)} {t.by}
                      </span>
                      {t.assignedTo && (
                        <span className="chip chip-assign">→ {t.assignedTo}</span>
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
          <select
            className="add-assign"
            aria-label="Assign new task"
            value={assignTo}
            onChange={(e) => setAssignTo(e.target.value)}
          >
            <option value="">Anyone</option>
            {uniqueAssign.map((m) => (
              <option key={m} value={m}>
                → {m}
              </option>
            ))}
          </select>
          <button type="button" className="add-btn" onClick={addTask}>
            +
          </button>
        </div>

        <p className="footer-hint">
          Realtime sync ·{' '}
          <button
            type="button"
            className="switch-link"
            style={{ display: 'inline', fontSize: '10.5px' }}
            onClick={leaveRoom}
          >
            leave this list
          </button>
        </p>
      </div>
    </>
  )
}
