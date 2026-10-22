import http from 'node:http';
import { readFile } from 'node:fs/promises';

export async function dashboard(config, status, telegram) {
  const page = await readFile(new URL('../public/index.html', import.meta.url));
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'");
    try {
      if (req.method === 'GET' && req.url === '/') { res.setHeader('Content-Type','text/html; charset=utf-8'); return res.end(page); }
      if (req.method === 'GET' && ['/api/status','/healthz'].includes(req.url)) {
        const result = status();
        if (req.url === '/healthz') res.statusCode = result.ready ? 200 : 503;
        res.setHeader('Content-Type','application/json');
        return res.end(JSON.stringify(result));
      }
      // Only needed if the Telegram account already has two-step verification enabled.
      // The monitoring page itself never has a password or login gate.
      if (req.method === 'POST' && req.url === '/internal/telegram-password') {
        if (!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) { res.statusCode=403; return res.end('Local setup only'); }
        let body = '';
        for await (const chunk of req) { body += chunk; if (body.length > 1024) { res.statusCode=413; return res.end(); } }
        telegram.providePassword(JSON.parse(body).password);
        return res.end('Accepted');
      }
      res.statusCode=404; res.end('Not found');
    } catch { res.statusCode=400; res.end('Request could not be completed'); }
  });
  await new Promise((resolve,reject) => { server.once('error',reject); server.listen(config.port,config.host,resolve); });
  return server;
}
