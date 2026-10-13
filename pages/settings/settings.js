document.title = l('settingsPreferencesHeading') + ' | Iris'

var contentTypeBlockingContainer = document.getElementById('content-type-blocking')
var banner = document.getElementById('restart-required-banner')
var siteThemeCheckbox = document.getElementById('checkbox-site-theme')
var showDividerCheckbox = document.getElementById('checkbox-show-divider')
var userscriptsCheckbox = document.getElementById('checkbox-userscripts')
var userscriptsShowDirectorySection = document.getElementById('userscripts-show-directory')
var separateTitlebarCheckbox = document.getElementById('checkbox-separate-titlebar')
var openTabsInForegroundCheckbox = document.getElementById('checkbox-open-tabs-in-foreground')
var autoPlayCheckbox = document.getElementById('checkbox-enable-autoplay')
var userAgentCheckbox = document.getElementById('checkbox-user-agent')
var userAgentInput = document.getElementById('input-user-agent')

function showRestartRequiredBanner () {
  banner.hidden = false
  settings.set('restartNow', true)
}
settings.get('restartNow', (value) => {
  if (value === true) {
    showRestartRequiredBanner()
  }
})

/* content blocking settings */

var trackingLevelContainer = document.getElementById('tracking-level-container')
var trackingLevelOptions = Array.from(trackingLevelContainer.querySelectorAll('input[name=blockingLevel]'))
var blockingExceptionsContainer = document.getElementById('content-blocking-information')
var blockingExceptionsInput = document.getElementById('content-blocking-exceptions')
var blockedRequestCount = document.querySelector('#content-blocking-blocked-requests strong')

settings.listen('filteringBlockedCount', function (value) {
  var count = value || 0
  var valueStr
  if (count > 50000) {
    valueStr = new Intl.NumberFormat(navigator.locale, { notation: 'compact', maximumSignificantDigits: 4 }).format(count)
  } else {
    valueStr = new Intl.NumberFormat().format(count)
  }
  blockedRequestCount.textContent = valueStr
})

function updateBlockingLevelUI (level) {
  var radio = trackingLevelOptions[level]
  radio.checked = true

  if (level === 0) {
    blockingExceptionsContainer.hidden = true
  } else {
    blockingExceptionsContainer.hidden = false
    radio.parentNode.appendChild(blockingExceptionsContainer)
  }

  if (document.querySelector('#tracking-level-container .setting-option.selected')) {
    document.querySelector('#tracking-level-container .setting-option.selected').classList.remove('selected')
  }
  radio.parentNode.classList.add('selected')
}

function changeBlockingLevelSetting (level) {
  settings.get('filtering', function (value) {
    if (!value) {
      value = {}
    }
    value.blockingLevel = level
    settings.set('filtering', value)
    updateBlockingLevelUI(level)
  })
}

function setExceptionInputSize () {
  blockingExceptionsInput.style.height = (blockingExceptionsInput.scrollHeight + 2) + 'px'
}

settings.get('filtering', function (value) {
  // migrate from old settings (<v1.9.0)
  if (value && typeof value.trackers === 'boolean') {
    if (value.trackers === true) {
      value.blockingLevel = 2
    } else if (value.trackers === false) {
      value.blockingLevel = 0
    }
    delete value.trackers
    settings.set('filtering', value)
  }

  if (value && value.blockingLevel !== undefined) {
    updateBlockingLevelUI(value.blockingLevel)
  } else {
    updateBlockingLevelUI(1)
  }

  if (value && value.exceptionDomains && value.exceptionDomains.length > 0) {
    blockingExceptionsInput.value = value.exceptionDomains.join(', ') + ', '
    setExceptionInputSize()
  }
})

trackingLevelOptions.forEach(function (item, idx) {
  item.addEventListener('change', function () {
    changeBlockingLevelSetting(idx)
  })
})

blockingExceptionsInput.addEventListener('input', function () {
  setExceptionInputSize()

  // remove protocols because of https://github.com/minbrowser/min/issues/1428
  var newValue = this.value.split(',').map(i => i.trim().replace('http://', '').replace('https://', '')).filter(i => !!i)

  settings.get('filtering', function (value) {
    if (!value) {
      value = {}
    }
    value.exceptionDomains = newValue
    settings.set('filtering', value)
  })
})

