import { test } from 'node:test'
import assert from 'node:assert/strict'

import { checkAllowedUrl, sanitizeOpenUrl } from '../lib/service.js'
import { lightPageFor } from '../lib/tabs.js'

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

test('lightPageFor: 轻量页是域的 robots.txt', () => {
  assert.equal(lightPageFor('a.com'), 'https://a.com/robots.txt')
})
