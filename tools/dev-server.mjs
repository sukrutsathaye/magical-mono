#!/usr/bin/env node
/**
 * Zero-dependency HTTP server for the mono-magic Component Showcases portal
 * (`dist/storybook-pages`), binding to 0.0.0.0:3000 by default and respecting
 * `--port`, `--host`, `PORT`, and `HOST`.
 *
 * If the static showcase portal has not been built yet, the server binds
 * immediately on the configured port, runs `npm run build` in the background,
 * and serves an auto-refreshing status page until ready.
 */
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';

function parseCliFlag(names) {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    for (const name of names) {
      if (arg === name && argv[i + 1]) {
        return argv[i + 1];
      }
      if (arg.startsWith(`${name}=`)) {
        return arg.slice(name.length + 1);
      }
    }
  }
  return undefined;
}

const PORT = Number(parseCliFlag(['--port', '-p']) || process.env['PORT'] || 3000);
const HOST = parseCliFlag(['--host', '-h']) || process.env['HOST'] || '0.0.0.0';
const ROOT_DIR = resolve(process.cwd(), 'dist/storybook-pages');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.cjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

let buildState = existsSync(join(ROOT_DIR, 'index.html')) ? 'ready' : 'idle';
let buildError = '';

function ensureBuilt() {
  if (existsSync(join(ROOT_DIR, 'index.html'))) {
    buildState = 'ready';
    return;
  }
  if (buildState === 'building') {
    return;
  }

  buildState = 'building';
  buildError = '';
  console.log('[dev-server] dist/storybook-pages not found — running npm run build...');

  const child = spawn('npm', ['run', 'build'], {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: { ...process.env, NX_DAEMON: 'false' },
  });

  child.on('exit', (code) => {
    if (code === 0 && existsSync(join(ROOT_DIR, 'index.html'))) {
      buildState = 'ready';
      console.log('[dev-server] Component showcases built and ready.');
    } else {
      buildState = 'error';
      buildError = `Build exited with code ${code ?? 'unknown'}`;
      console.error(`[dev-server] ${buildError}`);
    }
  });

  child.on('error', (err) => {
    buildState = 'error';
    buildError = err.message;
    console.error(`[dev-server] Build spawn error: ${err.message}`);
  });
}

function renderStatusHtml(title, message, autoRefresh) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    ${autoRefresh ? '<meta http-equiv="refresh" content="3" />' : ''}
    <title>${title}</title>
    <style>
      :root { color-scheme: light dark; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
        background: #f6f7fb;
        color: #111827;
        padding: 2rem;
      }
      @media (prefers-color-scheme: dark) {
        body { background: #0b1020; color: #f3f4f6; }
      }
      main { max-width: 520px; text-align: center; }
      h1 { margin: 0 0 0.75rem; font-size: 1.5rem; }
      p { margin: 0; opacity: 0.75; line-height: 1.5; }
    </style>
  </head>
  <body>
    <main>
      <h1>${title}</h1>
      <p>${message}</p>
    </main>
  </body>
</html>`;
}

function resolveStaticFile(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return { status: 400 };
  }

  const normalized = normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  const candidate = resolve(ROOT_DIR, `.${normalized}`);

  if (candidate !== ROOT_DIR && !candidate.startsWith(`${ROOT_DIR}/`)) {
    return { status: 403 };
  }

  if (existsSync(candidate)) {
    const stat = statSync(candidate);
    if (stat.isDirectory()) {
      if (!pathname.endsWith('/')) {
        return { status: 301, location: `${pathname}/` };
      }
      const indexFile = join(candidate, 'index.html');
      if (existsSync(indexFile)) {
        const indexStat = statSync(indexFile);
        return { status: 200, filePath: indexFile, size: indexStat.size };
      }
      return { status: 404 };
    }
    if (stat.isFile()) {
      return { status: 200, filePath: candidate, size: stat.size };
    }
  }

  return { status: 404 };
}

const server = createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/healthz') {
    const body = JSON.stringify({ status: 'ok', buildState });
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
    return;
  }

  if (!existsSync(join(ROOT_DIR, 'index.html'))) {
    if (buildState === 'idle') {
      ensureBuilt();
    }
    if (buildState === 'error') {
      const html = renderStatusHtml(
        'Showcase build failed',
        `Unable to build Storybook showcases (${buildError}). Check server logs.`,
        false,
      );
      res.writeHead(500, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(html),
      });
      res.end(html);
      return;
    }
    const html = renderStatusHtml(
      'Building mono-magic Component Showcases…',
      'Compiling react-mui, ng-mat, and rn-paper Storybooks. This page refreshes automatically once ready.',
      true,
    );
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(html),
    });
    res.end(html);
    return;
  }

  const resolved = resolveStaticFile(url.pathname);

  if (resolved.status === 301 && resolved.location) {
    res.writeHead(301, { Location: `${resolved.location}${url.search}` });
    res.end();
    return;
  }

  if (resolved.status === 404 && url.pathname === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (resolved.status !== 200 || !resolved.filePath) {
    res.writeHead(resolved.status, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(resolved.status === 404 ? 'Not Found' : 'Bad Request');
    return;
  }

  const ext = extname(resolved.filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  const cacheControl = ext === '.html' || ext === '.json' ? 'no-cache' : 'public, max-age=3600';

  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': resolved.size,
    'Cache-Control': cacheControl,
  });

  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  const stream = createReadStream(resolved.filePath);
  stream.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    res.end('Internal Server Error');
  });
  stream.pipe(res);
});

server.listen(PORT, HOST, () => {
  console.log(`mono-magic Component Showcases ready`);
  console.log(`  ➜  Local:   http://localhost:${PORT}/`);
  console.log(`  ➜  Network: http://${HOST}:${PORT}/`);
  ensureBuilt();
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