/* content type settings */

var contentTypes = {
  // humanReadableName: contentType
  scripts: 'script',
  images: 'image'
}

// used for showing localized strings
var contentTypeSettingNames = {
  scripts: 'settingsBlockScriptsToggle',
  images: 'settingsBlockImagesToggle'
}

for (var contentType in contentTypes) {
  (function (contentType) {
    settings.get('filtering', function (value) {
      // create the settings section for blocking each content type

      var section = document.createElement('div')
      section.classList.add('setting-section')

      var id = 'checkbox-block-' + contentTypes[contentType]

      var checkbox = document.createElement('input')
      checkbox.type = 'checkbox'
      checkbox.id = id

      if (value && value.contentTypes) {
        checkbox.checked = value.contentTypes.indexOf(contentTypes[contentType]) != -1
      }

      var label = document.createElement('label')
      label.setAttribute('for', id)
      label.textContent = l(contentTypeSettingNames[contentType])

      section.appendChild(checkbox)
      section.appendChild(label)

      contentTypeBlockingContainer.appendChild(section)

      checkbox.addEventListener('change', function (e) {
        settings.get('filtering', function (value) {
          if (!value) {
            value = {}
          }
          if (!value.contentTypes) {
            value.contentTypes = []
          }

          if (e.target.checked) { // add the item to the array
            value.contentTypes.push(contentTypes[contentType])
          } else { // remove the item from the array
            var idx = value.contentTypes.indexOf(contentTypes[contentType])
            value.contentTypes.splice(idx, 1)
          }

          settings.set('filtering', value)
        })
      })
    })
  })(contentType)
}

/* dark mode setting */
var darkModeNever = document.getElementById('dark-mode-never')
var darkModeNight = document.getElementById('dark-mode-night')
var darkModeAlways = document.getElementById('dark-mode-always')
var darkModeSystem = document.getElementById('dark-mode-system')

// -1 - off ; 0 - auto ; 1 - on
settings.get('darkMode', function (value) {
  darkModeNever.checked = (value === -1)
  darkModeNight.checked = (value === 0)
  darkModeAlways.checked = (value === 1 || value === true)
  darkModeSystem.checked = (value === 2 || value === undefined || value === false)
})

darkModeNever.addEventListener('change', function (e) {
  if (this.checked) {
    settings.set('darkMode', -1)
  }
})
darkModeNight.addEventListener('change', function (e) {
  if (this.checked) {
    settings.set('darkMode', 0)
  }
})
darkModeAlways.addEventListener('change', function (e) {
  if (this.checked) {
    settings.set('darkMode', 1)
  }
})
darkModeSystem.addEventListener('change', function (e) {
  if (this.checked) {
    settings.set('darkMode', 2)
  }
})

/* site theme setting */

settings.get('siteTheme', function (value) {
  if (value === true || value === undefined) {
    siteThemeCheckbox.checked = true
  } else {
    siteThemeCheckbox.checked = false
  }
})

siteThemeCheckbox.addEventListener('change', function (e) {
  settings.set('siteTheme', this.checked)
})

/* startup settings */

var startupSettingInput = document.getElementById('startup-options')

settings.get('startupTabOption', function(value = 2) {
  startupSettingInput.value = value
})

startupSettingInput.addEventListener('change', function() {
  settings.set('startupTabOption', parseInt(this.value))
})

/* new window settings */

var newWindowSettingInput = document.getElementById('new-window-options')

settings.get('newWindowOption', function(value = 1) {
  newWindowSettingInput.value = value
})

newWindowSettingInput.addEventListener('change', function() {
  settings.set('newWindowOption', parseInt(this.value))
})

/* userscripts setting */

settings.get('userscriptsEnabled', function (value) {
  if (value === true) {
    userscriptsCheckbox.checked = true
    userscriptsShowDirectorySection.hidden = false
  }
})

