const http = require('http');
const fs = require('fs');
const path = require('path');

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT) || 8080;
const ROOT = __dirname;
const valuationCache = new Map();

function sendJson(response, status, data) {
  const body = JSON.stringify(data);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  response.end(body);
}

function serveStatic(request, response, pathname) {
  const relativePath = pathname === '/' ? 'index.html' : pathname.slice(1);
  const filePath = path.resolve(ROOT, relativePath);
  const allowed = ['index.html', 'styles.css', '.nojekyll'];
  const isModule = relativePath.startsWith('src/') && relativePath.endsWith('.js');
  if (!filePath.startsWith(ROOT + path.sep) || (!allowed.includes(relativePath) && !isModule)) {
    response.writeHead(404);
    response.end('Not found');
    return;
  }
  fs.readFile(filePath, (error, data) => {
    if (error) {
      response.writeHead(404);
      response.end('Not found');
      return;
    }
    response.writeHead(200, {
      'Content-Type': relativePath.endsWith('.html') ? 'text/html; charset=utf-8'
        : relativePath.endsWith('.css') ? 'text/css; charset=utf-8'
        : relativePath.endsWith('.js') ? 'text/javascript; charset=utf-8'
        : 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    if (request.method === 'HEAD') response.end();
    else response.end(data);
  });
}

async function fetchPropertyValuation(requestUrl, response) {
  const source = requestUrl.searchParams.get('source');
  const area = Number(requestUrl.searchParams.get('area'));
  let valuationUrl;
  try {
    valuationUrl = new URL(source);
  } catch (_) {
    sendJson(response, 400, { error: '尚未設定有效的 591 估值來源。' });
    return;
  }
  if (valuationUrl.protocol !== 'https:' || !/(^|\.)591\.com\.tw$/.test(valuationUrl.hostname)
    || !Number.isFinite(area) || area <= 0) {
    sendJson(response, 400, { error: '591 估值來源或坪數不正確。' });
    return;
  }
  const cacheKey = `${valuationUrl.href}|${area}`;
  const cached = valuationCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < 6 * 60 * 60 * 1000) {
    sendJson(response, 200, cached.data);
    return;
  }
  try {
    const marketResponse = await fetch(valuationUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 FIRE-LIFE/1.0', Accept: 'text/html' }
    });
    if (!marketResponse.ok) throw new Error(`591 回應 HTTP ${marketResponse.status}`);
    const html = await marketResponse.text();
    const priceMatch = html.match(/均價\s*([\d.]+)\s*萬/);
    const communityMatch = html.match(/【([^】]+)】/);
    if (!priceMatch) throw new Error('591 頁面未提供可辨識的社區均價。');
    const valuationUnitPriceWan = Number(priceMatch[1]);
    const data = {
      propertyValue: Math.round(valuationUnitPriceWan * 10000 * area),
      valuationArea: area,
      valuationUnitPriceWan,
      valuationSourceUrl: valuationUrl.href,
      valuationCommunity: communityMatch?.[1] || '',
      valuationUpdatedAt: new Date().toISOString()
    };
    valuationCache.set(cacheKey, { cachedAt: Date.now(), data });
    sendJson(response, 200, data);
  } catch (error) {
    sendJson(response, 502, { error: `無法更新 591 估值：${error.message}` });
  }
}

const server = http.createServer((request, response) => {
  let requestUrl;
  try {
    requestUrl = new URL(request.url, `http://${HOST}:${PORT}`);
  } catch (_) {
    response.writeHead(400);
    response.end('Bad request');
    return;
  }
  if (requestUrl.pathname === '/api/property-valuation') {
    if (request.method !== 'GET') {
      sendJson(response, 405, { error: '不支援此請求方式。' });
      return;
    }
    fetchPropertyValuation(requestUrl, response);
    return;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405);
    response.end('Method not allowed');
    return;
  }
  serveStatic(request, response, requestUrl.pathname);
});

server.listen(PORT, HOST, () => {
  console.log(`FIRE LIFE: http://${HOST}:${PORT}`);
});
