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
  accountMode: 'signup',
  emailAccess: false,
  maxSteps: 40,
  maxMinutes: 20,
  temperature: 0.2,
  modelTimeoutMs: 180000,
  keepImages: 1,
  screenshotMaxDimension: 1280,
  screenshotQuality: 82,
  markerEnabled: true,
  autoPauseOnUserInput: true,
  lookups: true,
  runLookups: 6,
  smartLevel: 'quick',
  planFirst: false
}

var irisAI = Object.assign({}, IRIS_AI_DEFAULTS)

var irisFields = [
  { key: 'baseUrl', id: 'iris-base-url', type: 'string' },
  { key: 'model', id: 'iris-model', type: 'string' },
  { key: 'apiKey', id: 'iris-api-key', type: 'string' },
  { key: 'thinking', id: 'iris-thinking', type: 'string' },
  { key: 'accountMode', id: 'iris-account-mode', type: 'string' },
  { key: 'maxSteps', id: 'iris-max-steps', type: 'int' },
  { key: 'maxMinutes', id: 'iris-max-minutes', type: 'int' },
  { key: 'modelTimeoutMs', id: 'iris-model-timeout', type: 'int', scale: 1000 },
  { key: 'temperature', id: 'iris-temperature', type: 'float' },
  { key: 'screenshotMaxDimension', id: 'iris-screenshot-size', type: 'int' },
  { key: 'screenshotQuality', id: 'iris-screenshot-quality', type: 'int' },
  { key: 'keepImages', id: 'iris-keep-images', type: 'int' },
  { key: 'smartLevel', id: 'iris-smart-level', type: 'string' },
  { key: 'runLookups', id: 'iris-run-lookups', type: 'int' }
]

var irisMarkerCheckbox = document.getElementById('checkbox-iris-marker')
var irisTakeoverCheckbox = document.getElementById('checkbox-iris-takeover')
var irisEmailCheckbox = document.getElementById('checkbox-iris-email')
var irisLookupsCheckbox = document.getElementById('checkbox-iris-lookups')

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
  irisEmailCheckbox.checked = irisAI.emailAccess === true
  irisLookupsCheckbox.checked = irisAI.lookups !== false
  document.getElementById('iris-run-lookups').disabled = irisAI.lookups === false
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

irisEmailCheckbox.addEventListener('change', function () {
  irisAI.emailAccess = this.checked
  irisSave()
})

irisLookupsCheckbox.addEventListener('change', function () {
  irisAI.lookups = this.checked
  document.getElementById('iris-run-lookups').disabled = !this.checked
  irisSave()
})

var irisLookupNever = document.getElementById('iris-lookup-never')
irisLookupNever.addEventListener('change', function () { settings.set('irisLookupNever', irisLookupNever.value.trim()) })
settings.listen('irisLookupNever', function (v) { if (document.activeElement !== irisLookupNever) irisLookupNever.value = v || '' })

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

/* --- General, Bookmarks, Clear data --------------------------------------- */

function irisAction (action, args) {
  postMessage({ message: 'irisSettingsAction', action: action, args: args || {} })
}

window.addEventListener('message', function (e) {
  if (!e.data) return
  if (e.data.message === 'irisSettingsActionResult') {
    var d = e.data.data || {}
    var r = d.result || {}
    if (d.action === 'defaultStatus' || d.action === 'makeDefault') {
      document.getElementById('iris-default-status').textContent = r.isDefault ? 'Iris is your default browser.' : 'Open links from other apps in Iris.'
      document.getElementById('iris-make-default').hidden = !!r.isDefault
    } else if (d.action === 'downloadDir' || d.action === 'chooseDownloadDir') {
      document.getElementById('iris-download-dir').textContent = (r.dir || '').replace(/^\/Users\/[^/]+/, '~')
    } else if (d.action === 'clearData') {
      document.getElementById('iris-clear-status').textContent = r.error ? 'Could not clear: ' + r.error : 'Cleared.'
      irisLoadHistory()
      irisAction('cookiesList')
    } else if (d.action === 'downloadsList' || d.action === 'downloadShow') {
      irisRenderDownloads(r)
    } else if (d.action === 'historyList') {
      irisRenderHistory(r.items || [], r.total || 0)
    } else if (d.action === 'cookiesList' || d.action === 'cookiesRemove') {
      irisCookieSites = r.sites || []
      irisRenderCookies()
    }
  } else if (e.data.message === 'irisImportResult') {
    var res = e.data.data || {}
    document.getElementById('iris-import-status').textContent = res.error ? res.error : 'Imported ' + res.count + ' bookmarks from Chrome.'
    document.getElementById('iris-import-chrome').disabled = false
  }
})

