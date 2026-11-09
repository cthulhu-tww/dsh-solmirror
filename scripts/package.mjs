/**
 * 打包发布 zip：把根目录插件文件收进 dsh-solmirror/ 目录，压成 dsh-solmirror.zip。
 *
 * 用法：
 *   node scripts/package.mjs                 # 只产出 dsh-solmirror.zip
 *   node scripts/package.mjs --mirror <目录>  # 产包后另存一份到指定目录（如发布镜像）
 *
 * 依赖系统 tar：Windows 自带 bsdtar、macOS 同为 bsdtar（-a 按扩展名输出 zip）；
 * Linux GNU tar 不支持 zip 格式，需要自备 bsdtar。
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, cpSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const FILES = [
  'index.js', 'client.js', 'upload.js',
  'cordis.patch.yml', 'package.json', 'README.md', 'LICENSE',
]

const mirrorIdx = process.argv.indexOf('--mirror')
const mirror = mirrorIdx > -1 ? resolve(process.argv[mirrorIdx + 1] ?? '') : null

const stage = join(root, '.zipstage')
rmSync(stage, { recursive: true, force: true })
mkdirSync(join(stage, 'dsh-solmirror'), { recursive: true })
for (const file of FILES) cpSync(join(root, file), join(stage, 'dsh-solmirror', file))

execFileSync('tar', ['-a', '-cf', 'dsh-solmirror.zip', '-C', stage, 'dsh-solmirror'],
  { cwd: root, stdio: 'inherit' })
rmSync(stage, { recursive: true, force: true })

if (mirror) {
  mkdirSync(mirror, { recursive: true })
  copyFileSync(join(root, 'dsh-solmirror.zip'), join(mirror, 'dsh-solmirror.zip'))
  console.log(`mirror → ${join(mirror, 'dsh-solmirror.zip')}`)
}
console.log('done: dsh-solmirror.zip')