userscriptsCheckbox.addEventListener('change', function (e) {
  settings.set('userscriptsEnabled', this.checked)
  userscriptsShowDirectorySection.hidden = !this.checked
})

userscriptsShowDirectorySection.getElementsByTagName('a')[0].addEventListener('click', function() {
  postMessage({ message: 'showUserscriptDirectory' })
})

/* show divider between tabs setting */

settings.get('showDividerBetweenTabs', function (value) {
  if (value === true) {
    showDividerCheckbox.checked = true
  }
})

showDividerCheckbox.addEventListener('change', function (e) {
  settings.set('showDividerBetweenTabs', this.checked)
})

/* language setting*/

var languagePicker = document.getElementById('setting-language-picker')

for (var language in languages) { //from localization.build.js
  var item = document.createElement('option')
  item.textContent = languages[language].name
  item.value = languages[language].identifier
  languagePicker.appendChild(item)
}

languagePicker.value = getCurrentLanguage()

languagePicker.addEventListener('change', function () {
  settings.set('userSelectedLanguage', this.value)
  showRestartRequiredBanner()
})

/* separate titlebar setting */

settings.get('useSeparateTitlebar', function (value) {
  if (value === true) {
    separateTitlebarCheckbox.checked = true
  }
})

separateTitlebarCheckbox.addEventListener('change', function (e) {
  settings.set('useSeparateTitlebar', this.checked)
  showRestartRequiredBanner()
})

/* tabs in foreground setting */

settings.get('openTabsInForeground', function (value) {
  if (value === true) {
    openTabsInForegroundCheckbox.checked = true
  }
})

openTabsInForegroundCheckbox.addEventListener('change', function (e) {
  settings.set('openTabsInForeground', this.checked)
})

/* media autoplay setting */

settings.get('enableAutoplay', function (value) {
  autoPlayCheckbox.checked = value
})

autoPlayCheckbox.addEventListener('change', function (e) {
  settings.set('enableAutoplay', this.checked)
})

/* user agent settting */

settings.get('customUserAgent', function (value) {
  if (value) {
    userAgentCheckbox.checked = true
    userAgentInput.style.visibility = 'visible'
    userAgentInput.value = value
  }
})

userAgentCheckbox.addEventListener('change', function (e) {
  if (this.checked) {
    userAgentInput.style.visibility = 'visible'
  } else {
    settings.set('customUserAgent', null)
    userAgentInput.style.visibility = 'hidden'
    showRestartRequiredBanner()
  }
})

userAgentInput.addEventListener('input', function (e) {
  const value = this.value.slice(0, 200)
  if (value !== this.value) {
    this.value = value
  }
  if (value) {
    settings.set('customUserAgent', value)
  } else {
    settings.set('customUserAgent', null)
  }
  showRestartRequiredBanner()
})

/* update notifications setting */

var updateNotificationsCheckbox = document.getElementById('checkbox-update-notifications')

settings.get('updateNotificationsEnabled', function (value) {
  if (value === false) {
    updateNotificationsCheckbox.checked = false
  } else {
    updateNotificationsCheckbox.checked = true
  }
})

updateNotificationsCheckbox.addEventListener('change', function (e) {
  settings.set('updateNotificationsEnabled', this.checked)
})

/* usage statistics setting */

var usageStatisticsCheckbox = document.getElementById('checkbox-usage-statistics')

settings.get('collectUsageStats', function (value) {
  if (value === false) {
    usageStatisticsCheckbox.checked = false
  } else {
    usageStatisticsCheckbox.checked = true
  }
})

usageStatisticsCheckbox.addEventListener('change', function (e) {
  settings.set('collectUsageStats', this.checked)
})

/* default search engine setting */

var searchEngineDropdown = document.getElementById('default-search-engine')
var searchEngineInput = document.getElementById('custom-search-engine')

searchEngineInput.setAttribute('placeholder', l('customSearchEngineDescription'))

