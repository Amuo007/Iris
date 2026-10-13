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
