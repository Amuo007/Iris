/* global irisAction */

/* Settings → Connections → WhatsApp (main/irisWhatsApp.js does the work). The page asks for the state every 2 s while
   this section is open, so the QR code and "linked" show up without a reload. */

var irisWhatsAppSection = document.getElementById('iris-connections-container')
var irisWhatsAppNumber = document.getElementById('iris-whatsapp-number')
var irisWhatsAppToggle = document.getElementById('checkbox-iris-whatsapp')
var irisWhatsAppUpdates = document.getElementById('checkbox-iris-whatsapp-updates')

var IRIS_WHATSAPP_STATUS = {
  off: 'Not connected (switch it on above to connect).',
  connecting: 'Connecting…',
  qr: 'Waiting for the scan…',
  unlinked: 'Not linked.',
  error: 'Something went wrong.'
}

function irisRenderWhatsApp (r) {
  if (document.activeElement !== irisWhatsAppNumber) irisWhatsAppNumber.value = r.userNumber ? '+' + r.userNumber : ''
  irisWhatsAppToggle.checked = !!r.enabled
  irisWhatsAppUpdates.checked = !!r.updates
  document.getElementById('iris-whatsapp-selfchat-help').hidden = !r.selfChat
  var linked = r.status === 'linked'
  var text = linked ? 'Linked as +' + (r.me || '…') + (r.waiting && r.waiting.length ? ' · waiting for your code for ' + r.waiting.join(', ') : '') : (IRIS_WHATSAPP_STATUS[r.status] || r.status)
  if (r.error) text += ' ' + r.error
  if (r.testError) text += ' The test message failed: ' + r.testError
  else if (r.tested) text += ' Test message sent.'
  document.getElementById('iris-whatsapp-status').textContent = text
  document.getElementById('iris-whatsapp-link').textContent = linked ? 'Link again…' : 'Link…'
  document.getElementById('iris-whatsapp-link').hidden = r.status === 'qr'
  document.getElementById('iris-whatsapp-test').hidden = !linked
  document.getElementById('iris-whatsapp-unlink').hidden = !(linked || r.status === 'qr')
  document.getElementById('iris-whatsapp-qr-box').hidden = !(r.status === 'qr' && r.qr)
  if (r.qr) document.getElementById('iris-whatsapp-qr').src = r.qr
}

function irisSaveWhatsApp () {
  irisAction('whatsappSave', { enabled: irisWhatsAppToggle.checked, updates: irisWhatsAppUpdates.checked, userNumber: irisWhatsAppNumber.value })
}

irisWhatsAppToggle.addEventListener('change', irisSaveWhatsApp)
irisWhatsAppUpdates.addEventListener('change', irisSaveWhatsApp)
irisWhatsAppNumber.addEventListener('change', irisSaveWhatsApp)
document.getElementById('iris-whatsapp-link').addEventListener('click', function () {
  document.getElementById('iris-whatsapp-status').textContent = 'Getting a QR code…'
  irisAction('whatsappLink')
})
document.getElementById('iris-whatsapp-unlink').addEventListener('click', function () { irisAction('whatsappUnlink') })
document.getElementById('iris-whatsapp-test').addEventListener('click', function () { irisAction('whatsappTest') })

window.addEventListener('message', function (e) {
  if (!e.data || e.data.message !== 'irisSettingsActionResult') return
  var d = e.data.data || {}
  if (/^whatsapp/.test(d.action || '') && d.result) irisRenderWhatsApp(d.result)
})

irisAction('whatsappStatus')
setInterval(function () {
  if (irisWhatsAppSection.classList.contains('is-shown') && !document.hidden) irisAction('whatsappStatus')
}, 2000)