settings.onLoad(function () {
  if (currentSearchEngine.custom) {
    searchEngineInput.hidden = false
    searchEngineInput.value = currentSearchEngine.searchURL
  }

  for (var searchEngine in searchEngines) {
    var item = document.createElement('option')
    item.textContent = searchEngines[searchEngine].name

    if (searchEngines[searchEngine].name == currentSearchEngine.name) {
      item.setAttribute('selected', 'true')
    }

    searchEngineDropdown.appendChild(item)
  }

  // add custom option
  item = document.createElement('option')
  item.textContent = 'custom'
  if (currentSearchEngine.custom) {
    item.setAttribute('selected', 'true')
  }
  searchEngineDropdown.appendChild(item)
})

searchEngineDropdown.addEventListener('change', function (e) {
  if (this.value === 'custom') {
    searchEngineInput.hidden = false
  } else {
    searchEngineInput.hidden = true
    settings.set('searchEngine', { name: this.value })
  }
})

searchEngineInput.addEventListener('input', function (e) {
  settings.set('searchEngine', { url: this.value })
})

/* key map settings */

settings.get('keyMap', function (keyMapSettings) {
  var keyMap = userKeyMap(keyMapSettings)

  var keyMapList = document.getElementById('key-map-list')

  Object.keys(keyMap).forEach(function (action) {
    var li = createKeyMapListItem(action, keyMap)
    keyMapList.appendChild(li)
  })
})

function formatCamelCase (text) {
  var result = text.replace(/([a-z])([A-Z])/g, '$1 $2')
  return result.charAt(0).toUpperCase() + result.slice(1)
}

function createKeyMapListItem (action, keyMap) {
  var li = document.createElement('li')
  var label = document.createElement('label')
  var input = document.createElement('input')
  label.innerText = formatCamelCase(action)
  label.htmlFor = action

  input.type = 'text'
  input.id = input.name = action
  input.value = formatKeyValue(keyMap[action])
  input.addEventListener('input', onKeyMapChange)

  li.appendChild(label)
  li.appendChild(input)

  return li
}

function formatKeyValue (value) {
  // multiple shortcuts should be separated by commas
  if (value instanceof Array) {
    value = value.join(', ')
  }
  // use either command or ctrl depending on the platform
  if (navigator.platform === 'MacIntel') {
    value = value.replace(/\bmod\b/g, 'command')
  } else {
    value = value.replace(/\bmod\b/g, 'ctrl')
    value = value.replace(/\boption\b/g, 'alt')
  }
  if (navigator.platform === 'Win32') {
    value = value.replace(/\bsuper\b/g, 'win')
  }
  return value
}

function parseKeyInput (input) {
  // input may be a single mapping or multiple mappings comma separated.
  var parsed = input.toLowerCase().split(',')
  parsed = parsed.map(function (e) { return e.trim() })
  // Remove empty
  parsed = parsed.filter(Boolean)
  // convert key names back to generic equivalents
  parsed = parsed.map(function (e) {
    if (navigator.platform === 'MacIntel') {
      e = e.replace(/\b(command)|(cmd)\b/g, 'mod')
    } else {
      e = e.replace(/\b(control)|(ctrl)\b/g, 'mod')
      e = e.replace(/\balt\b/g, 'option')
      e = e.replace(/\bwin\b/g, 'super')
    }
    return e
  })
  return parsed.length > 1 ? parsed : parsed[0]
}

function onKeyMapChange (e) {
  var action = this.name
  var newValue = this.value

  settings.get('keyMap', function (keyMapSettings) {
    if (!keyMapSettings) {
      keyMapSettings = {}
    }

    keyMapSettings[action] = parseKeyInput(newValue)
    settings.set('keyMap', keyMapSettings)
    showRestartRequiredBanner()
  })
}

/* Password auto-fill settings  */

var passwordManagersDropdown = document.getElementById('selected-password-manager')
for (var manager in passwordManagers) {
  var item = document.createElement('option')
  item.textContent = passwordManagers[manager].name
  passwordManagersDropdown.appendChild(item)
}

settings.listen('passwordManager', function (value) {
  passwordManagersDropdown.value = currentPasswordManager.name
})

passwordManagersDropdown.addEventListener('change', function (e) {
  if (this.value === 'none') {
    settings.set('passwordManager', { name: 'none' })
  } else {
    settings.set('passwordManager', { name: this.value })
  }
})