document.getElementById('iris-make-default').addEventListener('click', function () { irisAction('makeDefault') })
document.getElementById('iris-download-change').addEventListener('click', function () { irisAction('chooseDownloadDir') })
irisAction('defaultStatus')
irisAction('downloadDir')

var irisDownloadAsk = document.getElementById('checkbox-iris-download-ask')
settings.get('irisDownloadAsk', function (v) { irisDownloadAsk.checked = v === true })
irisDownloadAsk.addEventListener('change', function () { settings.set('irisDownloadAsk', this.checked) })

var irisBarCheckbox = document.getElementById('checkbox-iris-bookmarks-bar')
settings.get('irisBookmarksBar', function (v) { irisBarCheckbox.checked = v !== false })
irisBarCheckbox.addEventListener('change', function () { settings.set('irisBookmarksBar', this.checked) })

document.getElementById('iris-import-chrome').addEventListener('click', function () {
  this.disabled = true
  document.getElementById('iris-import-status').textContent = 'Importing…'
  postMessage({ message: 'irisImportChrome' })
})

document.getElementById('iris-clear-data').addEventListener('click', function () {
  var args = {
    history: document.getElementById('iris-clear-history').checked,
    cookies: document.getElementById('iris-clear-cookies').checked,
    cache: document.getElementById('iris-clear-cache').checked
  }
  if (!args.history && !args.cookies && !args.cache) return
  document.getElementById('iris-clear-status').textContent = 'Clearing…'
  irisAction('clearData', args)
})

/* --- History ------------------------------------------------------------ */

var irisHistorySearch = document.getElementById('iris-history-search')
var irisHistoryList = document.getElementById('iris-history-list')
var irisHistoryTimer = null

function irisLoadHistory () {
  irisAction('historyList', { query: irisHistorySearch.value.trim() })
}

function irisDayLabel (ms) {
  var d = new Date(ms)
  var today = new Date()
  var y = new Date()
  y.setDate(y.getDate() - 1)
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === y.toDateString()) return 'Yesterday'
  return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })
}

function irisRenderHistory (items, total) {
  irisHistoryList.innerHTML = ''
  if (!items.length) {
    irisHistoryList.appendChild(irisEmptyLine(irisHistorySearch.value ? 'Nothing in your history matches that.' : 'No history yet.'))
    return
  }
  var lastDay = ''
  items.forEach(function (it) {
    var day = irisDayLabel(it.lastVisit)
    if (day !== lastDay) {
      lastDay = day
      var h = document.createElement('div')
      h.className = 'iris-list-day'
      h.textContent = day
      irisHistoryList.appendChild(h)
    }
    var row = document.createElement('div')
    row.className = 'iris-list-row'
    var time = document.createElement('span')
    time.className = 'iris-list-time'
    time.textContent = new Date(it.lastVisit).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    var link = document.createElement('a')
    link.className = 'iris-list-main'
    link.href = it.url
    link.title = it.url
    var t = document.createElement('span')
    t.className = 'iris-list-title'
    t.textContent = it.title || it.url
    var u = document.createElement('span')
    u.className = 'iris-list-sub'
    u.textContent = it.url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 90)
    link.appendChild(t)
    link.appendChild(u)
    var del = document.createElement('button')
    del.type = 'button'
    del.className = 'iris-row-delete'
    del.title = 'Remove from history'
    del.textContent = '×'
    del.addEventListener('click', function () { row.remove(); irisAction('historyDelete', { url: it.url, query: irisHistorySearch.value.trim() }) })
    row.appendChild(time)
    row.appendChild(link)
    row.appendChild(del)
    irisHistoryList.appendChild(row)
  })
  if (total > items.length) irisHistoryList.appendChild(irisEmptyLine('Showing the latest ' + items.length + ' of ' + total + '. Search to find older pages.'))
}

