// iPhone 実機確認用のローカルサーバー。外部パッケージは使わない。
//
//   node tools/dev-server.mjs          HTTPS（自己署名証明書）で :8443 に配信
//   node tools/dev-server.mjs --http   HTTP で :8080 に配信（PC の localhost 確認用）
//   node tools/dev-server.mjs --port 9443
//
// 証明書が無ければ openssl で tools/.cert/ に作る（有効期限 825 日）。
// カメラは HTTPS か localhost でしか使えないため、実機では HTTPS 側を使うこと。

import http from 'node:http';
import https from 'node:https';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { dirname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CERT_DIR = join(HERE, '.cert');
const KEY_FILE = join(CERT_DIR, 'key.pem');
const CRT_FILE = join(CERT_DIR, 'cert.pem');

const args = process.argv.slice(2);
const useHttp = args.includes('--http');
const portArg = args.indexOf('--port');
const PORT = portArg >= 0 && args[portArg + 1] ? Number(args[portArg + 1]) : (useHttp ? 8080 : 8443);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function lanAddress() {
  const nets = networkInterfaces();
  const found = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) found.push(net.address);
    }
  }
  // 192.168.x.x / 10.x.x.x を優先する
  return found.find((a) => a.startsWith('192.168.')) || found.find((a) => a.startsWith('10.')) || found[0] || '127.0.0.1';
}

function ensureCert(ip) {
  if (existsSync(KEY_FILE) && existsSync(CRT_FILE)) return;
  mkdirSync(CERT_DIR, { recursive: true });
  const san = `subjectAltName=DNS:localhost,IP:127.0.0.1,IP:${ip}`;
  console.log(`自己署名証明書を作ります（${san}）`);
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256',
      '-days', '825',
      '-keyout', KEY_FILE,
      '-out', CRT_FILE,
      '-subj', '/CN=camera-prompter-dev',
      '-addext', san
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (err) {
    console.error('openssl で証明書を作れませんでした。openssl をインストールするか、--http を使ってください。');
    console.error(String(err.stderr || err.message || err));
    process.exit(1);
  }
}

function resolveFile(urlPath) {
  let p = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  if (p === '/' || p === '') p = '/index.html';
  const full = normalize(join(ROOT, p));
  // プロジェクトの外には出さない
  if (!full.startsWith(ROOT + sep) && full !== ROOT) return null;
  // 証明書の置き場（秘密鍵がある）は配信しない。証明書そのものは /cert.pem から渡す
  if (full === CERT_DIR || full.startsWith(CERT_DIR + sep)) return null;
  try {
    const st = statSync(full);
    if (st.isDirectory()) {
      const idx = join(full, 'index.html');
      return existsSync(idx) ? idx : null;
    }
    return full;
  } catch {
    return null;
  }
}

function handler(req, res) {
  const path = (req.url || '/').split('?')[0];

  /* iPhone にこの証明書を信頼させたいとき用。公開鍵の証明書だけを渡す（秘密鍵は渡さない）。
     iOS がプロファイルとして扱えるよう MIME を x-x509-ca-cert にする。 */
  if (!useHttp && (path === '/cert.pem' || path === '/cert')) {
    try {
      const pem = readFileSync(CRT_FILE);
      res.writeHead(200, {
        'content-type': 'application/x-x509-ca-cert',
        'content-disposition': 'attachment; filename="prompter-dev.pem"',
        'cache-control': 'no-store'
      });
      res.end(pem);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('証明書がありません');
    }
    return;
  }

  const file = resolveFile(req.url || '/');
  if (!file) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
    return;
  }
  const ext = file.slice(file.lastIndexOf('.')).toLowerCase();
  res.writeHead(200, {
    'content-type': TYPES[ext] || 'application/octet-stream',
    // 開発中は毎回読み直す（Service Worker のキャッシュは別なので README 参照）
    'cache-control': 'no-store',
    'service-worker-allowed': '/'
  });
  createReadStream(file).pipe(res);
}

const ip = lanAddress();
let server;

if (useHttp) {
  server = http.createServer(handler);
} else {
  ensureCert(ip);
  server = https.createServer({ key: readFileSync(KEY_FILE), cert: readFileSync(CRT_FILE) }, handler);
}

server.listen(PORT, '0.0.0.0', () => {
  const scheme = useHttp ? 'http' : 'https';
  console.log('');
  console.log('  カメラ付きプロンプター 開発サーバー');
  console.log('  ------------------------------------------------');
  console.log(`  このPC   : ${scheme}://localhost:${PORT}/`);
  console.log(`  iPhone   : ${scheme}://${ip}:${PORT}/`);
  console.log('');
  if (!useHttp) {
    console.log('  自己署名証明書なので、iPhone の Safari で警告が出ます。');
    console.log('  「詳細を表示」→「この Web サイトを閲覧」で進んでください。');
    console.log('');
    console.log('  ホーム画面のアイコンから起動したい／オフラインも試したいときは、');
    console.log(`  iPhone で https://${ip}:${PORT}/cert.pem を開いて証明書を信頼させてください`);
    console.log('  （手順は README の 3-B）。信頼させるまでは警告のせいでアイコン起動できません。');
  } else {
    console.log('  HTTP なのでカメラは localhost でしか使えません（iPhone からは不可）。');
  }
  console.log('');
  console.log('  Ctrl+C で終了');
  console.log('');
});
