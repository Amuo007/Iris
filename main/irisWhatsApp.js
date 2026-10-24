/*
 * main/irisWhatsApp.js — Settings → Connections → WhatsApp: Iris's own WhatsApp (a second number, linked like WhatsApp
 * Web by scanning a QR code; Baileys, the library OpenClaw uses) messages the user's number for a code only the user
 * can get, and reads the reply. Off by default; while it is off nothing here runs and Baileys is never loaded.
 *
 * The rules (what may be sent, the code in a reply, time limits) are in iris/agent/channels.js; this file is the
 * connection, the encrypted session on disk, and the hand-over to the running agent (its notes, read on the next step).
 */

const irisChannelsLib = require('./iris/agent/channels.js')

var irisWhatsAppState = {
  sock: null,
  status: 'off', // off | connecting | qr | linked | unlinked | error
  qr: '', // data: URL of the QR code to scan, while linking
  me: '', // the linked number
  meLid: '', // its hidden-number address, for "Message yourself"
  sentIds: new Set(), // messages Iris sent (its own messages in "Message yourself" are not replies)
  error: '',
  requests: [],
  ownRun: null, // a task the user started from WhatsApp: its result goes back there
  updatesSent: [], // when updates were sent (a few an hour at most)
  retry: 0,
  linking: false,
  ticker: null
}

function irisWhatsAppSettings () {
  const s = settings.get('irisWhatsApp') || {}
  return { enabled: s.enabled === true, updates: s.updates === true, userNumber: irisChannelsLib.completeNumber(s.userNumber, irisWhatsAppState.me) }
}

function irisWhatsAppDir () {
  return path.join(userDataPath, 'iris-whatsapp')
}

/** Linked, switched on and with the user's number: the agent may ask for codes. */
function irisWhatsAppReady () {
  const s = irisWhatsAppSettings()
  return s.enabled && !!s.userNumber && irisWhatsAppState.status === 'linked'
}

/* WhatsApp's session keys, one file each like Baileys' own multi-file store, but encrypted with the system keychain
   (irisEncrypt) — they let anyone with the files read and send as Iris's number */
