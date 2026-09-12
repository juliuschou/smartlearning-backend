import http from 'node:http';
const received = [];
http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    try {
      const j = JSON.parse(body);
      for (const a of j.alerts ?? []) {
        received.push({ alert: a.labels.alertname, status: a.status?.state ?? j.status, ts: Date.now() });
        console.log(`[webhook] ${j.status} alertname=${a.labels.alertname} state=${a.status?.state}`);
      }
    } catch { console.log('[webhook] unparsable', body.slice(0,120)); }
    res.end('ok');
  });
}).listen(3999, '127.0.0.1', () => console.log('[webhook] listening on 3999'));
process.on('SIGTERM', () => { console.log(JSON.stringify(received)); process.exit(0); });
