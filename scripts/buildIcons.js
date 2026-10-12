/*
 * Builds the macOS application icon from icons/source/iris.svg.
 *
 *   node ./scripts/buildIcons.js
 *
 * The SVG is rasterised at 1024 (actually 2048 on a Retina capture) with
 * scripts/renderIcon.js, then sips + iconutil produce icons/icon.icns and the
 * PNG sizes used by the window manager and the agent panel.
 */

const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const setDir = path.join(root, 'build', 'icon.iconset')
const source = path.join(root, 'build', 'iris-1024.png')

const sizes = [16, 32, 64, 128, 256, 512, 1024]

function run (cmd, args) {
  execFileSync(cmd, args, { stdio: 'inherit' })
}

if (!fs.existsSync(source)) {
  run('npx', ['electron', path.join(__dirname, 'renderIcon.js'), source])
}

fs.rmSync(setDir, { recursive: true, force: true })
fs.mkdirSync(setDir, { recursive: true })

sizes.forEach(size => {
  const file = path.join(setDir, `icon_${size}x${size}.png`)
  run('sips', ['-z', String(size), String(size), source, '--out', file])
})

// @2x variants are the same files under the retina names iconutil expects
;[[16, 32], [32, 64], [64, 128], [128, 256], [256, 512]].forEach(([base, retina]) => {
  fs.copyFileSync(
    path.join(setDir, `icon_${retina}x${retina}.png`),
    path.join(setDir, `icon_${base}x${base}@2x.png`)
  )
})

run('iconutil', ['-c', 'icns', setDir, '-o', path.join(root, 'icons', 'icon.icns')])

// the plain PNG that Linux builds and the dev tools pick up
run('sips', ['-z', '256', '256', source, '--out', path.join(root, 'icons', 'icon256.png')])

console.log('icons/icon.icns and icons/icon256.png rebuilt from icons/source/iris.svg')