var keychainViewLink = document.getElementById('keychain-view-link')

keychainViewLink.addEventListener('click', function () {
  postMessage({ message: 'showCredentialList' })
})

settings.listen('passwordManager', function (value) {
  keychainViewLink.hidden = !(currentPasswordManager.name === 'Built-in password manager')
})

/* proxy settings */

const proxyTypeInput = document.getElementById('selected-proxy-type')
const proxyInputs = Array.from(document.querySelectorAll('#proxy-settings-container input'))

const toggleProxyOptions = proxyType => {
  document.getElementById('manual-proxy-section').hidden = proxyType != 1
  document.getElementById('pac-option').hidden = proxyType != 2
}

const setProxy = (key, value) => {
  settings.get('proxy', (proxy = {}) => {
    proxy[key] = value
    settings.set('proxy', proxy)
  })
}

settings.get('proxy', (proxy = {}) => {
  toggleProxyOptions(proxy.type)

  proxyTypeInput.options.selectedIndex = proxy.type || 0
  proxyInputs.forEach(item => item.value = proxy[item.name] || '')
})

proxyTypeInput.addEventListener('change', e => {
  const proxyType = e.target.options.selectedIndex
  setProxy('type', proxyType)
  toggleProxyOptions(proxyType)
})

proxyInputs.forEach(item => item.addEventListener('change', e => setProxy(e.target.name, e.target.value)))

settings.get('customBangs', (value) => {
  const bangslist = document.getElementById('custom-bangs')

  if (value) {
    value.forEach(function (bang) {
      bangslist.appendChild(createBang(bang.phrase, bang.snippet, bang.redirect))
    })
  }
})

document.getElementById('add-custom-bang').addEventListener('click', function () {
  const bangslist = document.getElementById('custom-bangs')
  const newListItem = createBang()
  bangslist.appendChild(newListItem)
  document.body.scrollBy(0, Math.round(newListItem.getBoundingClientRect().height))
})

function createBang (bang, snippet, redirect) {
  var li = document.createElement('li')
  var bangInput = document.createElement('input')
  var snippetInput = document.createElement('input')
  var redirectInput = document.createElement('input')
  var xButton = document.createElement('button')
  var current = { phrase: bang ?? '', snippet: snippet ?? '', redirect: redirect ?? '' }
  function update (key, input) {
    settings.get('customBangs', function (d) {
      const filtered = d ? d.filter((bang) => bang.phrase !== current.phrase && (key !== 'phrase' || bang.phrase !== input.value)) : []
      filtered.push({ phrase: bangInput.value, snippet: snippetInput.value, redirect: redirectInput.value })
      settings.set('customBangs', filtered)
      current[key] = input.value
    })
  }

  bangInput.type = 'text'
  snippetInput.type = 'text'
  redirectInput.type = 'text'
  bangInput.value = bang ?? ''
  snippetInput.value = snippet ?? ''
  redirectInput.value = redirect ?? ''
  xButton.className = 'i carbon:close custom-bang-delete-button'

  bangInput.placeholder = l('settingsCustomBangsPhrase')
  snippetInput.placeholder = l('settingsCustomBangsSnippet')
  redirectInput.placeholder = l('settingsCustomBangsRedirect')
  xButton.addEventListener('click', function () {
    li.remove()
    settings.get('customBangs', (d) => {
      settings.set('customBangs', d.filter((bang) => bang.phrase !== bangInput.value))
    })
    showRestartRequiredBanner()
  })

  bangInput.addEventListener('change', function () {
    if (this.value.startsWith('!')) {
      this.value = this.value.slice(1)
    }
    update('phrase', bangInput)
    showRestartRequiredBanner()
  })
  snippetInput.addEventListener('change', function () {
    update('snippet', snippetInput)
    showRestartRequiredBanner()
  })
  redirectInput.addEventListener('change', function () {
    update('redirect', redirectInput)
    showRestartRequiredBanner()
  })

  li.appendChild(bangInput)
  li.appendChild(snippetInput)
  li.appendChild(redirectInput)
  li.appendChild(xButton)

  return li
}

/* Iris AI settings */

