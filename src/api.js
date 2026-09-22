import { CONFIG } from './config.js';

function isLocalhost() {
  return location.hostname === 'localhost' || location.hostname === '127.0.0.1';
}

function encodeBase64(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}

export async function validateGithubToken(token) {
  const response = await fetch(`https://api.github.com/repos/${CONFIG.githubOwner}/${CONFIG.githubDataRepo}`, {
    headers: {
      Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28'
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(response.status === 401 ? 'GitHub Token 無效。' : data.message || '無法驗證 GitHub Token。');
  if (!data.permissions?.push) throw new Error('此 Token 沒有 FIRE repository 的 Contents 寫入權限。');
  return data;
}

async function writeJson(path, data, localEndpoint, message) {
  if (isLocalhost()) {
    const response = await fetch(localEndpoint, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `無法更新 ${path}。`);
    return result;
  }
  const token = localStorage.getItem(CONFIG.githubTokenKey) || '';
  if (!token) throw new Error('請先從右上角設定 GitHub Token。');
  const url = `https://api.github.com/repos/${CONFIG.githubOwner}/${CONFIG.githubDataRepo}/contents/${path}`;
  const headers = {
    Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28'
  };
  const current = await fetch(`${url}?ref=${encodeURIComponent(CONFIG.githubBranch)}`, { headers });
  const currentData = await current.json().catch(() => ({}));
  if (!current.ok) throw new Error(current.status === 401 || current.status === 403 ? 'GitHub Token 無效或缺少 Contents 讀寫權限。' : currentData.message || `無法讀取 ${path}。`);
  const response = await fetch(url, {
    method: 'PUT', headers,
    body: JSON.stringify({ message, content: encodeBase64(`${JSON.stringify(data, null, 2)}\n`), sha: currentData.sha, branch: CONFIG.githubBranch })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'GitHub Token 無效或缺少 Contents 讀寫權限。' : result.message || `無法更新 ${path}。`);
  return result;
}

export async function writeMortgage(mortgage) {
  return writeJson('mortgage.json', mortgage, '/api/mortgage', 'Update mortgage data');
}

export async function writeAssets(assetSummary, updatedAt) {
  return writeJson('assets.json', { updatedAt, ...assetSummary }, '/api/assets', 'Update asset data');
}

export async function writeCashflows(records, updatedAt) {
  return writeJson('cashflows.json', { updatedAt, records }, '/api/cashflows', 'Update monthly cash flow');
}

export async function writeSettings(settings, updatedAt) {
  return writeJson('retirement-settings.json', { updatedAt, settings }, '/api/settings', 'Update retirement settings');
}

export async function fetchPropertyValuation() {
  const response = await fetch('/api/property-valuation', { cache: 'no-store' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || '無法取得 591 估值。');
  return data;
}
