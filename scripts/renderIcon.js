/*
 * Rasterises icons/source/iris.svg into a 1024x1024 PNG with transparency.
 *
 *   npx electron scripts/renderIcon.js [out.png]
 *
 * scripts/buildIcons.js then cuts that into an .iconset and runs iconutil.
 * Chromium is used as the rasteriser so the icon stays a single vector source.
 */

const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')

const out = process.argv.find((arg, i) => i > 1 && !arg.startsWith('-')) || path.join(__dirname, '..', 'build', 'iris-1024.png')

app.commandLine.appendSwitch('disable-gpu')

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: { sandbox: false }
  })

  await win.loadFile(path.join(__dirname, '..', 'icons', 'source', 'iris.svg'))
  await new Promise(resolve => setTimeout(resolve, 400))

  const image = await win.webContents.capturePage()
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, image.toPNG())
  console.log('wrote', out, JSON.stringify(image.getSize()))
  app.exit(0)
})