function irisEmptyLine (text) {
  var p = document.createElement('div')
  p.className = 'iris-list-empty'
  p.textContent = text
  return p
}

irisHistorySearch.addEventListener('input', function () {
  clearTimeout(irisHistoryTimer)
  irisHistoryTimer = setTimeout(irisLoadHistory, 200)
})
document.getElementById('iris-history-clear').addEventListener('click', function () {
  if (!confirm('Clear all browsing history? Bookmarks are kept.')) return
  irisAction('clearData', { history: true })
})
irisLoadHistory()

/* --- Cookies & site data ------------------------------------------------ */

var irisCookieSites = []
var irisCookiesSearch = document.getElementById('iris-cookies-search')
var irisCookiesList = document.getElementById('iris-cookies-list')

function irisRenderCookies () {
  var q = irisCookiesSearch.value.trim().toLowerCase()
  var list = irisCookieSites.filter(function (s) { return !q || s.domain.indexOf(q) !== -1 })
  irisCookiesList.innerHTML = ''
  if (!list.length) {
    irisCookiesList.appendChild(irisEmptyLine(q ? 'No site matches that.' : 'No sites have stored cookies.'))
    return
  }
  list.forEach(function (site) {
    var row = document.createElement('div')
    row.className = 'iris-list-row'
    var main = document.createElement('div')
    main.className = 'iris-list-main'
    var t = document.createElement('span')
    t.className = 'iris-list-title'
    t.textContent = site.domain
    var u = document.createElement('span')
    u.className = 'iris-list-sub'
    u.textContent = site.count + (site.count === 1 ? ' cookie' : ' cookies')
    main.appendChild(t)
    main.appendChild(u)
    var del = document.createElement('button')
    del.type = 'button'
    del.className = 'iris-button'
    del.textContent = 'Remove'
    del.addEventListener('click', function () { del.disabled = true; irisAction('cookiesRemove', { domain: site.domain }) })
    row.appendChild(main)
    row.appendChild(del)
    irisCookiesList.appendChild(row)
  })
}

irisCookiesSearch.addEventListener('input', irisRenderCookies)
document.getElementById('iris-cookies-clear').addEventListener('click', function () {
  if (!confirm('Remove cookies and site data for every site? You will be signed out everywhere.')) return
  irisAction('clearData', { cookies: true })
})
irisAction('cookiesList')

/* sidebar: highlight the section in view */
var irisNavLinks = Array.prototype.slice.call(document.querySelectorAll('#iris-settings-nav a'))
var irisSections = irisNavLinks.map(function (a) { return document.querySelector(a.getAttribute('href')) }).filter(Boolean)
var irisSpy = new IntersectionObserver(function (entries) {
  entries.forEach(function (en) {
    if (!en.isIntersecting) return
    irisNavLinks.forEach(function (a) { a.classList.toggle('is-current', a.getAttribute('href') === '#' + en.target.id) })
  })
}, { rootMargin: '-8% 0px -88% 0px' })
irisSections.forEach(function (sec) { irisSpy.observe(sec) })

/* --- Usage ------------------------------------------------------------- */

function irisFormatCount (n) {
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M'
  if (n >= 1e4) return Math.round(n / 1e3) + 'K'
  return String(n)
}

