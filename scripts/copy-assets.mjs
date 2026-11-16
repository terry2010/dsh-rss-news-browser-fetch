/** build 后把 web/ 拷进 lib/web/（serveStatic 从 lib/web 读；tsc 不复制非 ts 文件）。 */
import { cpSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
mkdirSync(join(root, 'lib'), { recursive: true })
cpSync(join(root, 'web'), join(root, 'lib', 'web'), { recursive: true })
console.log('copied: web/ -> lib/web/')
