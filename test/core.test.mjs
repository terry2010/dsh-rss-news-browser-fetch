import { test } from 'node:test'
import assert from 'node:assert/strict'

import { checkAllowedUrl, sanitizeOpenUrl, normalizeInit, validateDomainFormat } from '../lib/service.js'
import { lightPageFor } from '../lib/tabs.js'
import { classifyExit, CloseCounter } from '../lib/instance.js'
import { hostAllowed, originAllowed, trusted, resolveWebPath } from '../lib/ui.js'

test('checkAllowedUrl: 未声明域拒绝', () => {
  const declared = new Set(['a.com'])
  assert.throws(() => checkAllowedUrl(declared, 'b.com', 'https://b.com/x'), /not declared/)
})

test('checkAllowedUrl: 精确 host 放行；子域拒绝（页面 origin 是精确域，子域必然 CORS 失败）', () => {
  const declared = new Set(['a.com'])
  checkAllowedUrl(declared, 'a.com', 'https://a.com/api?x=1')
  assert.throws(() => checkAllowedUrl(declared, 'a.com', 'https://sub.a.com/api'), /!= declared domain/)
})

test('checkAllowedUrl: 大小写归一 + 坏 URL 拒绝', () => {
  const declared = new Set(['a.com'])
  checkAllowedUrl(declared, 'A.COM', 'https://A.COM/x')
  assert.throws(() => checkAllowedUrl(declared, 'a.com', 'not a url'), /bad url/)
  assert.throws(() => checkAllowedUrl(declared, 'a.com', 'file:///etc/passwd'), /!= declared domain/)
  assert.throws(() => checkAllowedUrl(declared, 'a.com', 'javascript:alert(1)'), /!= declared domain/)
})

test('checkAllowedUrl: http 拒绝——页面 origin 固定 https，http fetch 是混合内容必被拦', () => {
  const declared = new Set(['a.com'])
  assert.throws(() => checkAllowedUrl(declared, 'a.com', 'http://a.com/api'), /https/)
})

test('validateDomainFormat: 纯 host 放行；scheme/端口/路径/杂字符拒绝', () => {
  for (const ok of ['api.example.com', 'localhost', 'a.b.c.d', '[::1]', 'xn--fiqs8s']) {
    assert.doesNotThrow(() => validateDomainFormat(ok), ok)
  }
  for (const bad of ['https://a.com', 'a.com:8080', 'a.com/x', 'a b.com', '.a.com', 'a.com.', 'a..b', '']) {
    assert.throws(() => validateDomainFormat(bad), /invalid domain/, bad)
  }
})