var IRIS_AI_DEFAULTS = {
  settingsVersion: 2,
  baseUrl: 'http://192.168.1.252:13305/v1',
  model: 'Qwen3.8-Flash-Next-GGUF-IQ4_NL',
  apiKey: '',
  thinking: 'low',
  maxSteps: 40,
  maxMinutes: 20,
  temperature: 0.2,
  modelTimeoutMs: 180000,
  keepImages: 1,
  screenshotMaxDimension: 1280,
  screenshotQuality: 82,
  markerEnabled: true,
  autoPauseOnUserInput: true
}

var irisAI = Object.assign({}, IRIS_AI_DEFAULTS)

var irisFields = [
  { key: 'baseUrl', id: 'iris-base-url', type: 'string' },
  { key: 'model', id: 'iris-model', type: 'string' },
  { key: 'apiKey', id: 'iris-api-key', type: 'string' },
  { key: 'thinking', id: 'iris-thinking', type: 'string' },
  { key: 'maxSteps', id: 'iris-max-steps', type: 'int' },
  { key: 'maxMinutes', id: 'iris-max-minutes', type: 'int' },
  { key: 'modelTimeoutMs', id: 'iris-model-timeout', type: 'int', scale: 1000 },
  { key: 'temperature', id: 'iris-temperature', type: 'float' },
  { key: 'screenshotMaxDimension', id: 'iris-screenshot-size', type: 'int' },
  { key: 'screenshotQuality', id: 'iris-screenshot-quality', type: 'int' },
  { key: 'keepImages', id: 'iris-keep-images', type: 'int' }
]

var irisMarkerCheckbox = document.getElementById('checkbox-iris-marker')
var irisTakeoverCheckbox = document.getElementById('checkbox-iris-takeover')

function irisSave () {
  // settings.set() is forwarded to the main process, which notifies the agent
  irisAI.settingsVersion = 2
  settings.set('irisAI', irisAI)
}

function irisRenderAll () {
  irisFields.forEach(function (field) {
    var value = irisAI[field.key]
    if (field.scale && typeof value === 'number') value = Math.round(value / field.scale)
    document.getElementById(field.id).value = value === undefined || value === null ? '' : value
  })
  irisMarkerCheckbox.checked = irisAI.markerEnabled !== false
  irisTakeoverCheckbox.checked = irisAI.autoPauseOnUserInput !== false
}

irisFields.forEach(function (field) {
  var input = document.getElementById(field.id)

  input.addEventListener('change', function () {
    var raw = input.value.trim()

    if (field.type === 'int' || field.type === 'float') {
      var parsed = field.type === 'int' ? parseInt(raw, 10) : parseFloat(raw, 10)
      var fallback = IRIS_AI_DEFAULTS[field.key]
      if (field.scale) fallback = fallback / field.scale
      if (isNaN(parsed) || raw === '') {
        // never let a blank or bogus number reach the agent: fall back to the default
        parsed = fallback
      }
      var min = parseFloat(input.getAttribute('min'))
      var max = parseFloat(input.getAttribute('max'))
      if (!isNaN(min)) { parsed = Math.max(min, parsed) }
      if (!isNaN(max)) { parsed = Math.min(max, parsed) }
      input.value = parsed
      irisAI[field.key] = field.scale ? parsed * field.scale : parsed
    } else {
      irisAI[field.key] = raw
    }

    irisSave()
  })
})

irisMarkerCheckbox.addEventListener('change', function () {
  irisAI.markerEnabled = this.checked
  irisSave()
})

irisTakeoverCheckbox.addEventListener('change', function () {
  irisAI.autoPauseOnUserInput = this.checked
  irisSave()
})

document.getElementById('iris-reset-defaults').addEventListener('click', function () {
  irisAI = Object.assign({}, IRIS_AI_DEFAULTS)
  irisRenderAll()
  irisSave()
})

