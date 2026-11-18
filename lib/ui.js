/**
 * 设置页挂载：静态页 /dsh-rss-news-browser-fetch/ + /api/* JSON 端点。
 * 与主插件同一套 webServer 路由惯例（kind: exact|prefix + sameSite 防护）。
 *
 * 防线（全部路由）：
 *  - Host 只收 loopback——DNS 重绑定下 sec-fetch-site 是 same-origin，挡不住，Host 校验才挡得住
 *  - Origin 头存在时必须与 Host 同源（file:// 的 'null' 拒绝）
 *  - Sec-Fetch-Site != cross-site（现代浏览器跨站请求都带）
 *  - /api/clear 是 rm -rf 级破坏性操作——服务端要求 confirm:true，不依赖前端弹窗
 */
import { readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const BASE = '/dsh-rss-news-browser-fetch';
const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
};
function sendJson(res, status, value) {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(value));
}
function readBody(req, limit = 64 * 1024) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (c) => {
            const buf = c;
            size += buf.length;
            if (size > limit) {
                reject(new Error('body too large'));
                return;
            }
            chunks.push(buf);
        });
        req.on('end', () => {
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
            }
            catch {
                resolve({});
            }
        });
        req.on('error', reject);
    });
}
/** 取头首个值（重复头/数组形态归一）。 */
function first(v) {
    return Array.isArray(v) ? v[0] : v;
}
/** Host 只收 loopback（导出供测试）——设置页只服务本机用户。 */
export function hostAllowed(host) {
    const h = host?.toLowerCase();
    if (!h)
        return false;
    const name = h.startsWith('[')
        ? h.slice(0, h.indexOf(']') + 1) // [::1]:port
        : h.includes(':') ? h.slice(0, h.lastIndexOf(':')) : h; // host:port
    return name === '127.0.0.1' || name === 'localhost' || name === '[::1]';
}
/** Origin 头存在时必须与 Host 同源（导出供测试）；缺失放行——非浏览器客户端
 *  （curl）没有 Origin，由 hostAllowed + sameSite 兜底；'null'（file:// 等）拒绝。 */
export function originAllowed(origin, host) {
    if (!origin)
        return true;
    try {
        return new URL(origin).host === host?.toLowerCase();
    }
    catch {
        return false;
    }
}
/** 同源防护：拒绝 cross-site 请求（现代浏览器跨站请求都带 Sec-Fetch-Site）。 */
function sameSite(req) {
    const site = (first(req.headers?.['sec-fetch-site']) || '').toLowerCase();
    return site !== 'cross-site';
}
/** 三道防线合体（导出供测试）。 */
export function trusted(req) {
    const host = first(req.headers?.host);
    const origin = first(req.headers?.origin);
    return hostAllowed(host) && originAllowed(origin, host) && sameSite(req);
}
/** 把 rel 安全映射进 webDir（导出供测试）：resolve + 前缀校验，杜绝 ../ 遍历；
 *  不做字符删除——`a..b.js` 这类合法文件名不再被误伤。返回 undefined → 404。 */
export function resolveWebPath(webDir, rel) {
    const clean = rel.split(/[?#]/)[0];
    const root = resolve(webDir);
    const file = resolve(root, clean);
    if (file !== root && !file.startsWith(root + sep))
        return undefined;
    return file;
}
async function serveStatic(res, rel) {
    const webDir = join(fileURLToPath(new URL('.', import.meta.url)), 'web');
    const file = resolveWebPath(webDir, rel);
    if (!file)
        return notFound(res);
    try {
        const body = await readFile(file);
        res.statusCode = 200;
        res.setHeader('content-type', MIME[file.slice(file.lastIndexOf('.'))] || 'application/octet-stream');
        res.end(body);
    }
    catch {
        notFound(res);
    }
}
function notFound(res) {
    res.statusCode = 404;
    res.end('not found');
}
/** 注册设置页全部路由；返回 disposer。MOUNT 于 ctx.inject(['webServer']) 内调用。 */
export function mountUi(ws, svc, log) {
    const disposers = [];
    const guard = (fn) => (req, res) => {
        if (!trusted(req)) {
            res.statusCode = 403;
            res.end('forbidden');
            return Promise.resolve();
        }
        return Promise.resolve(fn(req, res)).catch((e) => {
            // 响应可能已结束（客户端断连）——再 setHeader/end 会抛，变成未处理 rejection
            // （Node 默认 --unhandled-rejections=throw，会把整个宿主崩掉），必须兜住
            try {
                if (!res.headersSent)
                    sendJson(res, 500, { ok: false, error: String(e.message || e) });
                else
                    try {
                        res.end();
                    }
                    catch { /* noop */ }
            }
            catch { /* noop */ }
        });
    };
    const post = (fn) => guard(async (req, res) => {
        if (req.method !== 'POST') {
            res.statusCode = 405;
            res.end();
            return;
        }
        const body = (await readBody(req).catch(() => ({})));
        sendJson(res, 200, { ok: true, result: await fn(body) });
    });
    // 静态页
    disposers.push(ws.register({ kind: 'exact', path: `${BASE}/`, handler: guard((_q, r) => serveStatic(r, 'index.html')) }));
    disposers.push(ws.register({ kind: 'exact', path: BASE, handler: guard((_q, r) => serveStatic(r, 'index.html')) }));
    disposers.push(ws.register({ kind: 'prefix', path: `${BASE}/web`, handler: guard((q, r) => serveStatic(r, (q.url || '').replace(`${BASE}/web/`, ''))) }));
    // JSON API
    disposers.push(ws.register({ kind: 'exact', path: `${BASE}/api/status`, handler: guard((_q, r) => sendJson(r, 200, svc.status())) }));
    disposers.push(ws.register({ kind: 'exact', path: `${BASE}/api/open`, handler: post(async (b) => svc.openWindow(typeof b.url === 'string' ? b.url : undefined)) }));
    disposers.push(ws.register({ kind: 'exact', path: `${BASE}/api/clear`, handler: post(async (b) => {
            if (b.confirm !== true)
                throw new Error('需要 confirm:true 确认（此操作关闭实例并删除整个数据目录）');
            await svc.clearAllData();
            return 'cleared';
        }) }));
    disposers.push(ws.register({ kind: 'exact', path: `${BASE}/api/resume`, handler: post(async () => { svc.resume(); return 'resumed'; }) }));
    log.info('browser-fetch settings page mounted');
    return () => { for (const d of disposers)
        d(); };
}
//# sourceMappingURL=ui.js.map