function irisRenderUsage (usage) {
  var days = (usage && usage.days) || {}
  var keyOf = function (d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') }
  var sum = function (n) {
    var t = { tasks: 0, requests: 0, input: 0, output: 0, ms: 0, lookups: 0 }
    Object.keys(days).forEach(function (k) {
      if (n !== null) {
        var cutoff = new Date()
        cutoff.setDate(cutoff.getDate() - (n - 1))
        if (k < keyOf(cutoff)) return
      }
      Object.keys(t).forEach(function (f) { t[f] += days[k][f] || 0 })
    })
    return t
  }
  var rows = [['Today', sum(1)], ['Last 7 days', sum(7)], ['Last 30 days', sum(30)], ['All time', sum(null)]]
  var html = '<tr><th></th><th>Tasks</th><th>Requests</th><th>Input tokens</th><th>Output tokens</th><th>Look-ups</th><th>Avg. per step</th></tr>'
  rows.forEach(function (r) {
    var t = r[1]
    html += '<tr><th>' + r[0] + '</th><td>' + irisFormatCount(t.tasks) + '</td><td>' + irisFormatCount(t.requests) + '</td><td>' + irisFormatCount(t.input) +
      '</td><td>' + irisFormatCount(t.output) + '</td><td>' + irisFormatCount(t.lookups) + '</td><td>' + (t.requests ? (t.ms / t.requests / 1000).toFixed(1) + ' s' : '–') + '</td></tr>'
  })
  document.getElementById('iris-usage-table').innerHTML = html
}

settings.listen('irisUsage', irisRenderUsage)

/* --- Skills ------------------------------------------------------------ */

var irisSkillsList = document.getElementById('iris-skills-list')

function irisRenderSkills (all) {
  all = all || {}
  irisSkillsList.innerHTML = ''
  var sites = Object.keys(all).filter(function (k) { return all[k] && all[k].length })
  if (!sites.length) {
    irisSkillsList.appendChild(irisEmptyLine('Nothing learned yet.'))
    return
  }
  sites.sort().forEach(function (site) {
    all[site].forEach(function (t, i) {
      var row = document.createElement('div')
      row.className = 'iris-row iris-skill-row'
      var name = document.createElement('b')
      name.textContent = site
      var tip = document.createElement('span')
      tip.className = 'iris-skill-tip'
      tip.textContent = t.tip
      var del = document.createElement('button')
      del.type = 'button'
      del.className = 'iris-row-delete'
      del.title = 'Forget this'
      del.textContent = '×'
      del.addEventListener('click', function () {
        var copy = JSON.parse(JSON.stringify(all))
        copy[site].splice(i, 1)
        settings.set('irisSkills', copy)
      })
      row.appendChild(name)
      row.appendChild(tip)
      row.appendChild(del)
      irisSkillsList.appendChild(row)
    })
  })
}

settings.listen('irisSkills', irisRenderSkills)

var irisPlaybooksList = document.getElementById('iris-playbooks-list')

function irisRenderPlaybooks (list) {
  list = Array.isArray(list) ? list : []
  irisPlaybooksList.innerHTML = ''
  if (!list.length) {
    irisPlaybooksList.appendChild(irisEmptyLine('None yet. Finish a task with Smart on to keep its plan.'))
    return
  }
  list.slice().reverse().forEach(function (p) {
    var row = document.createElement('div')
    row.className = 'iris-row iris-playbook-row'
    var main = document.createElement('details')
    main.className = 'iris-playbook'
    var sum = document.createElement('summary')
    sum.textContent = p.task
    var meta = document.createElement('span')
    meta.className = 'iris-list-sub'
    meta.textContent = '  ' + new Date(p.at).toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' · ' + p.steps + ' steps' + (p.sites && p.sites.length ? ' · ' + p.sites.slice(0, 3).join(', ') : '')
    sum.appendChild(meta)
    var plan = document.createElement('pre')
    plan.textContent = p.plan
    main.appendChild(sum)
    main.appendChild(plan)
    var del = document.createElement('button')
    del.type = 'button'
    del.className = 'iris-row-delete'
    del.title = 'Forget this plan'
    del.textContent = '×'
    del.addEventListener('click', function () {
      settings.set('irisPlaybooks', list.filter(function (x) { return x !== p }))
    })
    row.appendChild(main)
    row.appendChild(del)
    irisPlaybooksList.appendChild(row)
  })
}

settings.listen('irisPlaybooks', irisRenderPlaybooks)

/* --- Rules ------------------------------------------------------------- */

var irisRulesText = document.getElementById('iris-rules-text')
irisRulesText.addEventListener('change', function () {
  settings.set('irisRules', irisRulesText.value.trim())
})
settings.listen('irisRules', function (value) {
  if (document.activeElement !== irisRulesText) irisRulesText.value = value || ''
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

/* --- Accounts Iris created -------------------------------------------- */

var irisAccountsList = document.getElementById('iris-accounts-list')

function irisRenderAccounts (data) {
  var accounts = (data && data.accounts) || []
  irisAccountsList.innerHTML = ''
  if (!accounts.length) {
    irisAccountsList.appendChild(irisEmptyLine('None yet. Accounts Iris creates for you appear here, with the link and why they were made.'))
    return
  }
  accounts.forEach(function (a) {
    var row = document.createElement('div')
    row.className = 'iris-row iris-account-row'
    var site = document.createElement('div')
    site.className = 'iris-account-site'
    var siteName = document.createElement(a.url ? 'a' : 'b')
    siteName.textContent = a.site
    if (a.url) { siteName.href = a.url; siteName.title = a.url }
    site.appendChild(siteName)
    var meta = document.createElement('span')
    meta.className = 'iris-list-sub'
    meta.textContent = [a.purpose ? 'For: ' + a.purpose : '', a.created ? 'Created ' + new Date(a.created).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : ''].filter(Boolean).join(' · ')
    if (meta.textContent) site.appendChild(meta)
    var user = document.createElement('span')
    user.className = 'iris-account-user'
    user.textContent = a.username
    var pw = document.createElement('span')
    pw.className = 'iris-account-pw'
    var shown = data.revealed && data.revealed.site === a.site && data.revealed.username === a.username
    pw.textContent = shown ? data.revealed.password : '••••••••' + (a.passwordFrom ? '  (' + a.passwordFrom + ')' : '')
    var show = document.createElement('button')
    show.type = 'button'
    show.className = 'iris-button'
    show.textContent = shown ? 'Hide' : 'Show'
    show.addEventListener('click', function () {
      if (shown) irisRenderAccounts({ accounts: accounts })
      else postMessage({ message: 'irisAccountReveal', site: a.site, username: a.username })
    })
    var del = document.createElement('button')
    del.type = 'button'
    del.className = 'iris-row-delete'
    del.title = 'Remove from this list'
    del.textContent = '×'
    del.addEventListener('click', function () { postMessage({ message: 'irisAccountDelete', site: a.site, username: a.username }) })
    row.appendChild(site)
    row.appendChild(user)
    row.appendChild(pw)
    row.appendChild(show)
    row.appendChild(del)
    irisAccountsList.appendChild(row)
  })
}

window.addEventListener('message', function (e) {
  if (e.data && e.data.message === 'irisAccountsData') irisRenderAccounts(e.data.data)
})
postMessage({ message: 'irisAccountsGet' })

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

/* --- Coding agents (MCP bridge) ------------------------------------------ */

var irisBridgeCheckbox = document.getElementById('checkbox-iris-bridge')
var irisBridgeConfig = document.getElementById('iris-bridge-config')
var irisBridgeStatus = document.getElementById('iris-bridge-status')

settings.get('irisBridge', function (v) {
  irisBridgeCheckbox.checked = v === true
  document.getElementById('iris-bridge-help').hidden = v !== true
})
irisBridgeCheckbox.addEventListener('change', function () {
  settings.set('irisBridge', this.checked)
  document.getElementById('iris-bridge-help').hidden = !this.checked
  setTimeout(function () { irisAction('bridgeInfo') }, 400)
})

window.addEventListener('message', function (e) {
  if (!e.data || e.data.message !== 'irisSettingsActionResult' || !e.data.data || e.data.data.action !== 'bridgeInfo') return
  var r = e.data.data.result || {}
  irisBridgeConfig.textContent = JSON.stringify({ mcpServers: { iris: { command: 'node', args: [r.script || 'iris-mcp.js'] } } }, null, 2)
  irisBridgeStatus.textContent = r.running ? 'Listening on this Mac only (port ' + r.port + ')' + (r.lastUse ? ' · last used ' + new Date(r.lastUse).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '') : (r.enabled ? 'Starting…' : '')
})
document.getElementById('iris-bridge-copy').addEventListener('click', function () {
  navigator.clipboard.writeText(irisBridgeConfig.textContent).then(function () { irisBridgeStatus.textContent = 'Copied.' })
})
irisAction('bridgeInfo')

/* --- Your skills ----------------------------------------------------------- */

var irisUserSkillsEl = document.getElementById('iris-user-skills')
var irisUserSkills = []

function irisSaveUserSkills () {
  settings.set('irisUserSkills', irisUserSkills.filter(function (s) { return s.text || s.when || s.name }))
}

function irisRenderUserSkills () {
  irisUserSkillsEl.innerHTML = ''
  if (!irisUserSkills.length) {
    irisUserSkillsEl.appendChild(irisEmptyLine('None yet. Example — words: "flight, train"; do: "Prefer direct trips, and check the price on two sites before choosing."'))
    return
  }
  irisUserSkills.forEach(function (sk, i) {
    var row = document.createElement('div')
    row.className = 'iris-user-skill'
    var top = document.createElement('div')
    top.className = 'iris-user-skill-top'
    var name = document.createElement('input')
    name.type = 'text'
    name.placeholder = 'Name (e.g. Job search)'
    name.value = sk.name || ''
    name.addEventListener('change', function () { sk.name = name.value.trim(); irisSaveUserSkills() })
    var when = document.createElement('input')
    when.type = 'text'
    when.placeholder = 'When the task mentions… (words, comma-separated)'
    when.value = sk.when || ''
    when.addEventListener('change', function () { sk.when = when.value.trim(); irisSaveUserSkills() })
    var del = document.createElement('button')
    del.type = 'button'
    del.className = 'iris-row-delete'
    del.title = 'Delete this skill'
    del.textContent = '×'
    del.addEventListener('click', function () { irisUserSkills.splice(i, 1); irisSaveUserSkills(); irisRenderUserSkills() })
    top.appendChild(name)
    top.appendChild(when)
    top.appendChild(del)
    var text = document.createElement('textarea')
    text.rows = 2
    text.placeholder = 'What Iris should do'
    text.value = sk.text || ''
    text.addEventListener('change', function () { sk.text = text.value.trim(); irisSaveUserSkills() })
    row.appendChild(top)
    row.appendChild(text)
    irisUserSkillsEl.appendChild(row)
  })
}

document.getElementById('iris-user-skill-add').addEventListener('click', function () {
  irisUserSkills.push({ name: '', when: '', text: '' })
  irisRenderUserSkills()
  var inputs = irisUserSkillsEl.querySelectorAll('input')
  if (inputs.length) inputs[inputs.length - 2].focus()
})

settings.listen('irisUserSkills', function (value) {
  if (irisUserSkillsEl.contains(document.activeElement)) return
  irisUserSkills = Array.isArray(value) ? value.map(function (s) { return Object.assign({}, s) }) : []
  irisRenderUserSkills()
})

/* --- Downloads ------------------------------------------------------------ */

function irisBytes (n) {
  if (n >= 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(1) + ' GB'
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB'
  return Math.max(1, Math.round(n / 1024)) + ' KB'
}

function irisRenderDownloads (r) {
  var list = document.getElementById('iris-downloads-list')
  document.getElementById('iris-downloads-dir').textContent = (r.dir || 'your download folder').replace(/^\/Users\/[^/]+/, '~')
  list.innerHTML = ''
  var files = r.files || []
  if (!files.length) {
    list.appendChild(irisEmptyLine('Nothing downloaded yet.'))
    return
  }
  files.forEach(function (f) {
    var row = document.createElement('div')
    row.className = 'iris-list-row'
    var main = document.createElement('div')
    main.className = 'iris-list-main'
    var t = document.createElement('span')
    t.className = 'iris-list-title'
    t.textContent = f.name
    var sub = document.createElement('span')
    sub.className = 'iris-list-sub'
    sub.textContent = irisBytes(f.bytes) + ' · ' + new Date(f.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    main.appendChild(t)
    main.appendChild(sub)
    var show = document.createElement('button')
    show.type = 'button'
    show.className = 'iris-button'
    show.textContent = 'Show in Finder'
    show.addEventListener('click', function () { irisAction('downloadShow', { name: f.name }) })
    row.appendChild(main)
    row.appendChild(show)
    list.appendChild(row)
  })
}

irisAction('downloadsList')