document.getElementById('iris-test-connection').addEventListener('click', function () {
  var status = document.getElementById('iris-connection-status')
  status.textContent = 'Checking…'
  var headers = irisAI.apiKey ? { Authorization: 'Bearer ' + irisAI.apiKey } : {}
  fetch(String(irisAI.baseUrl).replace(/\/+$/, '') + '/models', { headers: headers })
    .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)) })
    .then(function (json) {
      var ids = (json.data || []).map(function (m) { return m.id })
      status.textContent = ids.indexOf(irisAI.model) !== -1 ? 'Connected. The model is available.' : 'Connected, but "' + irisAI.model + '" is not in the list (' + ids.length + ' models).'
    })
    .catch(function (err) { status.textContent = 'Cannot reach the server: ' + err.message })
})

settings.listen('irisAI', function (value) {
  var stored = value || {}
  irisAI = Object.assign({}, IRIS_AI_DEFAULTS)
  if (stored.settingsVersion === 2) {
    Object.keys(IRIS_AI_DEFAULTS).forEach(function (key) {
      if (stored[key] !== undefined) irisAI[key] = stored[key]
    })
  } else {
    ['baseUrl', 'model', 'apiKey', 'markerEnabled', 'autoPauseOnUserInput'].forEach(function (key) {
      if (stored[key] !== undefined && stored[key] !== '') irisAI[key] = stored[key]
    })
  }
  irisRenderAll()
})

/* --- My info ----------------------------------------------------------- */

var irisProfileRows = document.getElementById('iris-profile-rows')
var irisProfileStatus = document.getElementById('iris-profile-status')

function irisProfileRow (field) {
  var row = document.createElement('div')
  row.className = 'iris-row'

  var label = document.createElement('input')
  label.type = 'text'
  label.className = 'iris-row-label'
  label.placeholder = 'Field name'
  label.value = field.label || ''

  var value = document.createElement('input')
  value.type = field.secret ? 'password' : 'text'
  value.className = 'iris-row-value'
  value.autocomplete = 'off'
  value.spellcheck = false
  value.placeholder = field.secret ? (field.hasValue ? 'Saved — type to replace' : 'Not set') : 'Value'
  value.value = field.secret ? '' : (field.value || '')
  row.dataset.hasValue = field.hasValue ? '1' : ''

  var secretWrap = document.createElement('label')
  secretWrap.className = 'iris-row-secret'
  var secret = document.createElement('input')
  secret.type = 'checkbox'
  secret.checked = !!field.secret
  secret.addEventListener('change', function () {
    value.type = secret.checked ? 'password' : 'text'
  })
  secretWrap.appendChild(secret)
  secretWrap.appendChild(document.createTextNode(' Secret'))

  var del = document.createElement('button')
  del.type = 'button'
  del.className = 'iris-row-delete'
  del.title = 'Remove'
  del.textContent = '×'
  del.addEventListener('click', function () { row.remove() })

  row.appendChild(label)
  row.appendChild(value)
  row.appendChild(secretWrap)
  row.appendChild(del)
  irisProfileRows.appendChild(row)
}

function irisRenderProfile (fields) {
  irisProfileRows.innerHTML = ''
  ;(fields || []).forEach(irisProfileRow)
}

document.getElementById('iris-profile-add').addEventListener('click', function () {
  irisProfileRow({ label: '', value: '', secret: false })
})

document.getElementById('iris-profile-save').addEventListener('click', function () {
  var fields = Array.prototype.map.call(irisProfileRows.querySelectorAll('.iris-row'), function (row) {
    var secret = row.querySelector('.iris-row-secret input').checked
    var value = row.querySelector('.iris-row-value').value
    return {
      label: row.querySelector('.iris-row-label').value.trim(),
      value: value,
      secret: secret,
      keep: secret && !value && row.dataset.hasValue === '1'
    }
  }).filter(function (f) { return f.label })
  irisProfileStatus.textContent = 'Saving…'
  postMessage({ message: 'irisProfileSet', fields: fields })
})

window.addEventListener('message', function (e) {
  if (e.data && e.data.message === 'irisProfileData' && e.data.data) {
    irisRenderProfile(e.data.data.fields)
    if (e.data.data.error) irisProfileStatus.textContent = 'Could not save: ' + e.data.data.error
    else if (e.data.data.saved) irisProfileStatus.textContent = 'Saved.'
  }
})

