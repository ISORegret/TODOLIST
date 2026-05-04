/* Service worker for Web Push notifications */
const basePath = self.registration.scope || '/'
self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = { body: event.data ? event.data.text() : '' }
  }
  const title = data.title || 'Duo Todo'
  const body = data.body || 'You have a new notification'
  const tag = data.tag || 'duo-todo-push'
  const url = data.url || basePath
  const roomId = data.room_id || ''
  const options = {
    body,
    tag,
    renotify: true,
    data: {
      url,
      roomId,
    },
    icon: `${basePath}favicon.svg`,
    badge: `${basePath}favicon.svg`,
  }
  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const targetUrl = event.notification?.data?.url || '/'
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      const existing = clients.find((c) => c.url.includes(targetUrl))
      if (existing) return existing.focus()
      return self.clients.openWindow(targetUrl)
    }),
  )
})