async function irisWhatsAppAuthState (B) {
  const dir = irisWhatsAppDir()
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const name = function (file) { return path.join(dir, file.replace(/\//g, '__').replace(/:/g, '-') + '.enc') }
  const queue = {}
  const locked = function (file, job) {
    const run = (queue[file] || Promise.resolve()).then(job, job)
    queue[file] = run.catch(function () {})
    return run
  }
  const read = function (file) {
    return locked(file, function () {
      try {
        const text = irisDecrypt(fs.readFileSync(name(file), 'utf8'))
        return text ? JSON.parse(text, B.BufferJSON.reviver) : null
      } catch (e) { return null }
    })
  }
  const write = function (file, value) {
    return locked(file, function () {
      const tmp = name(file) + '.tmp'
      fs.writeFileSync(tmp, irisEncrypt(JSON.stringify(value, B.BufferJSON.replacer)), { mode: 0o600 })
      fs.renameSync(tmp, name(file))
    })
  }
  const remove = function (file) {
    return locked(file, function () { try { fs.unlinkSync(name(file)) } catch (e) {} })
  }
  const creds = (await read('creds.json')) || B.initAuthCreds()
  return {
    state: {
      creds: creds,
      keys: {
        get: async function (type, ids) {
          const out = {}
          await Promise.all(ids.map(async function (id) {
            let value = await read(type + '-' + id + '.json')
            if (type === 'app-state-sync-key' && value) value = B.proto.Message.AppStateSyncKeyData.fromObject(value)
            out[id] = value
          }))
          return out
        },
        set: async function (data) {
          const jobs = []
          Object.keys(data).forEach(function (type) {
            Object.keys(data[type]).forEach(function (id) {
              const value = data[type][id]
              jobs.push(value ? write(type + '-' + id + '.json', value) : remove(type + '-' + id + '.json'))
            })
          })
          await Promise.all(jobs)
        }
      }
    },
    saveCreds: function () { return write('creds.json', creds) },
    linked: !!(creds && creds.me)
  }
}

function irisWhatsAppLogText (o, m) {
  let extra = ''
  try { extra = o && typeof o === 'object' ? JSON.stringify(o, function (k, v) { return k === 'stack' ? undefined : v }) : String(o || '') } catch (e) {}
  return (String(m || '') + ' ' + extra).trim().slice(0, 300)
}

/* Baileys wants a pino logger: only its warnings and errors go to Iris's debug log */
const irisWhatsAppLog = {
  level: 'warn',
  child: function () { return irisWhatsAppLog },
  trace: function () {},
  debug: function () {},
  info: function () {},
  warn: function (o, m) { DBUG('whatsapp warn: ' + irisWhatsAppLogText(o, m)) },
  error: function (o, m) { DBUG('whatsapp error: ' + irisWhatsAppLogText(o, m)) },
  fatal: function (o, m) { DBUG('whatsapp fatal: ' + (m || '').toString().slice(0, 200)) }
}

/**
 * Connect (or show a QR code to link, when link is true and nothing is linked yet). Stays quiet without a session:
 * a QR code only appears when the user asks to link.
 */
async function irisWhatsAppConnect (link) {
  if (irisWhatsAppState.sock) return
  irisWhatsAppState.status = 'connecting'
  irisWhatsAppState.error = ''
  let B, QRCode
  try {
    B = await import('baileys')
    QRCode = require('qrcode')
  } catch (e) {
    irisWhatsAppState.status = 'error'
    irisWhatsAppState.error = 'WhatsApp support could not be loaded: ' + e.message
    DBUG(irisWhatsAppState.error)
    return
  }
  const auth = await irisWhatsAppAuthState(B)
  if (!auth.linked && !link) { irisWhatsAppState.status = 'unlinked'; return }
  irisWhatsAppState.linking = !auth.linked
  let version
  try {
    const latest = await Promise.race([B.fetchLatestBaileysVersion(), new Promise(function (resolve) { setTimeout(resolve, 8000) })])
    version = latest && latest.version
  } catch (e) { version = undefined }
  const sock = B.makeWASocket(Object.assign({
    auth: { creds: auth.state.creds, keys: B.makeCacheableSignalKeyStore(auth.state.keys, irisWhatsAppLog) },
    logger: irisWhatsAppLog,
    browser: B.Browsers.macOS('Iris'),
    markOnlineOnConnect: false,
    // no full history, but the first sync stays on: Baileys needs it for the hidden-number (LID) mappings, or the session
    // becomes unstable ("DISABLING ALL SYNC … LEADING TO INSTABILITY AND SESSION ERRORS"); old messages are not replies
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
    getMessage: async function () { return undefined }
  }, version ? { version: version } : {}))
  irisWhatsAppState.sock = sock
  sock.ev.on('creds.update', auth.saveCreds)
  sock.ev.on('connection.update', async function (u) {
    if (irisWhatsAppState.sock !== sock) return
    if (u.qr) {
      try { irisWhatsAppState.qr = await QRCode.toDataURL(u.qr, { margin: 1, width: 280 }) } catch (e) { irisWhatsAppState.qr = '' }
      irisWhatsAppState.status = 'qr'
    }
    if (u.connection === 'open') {
      irisWhatsAppState.status = 'linked'
      irisWhatsAppState.qr = ''
      irisWhatsAppState.retry = 0
      irisWhatsAppState.linking = false
      irisWhatsAppState.me = irisChannelsLib.phoneOf(B.jidNormalizedUser((sock.user && sock.user.id) || '')) || ''
      irisWhatsAppState.meLid = (sock.user && sock.user.lid) || ''
      DBUG('whatsapp linked as ' + irisWhatsAppState.me)
    }
    if (u.connection === 'close') {
      // an older connection closing (Link was pressed again) leaves the new one alone
      if (irisWhatsAppState.sock && irisWhatsAppState.sock !== sock) return
      const code = u.lastDisconnect && u.lastDisconnect.error && u.lastDisconnect.error.output && u.lastDisconnect.error.output.statusCode
      irisWhatsAppState.sock = null
      irisWhatsAppState.qr = ''
      DBUG('whatsapp closed (' + code + ')')
      if (code === B.DisconnectReason.loggedOut) {
        // unlinked on the phone (or from Settings): the session is useless now
        irisWhatsAppWipe()
        irisWhatsAppState.status = 'unlinked'
        return
      }
      const wanted = irisWhatsAppSettings().enabled || irisWhatsAppState.linking
      // right after a scan WhatsApp asks for a fresh connection; a QR code nobody scanned is not retried
      if (code === B.DisconnectReason.restartRequired) return irisWhatsAppConnect(true)
      if (irisWhatsAppState.linking && code === B.DisconnectReason.timedOut) { irisWhatsAppState.status = 'unlinked'; irisWhatsAppState.linking = false; return }
      if (!wanted) { irisWhatsAppState.status = 'off'; return }
      irisWhatsAppState.status = 'connecting'
      irisWhatsAppState.retry = Math.min(irisWhatsAppState.retry + 1, 6)
      setTimeout(function () { if (!irisWhatsAppState.sock && irisWhatsAppSettings().enabled) irisWhatsAppConnect(false) }, 5000 * Math.pow(2, irisWhatsAppState.retry - 1))
    }
  })
  sock.ev.on('messages.upsert', irisWhatsAppOnMessages)
}

/* messages that arrived: the user's replies (to Iris's number, or in "Message yourself" when Iris is linked to the
   user's own number) */
function irisWhatsAppOnMessages (e) {
  if (!e || (e.type !== 'notify' && e.type !== 'append')) return
  const user = irisWhatsAppSettings().userNumber
  const self = { me: irisWhatsAppState.me, meLid: irisWhatsAppState.meLid, sentIds: irisWhatsAppState.sentIds }
  ;(e.messages || []).forEach(function (m) {
    // a message typed on the phone in "Message yourself" may come as "append"; old ones (history) are not replies
    const at = Number(m.messageTimestamp || 0) * 1000
    if (at && Date.now() - at > 5 * 60 * 1000) return
    if (!irisChannelsLib.isFromUser(m.key, user, self)) return
    const text = irisChannelsLib.messageText(m.message)
    if (text && !irisChannelsLib.isIrisMessage(text)) irisWhatsAppIncoming(text).catch(function (err) { DBUG('whatsapp reply failed: ' + err.message) })
  })
}

function irisWhatsAppDisconnect () {
  const sock = irisWhatsAppState.sock
  irisWhatsAppState.sock = null
  irisWhatsAppState.qr = ''
  irisWhatsAppState.linking = false
  if (sock) { try { sock.end(undefined) } catch (e) {} }
}

function irisWhatsAppWipe () {
  try { fs.rmSync(irisWhatsAppDir(), { recursive: true, force: true }) } catch (e) { DBUG('whatsapp wipe failed: ' + e.message) }
  irisWhatsAppState.me = ''
}

async function irisWhatsAppSend (text) {
  const to = irisChannelsLib.jidFor(irisWhatsAppSettings().userNumber)
  if (!irisWhatsAppState.sock || irisWhatsAppState.status !== 'linked') throw new Error('WhatsApp is not linked')
  if (!to) throw new Error('no WhatsApp number for you in Settings → Connections')
  try {
    const sent = await irisWhatsAppState.sock.sendMessage(to, { text: String(text).slice(0, 1000) })
    if (sent && sent.key && sent.key.id) {
      irisWhatsAppState.sentIds.add(sent.key.id)
      if (irisWhatsAppState.sentIds.size > 200) irisWhatsAppState.sentIds.delete(irisWhatsAppState.sentIds.values().next().value)
    }
    DBUG('whatsapp sent to …' + to.slice(-19, -15) + (to.startsWith(irisWhatsAppState.me + '@') ? ' (Message yourself)' : ''))
  } catch (e) {
    DBUG('whatsapp send to …' + to.slice(-19, -15) + ' failed: ' + e.message)
    throw e
  }
}

/* the waiting job's tab, by its number in the tab strip now (tabs move as others open and close); 0 when it is gone */
function irisWhatsAppTabNumber (tabId) {
  const i = irisTabList().findIndex(function (t) { return String(t.id) === String(tabId) })
  return i + 1
}

function irisWhatsAppTell (note) {
  if (!irisComputer) return
  irisComputer.notes = (irisComputer.notes || []).concat(note)
}

/* "Message yourself": Iris is linked to the user's own number */
function irisWhatsAppSelfChat () {
  return !!irisWhatsAppState.me && irisWhatsAppSettings().userNumber === irisWhatsAppState.me
}

/** What "status" answers: the run, the step it is on, today's applications. */
function irisWhatsAppStatusInfo () {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const today = irisApplicationsLoad().filter(function (a) { return (a.updated || a.at) >= start.getTime() })
  const count = function (st) { return today.filter(function (a) { return a.status === st }).length }
  const steps = irisSession ? irisSession.items.filter(function (i) { return i.kind === 'step' }) : []
  const lastStep = steps[steps.length - 1] || {}
  const last = today.slice().sort(function (a, b) { return (b.updated || b.at) - (a.updated || a.at) })[0]
  return {
    status: irisIsBusy() ? irisAgentState.status : (irisAgentState.status === 'paused' ? 'paused' : irisAgentState.status || 'idle'),
    task: irisSession ? irisSession.title : irisAgentState.task,
    steps: irisAgentState.steps,
    reason: irisAgentState.reason,
    question: irisComputer && irisComputer.lastQuestion,
    now: irisIsBusy() ? String(lastStep.thought || '').replace(/^\((high|medium|low)\)\s*/, '').slice(0, 200) : '',
    today: { applied: count('applied'), needsYou: count('needs_you'), skipped: count('skipped') },
    last: last ? irisChannelsLib.applicationText(last).replace(/^\[Iris\] /, '') : ''
  }
}

/* a message from the user: a task for the running agent (like a message in the panel) or a new run */
function irisWhatsAppTask (cmd) {
  const busy = irisIsBusy()
  const job = cmd.kind === 'link'
  if (busy && irisAgentState.status === 'paused' && irisComputer && irisComputer.lastQuestion) {
    // Iris asked something and waits: the message is the answer, as if typed in the panel
    if (irisComputer.jobsMode) { try { irisJobsLearnAnswer(irisComputer.lastQuestion, cmd.text) } catch (e) { DBUG('learn answer: ' + e.message) } }
    irisComputer.lastQuestion = null
    irisAgent.answer(cmd.text)
    if (irisSession) { irisSession.items.push({ kind: 'user', text: cmd.text, run: irisSession.run, answer: true, via: 'whatsapp' }); irisSessionSave(irisSession) }
    return irisWhatsAppSend('[Iris] Thanks — going on with that.')
  }
  if (busy) {
    irisWhatsAppTell(job
      ? 'WhatsApp: the user sent this job and wants it applied to next: ' + cmd.url + ' — finish the application you are on (if any), then open it and apply (with the same rules), log it, and go back to what you were doing.'
      : 'WhatsApp: the user asks, in their own words: "' + cmd.text.slice(0, 600) + '". Do it once the step you are on is done, then go back to what you were doing (unless they said to stop that).')
    if (irisSession) { irisSession.items.push({ kind: 'user', text: cmd.text, run: irisSession.run, via: 'whatsapp' }); irisSessionSave(irisSession) }
    return irisWhatsAppSend(job ? '[Iris] Got the link — I will apply to it next.' : '[Iris] Got it — I will do that next.')
  }
  // nothing running: a new run, started like a scheduled one (the browser opens a tab for it)
  const task = job ? 'Apply to this job (the user sent it): ' + cmd.url : cmd.text
  irisWhatsAppState.ownRun = { task: task, at: Date.now() }
  broadcast('iris-agent-scheduled-run', { task: task, mode: 'once' })
  return irisWhatsAppSend('[Iris] Starting: ' + task.slice(0, 200) + '\nI will write back when it is done.')
}

/** The user wrote to Iris (to its number, or "iris …" in Message yourself). */
async function irisWhatsAppIncoming (text) {
  const now = Date.now()
  const selfChat = irisWhatsAppSelfChat()
  const m = irisChannelsLib.matchReply(irisWhatsAppState.requests, text, now)
  // a code for the job waiting on one comes first, with or without "iris"
  if (m.request && m.code) {
    m.request.state = 'answered'
    m.request.answeredAt = now
    irisWhatsAppTell(irisChannelsLib.codeArrivedNote(m.request, m.code, irisWhatsAppTabNumber(m.request.tabId)))
    DBUG('whatsapp: code arrived for ' + irisChannelsLib.jobName(m.request))
    return irisWhatsAppSend(irisChannelsLib.ackText(m.request, m.code))
  }
  const cmd = irisChannelsLib.parseCommand(text, { selfChat: selfChat })
  if (!cmd) {
    // not for Iris: in Message yourself a note to self, so quiet unless a code is waiting
    if (m.request) return irisWhatsAppSend(irisChannelsLib.noCodeText(m.request))
    if (m.late) return irisWhatsAppSend(irisChannelsLib.lateText(m.late))
    return
  }
  // a lone code with nothing waiting for one (late, or sent twice) is not a task
  if (!m.request && irisChannelsLib.isJustCode(text) && (cmd.kind === 'task' || cmd.kind === 'link')) return irisWhatsAppSend(m.late ? irisChannelsLib.lateText(m.late) : irisChannelsLib.noCodeWaitingText())
  // a code is waiting: anything but a command is taken as a try at the code ("hi" must not start a run)
  if (m.request && (cmd.kind === 'task' || cmd.kind === 'link')) return irisWhatsAppSend(irisChannelsLib.noCodeText(m.request))
  DBUG('whatsapp command: ' + cmd.kind)
  switch (cmd.kind) {
    case 'status':
      return irisWhatsAppSend(irisChannelsLib.statusText(irisWhatsAppStatusInfo()))
    case 'help':
      return irisWhatsAppSend(irisChannelsLib.helpText(selfChat))
    case 'pause':
      if (!irisIsBusy() || !irisAgent) return irisWhatsAppSend('[Iris] Nothing is running.')
      irisAgent.pause('whatsapp')
      return irisWhatsAppSend('[Iris] Paused. Write "' + (selfChat ? 'iris ' : '') + 'continue" to go on.')
    case 'resume':
      if (!irisIsBusy() || !irisAgent) return irisWhatsAppSend('[Iris] Nothing is running (send a task or a link to start).')
      irisAgent.resume()
      return irisWhatsAppSend('[Iris] Going on.')
    case 'stop':
      irisCancelRepeat()
      if (!irisIsBusy() || !irisAgent) return irisWhatsAppSend('[Iris] Nothing is running.')
      irisAgent.stop('Stopped by you (WhatsApp)')
      return irisWhatsAppSend('[Iris] Stopped. Nothing restarts it until you send a task or start it in Iris.')
    default:
      return irisWhatsAppTask(cmd)
  }
}

/* updates (Settings → Connections): at most 30 an hour, so a fast run does not flood the chat */
function irisWhatsAppUpdate (text, always) {
  const s = irisWhatsAppSettings()
  if (!text || !irisWhatsAppReady() || (!always && !s.updates)) return
  const now = Date.now()
  irisWhatsAppState.updatesSent = irisWhatsAppState.updatesSent.filter(function (t) { return now - t < 3600 * 1000 })
  if (irisWhatsAppState.updatesSent.length >= 30) return
  irisWhatsAppState.updatesSent.push(now)
  irisWhatsAppSend(text).catch(function () {})
}

/** An application was logged (applied / needs you / failed are sent when updates are on). */
function irisWhatsAppOnApplication (rec) {
  irisWhatsAppUpdate(irisChannelsLib.applicationText(rec), false)
}

/** Iris paused with a question: the user can answer it from WhatsApp (sent whenever WhatsApp is on). */
function irisWhatsAppOnAsk (question) {
  irisWhatsAppUpdate(irisChannelsLib.askText(question), true)
}

/** The model server stopped answering (or came back): sent whenever WhatsApp is on. */
function irisWhatsAppOnServer (text) {
  irisWhatsAppUpdate('[Iris] ' + text, true)
}

/** A run really ended (not a non-stop run picking itself up): its result, for a task started here or with updates on. */
function irisWhatsAppOnRunEnd (status, text) {
  const own = irisWhatsAppState.ownRun && Date.now() - irisWhatsAppState.ownRun.at < 12 * 3600 * 1000
  if (own) irisWhatsAppState.ownRun = null
  // a non-stop run's "done" is picked up again by Iris in 20 s: no message for that one
  if (!own && status !== 'failed') return
  const head = status === 'done' ? '[Iris] Done: ' : status === 'stopped' ? '[Iris] Stopped: ' : '[Iris] Could not finish: '
  irisWhatsAppUpdate(head + String(text || '').slice(0, 900), true)
}

/* every 30 s while a request waits: a code that did not come in time is the user's to finish */
function irisWhatsAppTick () {
  const now = Date.now()
  irisChannelsLib.dueToExpire(irisWhatsAppState.requests, now).forEach(function (r) {
    r.state = 'expired'
    try {
      irisApplicationAdd({ status: 'needs_you', company: r.company, title: r.title, url: r.url, note: 'The code went to the user\'s phone; asked on WhatsApp, no reply within ' + Math.round(irisChannelsLib.WAIT_MS / 60000) + ' minutes.' })
    } catch (e) { DBUG('whatsapp: could not log the expired job: ' + e.message) }
    irisWhatsAppTell(irisChannelsLib.codeExpiredNote(r, irisWhatsAppTabNumber(r.tabId)) + ' (Iris logged it needs_you for you.)')
    irisWhatsAppSend(irisChannelsLib.expiredText(r)).catch(function () {})
  })
  irisWhatsAppState.requests = irisChannelsLib.prune(irisWhatsAppState.requests, now)
  if (!irisChannelsLib.openRequests(irisWhatsAppState.requests, now).length && irisWhatsAppState.ticker) {
    clearInterval(irisWhatsAppState.ticker)
    irisWhatsAppState.ticker = null
  }
}

/**
 * The agent's request_code: message the user and return at once — the run never waits here. { ok, error, note }
 */
async function irisWhatsAppRequestCode (req) {
  if (!irisWhatsAppReady()) return { ok: false, error: 'WhatsApp is not set up (Settings → Connections): log this job needs_you naming the code, and go on' }
  const now = Date.now()
  const can = irisChannelsLib.canAsk(irisWhatsAppState.requests, req, now)
  if (!can.ok) return { ok: false, error: 'not sent: ' + can.reason + '. Leave this job for the user (log it needs_you naming the code) and go on' }
  const r = irisChannelsLib.newRequest(req, now)
  try {
    await irisWhatsAppSend(irisChannelsLib.codeRequestText(r))
  } catch (e) {
    return { ok: false, error: 'the WhatsApp message could not be sent (' + e.message + '): log this job needs_you naming the code, and go on' }
  }
  irisWhatsAppState.requests.push(r)
  if (!irisWhatsAppState.ticker) irisWhatsAppState.ticker = setInterval(irisWhatsAppTick, 30000)
  return {
    ok: true,
    note: 'Asked the user on WhatsApp for the code for ' + irisChannelsLib.jobName(r) + '. Do not wait: leave this tab (tab ' + irisWhatsAppTabNumber(r.tabId) + ') open as it is, open the next job in a new tab and go on. Iris tells you the code (and the tab) the moment it comes, or after ' + Math.round(irisChannelsLib.WAIT_MS / 60000) + ' minutes that none came.'
  }
}

/* Settings → Connections; null for anything else */
function irisWhatsAppSettingsAction (action, args) {
  const a = args || {}
  const status = function () {
    const s = irisWhatsAppSettings()
    return {
      enabled: s.enabled,
      updates: s.updates,
      selfChat: irisWhatsAppSelfChat(),
      userNumber: s.userNumber,
      status: irisWhatsAppState.status,
      qr: irisWhatsAppState.qr,
      me: irisWhatsAppState.me,
      error: irisWhatsAppState.error,
      waiting: irisChannelsLib.openRequests(irisWhatsAppState.requests, Date.now()).map(function (r) { return irisChannelsLib.jobName(r) })
    }
  }
  switch (action) {
    case 'whatsappStatus':
      return Promise.resolve(status())
    case 'whatsappSave': {
      const before = irisWhatsAppSettings()
      const next = { enabled: a.enabled === true, updates: a.updates === true, userNumber: irisChannelsLib.completeNumber(a.userNumber, irisWhatsAppState.me) }
      settings.set('irisWhatsApp', next)
      if (next.enabled && !before.enabled) irisWhatsAppConnect(false)
      if (!next.enabled && before.enabled && !irisWhatsAppState.linking) { irisWhatsAppDisconnect(); irisWhatsAppState.status = 'off' }
      return Promise.resolve(status())
    }
    case 'whatsappLink':
      irisWhatsAppDisconnect()
      return irisWhatsAppConnect(true).then(status)
    case 'whatsappUnlink': {
      const sock = irisWhatsAppState.sock
      irisWhatsAppState.linking = false
      const out = sock ? sock.logout().catch(function () {}) : Promise.resolve()
      return out.then(function () {
        irisWhatsAppDisconnect()
        irisWhatsAppWipe()
        irisWhatsAppState.status = 'unlinked'
        return status()
      })
    }
    case 'whatsappTest':
      return irisWhatsAppSend('[Iris] Test message: WhatsApp is linked. I will only write here when a site sends a code to your phone.')
        .then(function () { return Object.assign(status(), { tested: true }) })
        .catch(function (e) { return Object.assign(status(), { testError: e.message }) })
    default:
      return null
  }
}

app.whenReady().then(function () {
  // a linked, switched-on WhatsApp reconnects by itself a little after start (it never shows a QR code on its own)
  if (irisWhatsAppSettings().enabled) setTimeout(function () { irisWhatsAppConnect(false).catch(function (e) { DBUG('whatsapp start failed: ' + e.message) }) }, 5000)
})