postMessage({ message: 'irisProfileGet' })

/* --- Schedule ---------------------------------------------------------- */

var irisScheduleRows = document.getElementById('iris-schedule-rows')
var irisSchedules = []

function irisSaveSchedules () {
  settings.set('irisSchedules', irisSchedules)
}

function irisRenderSchedules () {
  irisScheduleRows.innerHTML = ''
  irisSchedules.forEach(function (s, index) {
    var row = document.createElement('div')
    row.className = 'iris-row iris-schedule-row'

    var task = document.createElement('input')
    task.type = 'text'
    task.className = 'iris-row-task'
    task.placeholder = 'What should Iris do?'
    task.value = s.task || ''
    task.addEventListener('change', function () { s.task = task.value.trim(); irisSaveSchedules() })

    var kind = document.createElement('select')
    kind.innerHTML = '<option value="every">Every</option><option value="at">At</option>'
    kind.value = s.at ? 'at' : 'every'

    var every = document.createElement('input')
    every.type = 'number'
    every.min = '1'
    every.max = '10080'
    every.className = 'iris-row-num'
    every.value = s.everyMinutes || 60
    every.title = 'minutes'

    var at = document.createElement('input')
    at.type = 'time'
    at.className = 'iris-row-time'
    at.value = s.at || '09:00'

    function sync () {
      every.hidden = kind.value !== 'every'
      at.hidden = kind.value !== 'at'
      unit.hidden = kind.value !== 'every'
    }
    var unit = document.createElement('span')
    unit.className = 'iris-row-unit'
    unit.textContent = 'min'

    kind.addEventListener('change', function () {
      if (kind.value === 'at') { s.at = at.value; s.everyMinutes = 0 } else { s.at = ''; s.everyMinutes = Number(every.value) || 60 }
      sync()
      irisSaveSchedules()
    })
    every.addEventListener('change', function () { s.everyMinutes = Math.max(1, Number(every.value) || 60); irisSaveSchedules() })
    at.addEventListener('change', function () { s.at = at.value; irisSaveSchedules() })

    var mode = document.createElement('select')
    mode.innerHTML = '<option value="once">Once</option><option value="continuous">Non-stop</option>'
    mode.value = s.mode || 'once'
    mode.addEventListener('change', function () { s.mode = mode.value; irisSaveSchedules() })

    var onWrap = document.createElement('label')
    onWrap.className = 'iris-row-secret'
    var on = document.createElement('input')
    on.type = 'checkbox'
    on.checked = s.enabled !== false
    on.addEventListener('change', function () { s.enabled = on.checked; irisSaveSchedules() })
    onWrap.appendChild(on)
    onWrap.appendChild(document.createTextNode(' On'))

    var del = document.createElement('button')
    del.type = 'button'
    del.className = 'iris-row-delete'
    del.title = 'Remove'
    del.textContent = '×'
    del.addEventListener('click', function () {
      irisSchedules.splice(index, 1)
      irisSaveSchedules()
      irisRenderSchedules()
    })

    row.appendChild(task)
    row.appendChild(kind)
    row.appendChild(every)
    row.appendChild(unit)
    row.appendChild(at)
    row.appendChild(mode)
    row.appendChild(onWrap)
    row.appendChild(del)
    irisScheduleRows.appendChild(row)
    sync()
  })
}

document.getElementById('iris-schedule-add').addEventListener('click', function () {
  irisSchedules.push({ id: Date.now().toString(36), task: '', everyMinutes: 60, at: '', mode: 'once', enabled: true, lastRun: Date.now() })
  irisSaveSchedules()
  irisRenderSchedules()
})

settings.listen('irisSchedules', function (value) {
  var list = Array.isArray(value) ? value : []
  // keep the row being edited if only lastRun changed
  irisSchedules = list.map(function (s) { return Object.assign({}, s) })
  if (!irisScheduleRows.contains(document.activeElement)) irisRenderSchedules()
})

// "Iris settings" in the agent panel deep-links here
if (location.hash === '#iris-ai') {
  document.getElementById('iris-ai-settings-container').scrollIntoView()
}