test('sanitizeOpenUrl: 空值 → about:blank；http(s) 放行；危险协议拒绝', () => {
  assert.equal(sanitizeOpenUrl(), 'about:blank')
  assert.equal(sanitizeOpenUrl('  '), 'about:blank')
  assert.equal(sanitizeOpenUrl('about:blank'), 'about:blank')
  assert.equal(sanitizeOpenUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1')
  assert.equal(sanitizeOpenUrl('http://x.cn'), 'http://x.cn')
  for (const u of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,<h1>x</h1>', 'chrome://settings']) {
    assert.throws(() => sanitizeOpenUrl(u), /只允许/)
  }
})

test('normalizeInit: Headers/键值对数组归一为 plain object（JSON.stringify 会把它们静默吞成 {}）', () => {
  assert.deepEqual(normalizeInit(), {})
  assert.deepEqual(normalizeInit(undefined), {})
  assert.deepEqual(
    normalizeInit({ method: 'POST', headers: new Headers({ a: '1' }), body: 'x', credentials: 'include' }),
    { method: 'POST', headers: { a: '1' }, body: 'x', credentials: 'include' },
  )
  assert.deepEqual(normalizeInit({ headers: [['b', '2']] }), { headers: { b: '2' } })
  assert.deepEqual(normalizeInit({ headers: { c: '3' } }), { headers: { c: '3' } })
})

test('normalizeInit: 不认识的 key / 非 string 值显式报错，而不是序列化时静默丢字段', () => {
  assert.throws(() => normalizeInit({ signal: AbortSignal.timeout(9) }), /signal/)
  assert.throws(() => normalizeInit({ mode: 'cors' }), /mode/)
  assert.throws(() => normalizeInit({ body: 42 }), /body/)
  assert.throws(() => normalizeInit({ headers: { a: 1 } }), /headers/)
  assert.throws(() => normalizeInit('GET'), /must be an object/)
})

test('classifyExit: ours/boot-fail/crash/user 分类矩阵——启动期退出（单例交接）不算用户关闭', () => {
  assert.equal(classifyExit(0, null, true, false), 'ours')
  assert.equal(classifyExit(null, 'SIGTERM', true, false), 'ours')
  assert.equal(classifyExit(0, null, false, true), 'boot-fail')
  assert.equal(classifyExit(1, null, false, true), 'boot-fail')
  assert.equal(classifyExit(1, null, false, false), 'crash')
  assert.equal(classifyExit(null, 'SIGSEGV', false, false), 'crash')
  assert.equal(classifyExit(null, 'SIGABRT', false, false), 'crash')
  assert.equal(classifyExit(0, null, false, false), 'user')
  assert.equal(classifyExit(null, 'SIGTERM', false, false), 'user')
  assert.equal(classifyExit(null, 'SIGKILL', false, false), 'user')
})

test('CloseCounter: 连关 3 次转暂停；只有 resume() 清零——自动重拉（spawn 成功）不清零', () => {
  const c = new CloseCounter(3)
  c.bump(); c.bump()
  assert.equal(c.paused, false)
  assert.equal(c.count, 2)
  c.bump()
  assert.equal(c.paused, true)
  c.resume()
  assert.equal(c.paused, false)
  assert.equal(c.count, 0)
  c.bump(); c.bump()
  assert.equal(c.paused, false, 'resume 后重新累积')
  c.bump()
  assert.equal(c.paused, true)
})

test('hostAllowed: 仅 loopback——DNS 重绑定/局域网主机名一律拒绝', () => {
  assert.equal(hostAllowed('127.0.0.1:7018'), true)
  assert.equal(hostAllowed('localhost'), true)
  assert.equal(hostAllowed('LOCALHOST:8080'), true)
  assert.equal(hostAllowed('[::1]:8080'), true)
  assert.equal(hostAllowed('evil.com'), false)
  assert.equal(hostAllowed('localhost.evil.com'), false)
  assert.equal(hostAllowed('127.0.0.1.evil.com'), false)
  assert.equal(hostAllowed('192.168.1.5:7018'), false)
  assert.equal(hostAllowed(undefined), false)
})

test('originAllowed: Origin 存在必须与 Host 一致；缺失放行；null（file://）拒绝', () => {
  assert.equal(originAllowed('http://127.0.0.1:7018', '127.0.0.1:7018'), true)
  assert.equal(originAllowed('http://evil.com', '127.0.0.1:7018'), false)
  assert.equal(originAllowed('null', '127.0.0.1:7018'), false)
  assert.equal(originAllowed('not a url', '127.0.0.1:7018'), false)
  assert.equal(originAllowed(undefined, '127.0.0.1:7018'), true)
})

test('trusted: 三道防线合体——Host 不对直接 403', () => {
  assert.equal(trusted({ headers: { host: '127.0.0.1:7018', 'sec-fetch-site': 'same-origin' } }), true)
  assert.equal(trusted({ headers: { host: 'evil.com', 'sec-fetch-site': 'same-origin' } }), false)
  assert.equal(trusted({ headers: { host: '127.0.0.1:7018', 'sec-fetch-site': 'cross-site' } }), false)
  // DNS 重绑定：sec-fetch-site 是 same-origin，靠 Host 校验挡住
  assert.equal(trusted({ headers: { host: 'evil.com', 'sec-fetch-site': 'same-origin', origin: 'http://evil.com' } }), false)
  // curl：无 Origin、无 sec-fetch-site，Host 对即放行
  assert.equal(trusted({ headers: { host: '127.0.0.1:7018' } }), true)
})

test('resolveWebPath: 遍历拒绝；合法路径保留（.. 字符删除的误伤不再存在）', () => {
  assert.equal(resolveWebPath('/srv/web', 'index.html'), '/srv/web/index.html')
  assert.equal(resolveWebPath('/srv/web', 'sub/a.js'), '/srv/web/sub/a.js')
  assert.equal(resolveWebPath('/srv/web', 'a..b.js'), '/srv/web/a..b.js')
  assert.equal(resolveWebPath('/srv/web', 'index.html?theme=dark'), '/srv/web/index.html')
  assert.equal(resolveWebPath('/srv/web', '../package.json'), undefined)
  assert.equal(resolveWebPath('/srv/web', '../../etc/passwd'), undefined)
  assert.equal(resolveWebPath('/srv/web', '/etc/passwd'), undefined)
  assert.equal(resolveWebPath('/srv/web', ''), '/srv/web')
})

test('lightPageFor: 轻量页是域的 robots.txt', () => {
  assert.equal(lightPageFor('a.com'), 'https://a.com/robots.txt')
})
