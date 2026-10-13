window.addEventListener('message', function (e) {
  if (!e.origin.startsWith('min://')) {
    return
  }

  if (e.data && e.data.message && e.data.message === 'getSettingsData') {
    ipc.send('getSettingsData')
  }

  if (e.data && e.data.message && e.data.message === 'setSetting') {
    ipc.send('setSetting', { key: e.data.key, value: e.data.value })
  }

  // Iris "My info": secrets go one way only (page → main process, where they are encrypted)
  if (e.data && e.data.message === 'irisProfileGet') {
    ipc.send('irisProfileGet')
  }

  if (e.data && e.data.message === 'irisProfileSet') {
    ipc.send('irisProfileSet', { fields: e.data.fields })
  }

  if (e.data && e.data.message === 'irisSettingsAction') {
    ipc.send('irisSettingsAction', { action: e.data.action, args: e.data.args })
  }

  if (e.data && e.data.message === 'irisImportChrome') {
    ipc.send('irisImportChrome')
  }

  if (e.data && ['irisAccountsGet', 'irisAccountReveal', 'irisAccountDelete'].includes(e.data.message)) {
    ipc.send(e.data.message, { site: e.data.site, username: e.data.username })
  }
})

ipc.on('irisAccountsData', function (e, data) {
  if (window.location.toString().startsWith('min://')) {
    window.postMessage({ message: 'irisAccountsData', data: data }, window.location.toString())
  }
})

ipc.on('irisProfileData', function (e, data) {
  if (window.location.toString().startsWith('min://')) {
    window.postMessage({ message: 'irisProfileData', data: data }, window.location.toString())
  }
})

ipc.on('receiveSettingsData', function (e, data) {
  if (window.location.toString().startsWith('min://')) { // probably redundant, but might as well check
    window.postMessage({ message: 'receiveSettingsData', settings: data }, window.location.toString())
  }
})

ipc.on('irisImportResult', function (e, data) {
  if (window.location.toString().startsWith('min://')) {
    window.postMessage({ message: 'irisImportResult', data: data }, window.location.toString())
  }
})

ipc.on('irisSettingsActionResult', function (e, data) {
  if (window.location.toString().startsWith('min://')) {
    window.postMessage({ message: 'irisSettingsActionResult', data: data }, window.location.toString())
  }
})
