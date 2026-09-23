const http = require('http');
const fs = require('fs');
const path = require('path');

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT) || 8080;
const ROOT = __dirname;
const MORTGAGE_PATH = path.join(ROOT, 'data', 'mortgage.json');
const ASSETS_PATH = path.join(ROOT, 'data', 'assets.json');
const CASHFLOWS_PATH = path.join(ROOT, 'data', 'cashflows.json');
const SETTINGS_PATH = path.join(ROOT, 'data', 'retirement-settings.json');
let valuationCache = null;

function sendJsonResponse(nodeResponse) {
  return {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      const body = JSON.stringify(data);
      nodeResponse.writeHead(this.statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store'
      });
      nodeResponse.end(body);
    }
  };
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) reject(new Error('request too large'));
    });
    request.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (error) { reject(new Error('invalid JSON')); }
    });
    request.on('error', reject);
  });
}

function serveStatic(request, response) {
  const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
  const relativePath = pathname === '/' ? 'index.html' : pathname.slice(1);
  const filePath = path.resolve(ROOT, relativePath);
  const allowed = ['index.html', 'styles.css', '.nojekyll'];
  const isModule = relativePath.startsWith('src/') && relativePath.endsWith('.js');
  const isData = relativePath.startsWith('data/') && relativePath.endsWith('.json');
  if (!filePath.startsWith(ROOT + path.sep) || (!allowed.includes(relativePath) && !isModule && !isData)) {
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
        : relativePath.endsWith('.json') ? 'application/json; charset=utf-8'
        : 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    if (request.method === 'HEAD') response.end();
    else response.end(data);
  });
}

const server = http.createServer(async (request, response) => {
  if (request.url === '/api/property-valuation') {
    if (request.method !== 'GET') {
      sendJsonResponse(response).status(405).json({ error: '不支援此請求方式。' });
      return;
    }
    try {
      const mortgage = JSON.parse(await fs.promises.readFile(MORTGAGE_PATH, 'utf8'));
      const valuationSource = mortgage.valuationSourceUrl;
      if (!valuationSource) throw new Error('尚未設定估值來源。');
      if (valuationCache && Date.now() - valuationCache.cachedAt < 6 * 60 * 60 * 1000) {
        sendJsonResponse(response).status(200).json(valuationCache.data);
        return;
      }
      const marketResponse = await fetch(valuationSource, { headers: { 'User-Agent': 'Mozilla/5.0 FIRE-LIFE/1.0', Accept: 'text/html' } });
      if (!marketResponse.ok) throw new Error(`591 回應 HTTP ${marketResponse.status}`);
      const html = await marketResponse.text();
      const priceMatch = html.match(/均價\s*([\d.]+)\s*萬/);
      const communityMatch = html.match(/【([^】]+)】/);
      if (!priceMatch) throw new Error('591 頁面未提供可辨識的社區均價。');
      const valuationArea = Number(mortgage.valuationArea) || 0;
      const valuationUnitPriceWan = Number(priceMatch[1]);
      const data = {
        propertyValue: Math.round(valuationUnitPriceWan * 10000 * valuationArea),
        valuationArea,
        valuationUnitPriceWan,
        valuationSourceUrl: valuationSource,
        valuationCommunity: communityMatch?.[1] || mortgage.valuationCommunity || '',
        valuationUpdatedAt: new Date().toISOString()
      };
      valuationCache = { cachedAt: Date.now(), data };
      sendJsonResponse(response).status(200).json(data);
    } catch (error) {
      sendJsonResponse(response).status(502).json({ error: `無法更新 591 估值：${error.message}` });
    }
    return;
  }
  if (request.url === '/api/mortgage') {
    if (request.method !== 'PUT') {
      sendJsonResponse(response).status(405).json({ error: '不支援此請求方式。' });
      return;
    }
    try {
      const mortgage = await readJson(request);
      const allowedFields = ['updatedAt', 'bank', 'startMonth', 'termYears', 'originalPrincipal', 'historyStartMonth', 'historyOpeningPrincipal', 'annualInsurancePremium', 'lastMonthRemainingPrincipal', 'remainingPrincipal', 'interestRate', 'monthlyPayment', 'monthlyPrincipalPaid', 'monthlyInterestPaid', 'insurancePaid', 'propertyValue', 'valuationArea', 'valuationUnitPriceWan', 'valuationSourceUrl', 'valuationCommunity', 'valuationUpdatedAt', 'recordMonth', 'note', 'annualSummaries', 'payments'];
      const output = Object.fromEntries(allowedFields.map((key) => [key, mortgage[key]]));
      await fs.promises.writeFile(MORTGAGE_PATH, JSON.stringify(output, null, 2) + '\n', 'utf8');
      sendJsonResponse(response).status(200).json({ ok: true });
    } catch (error) {
      sendJsonResponse(response).status(400).json({ error: error.message });
    }
    return;
  }
  if (request.url === '/api/assets') {
    if (request.method !== 'PUT') {
      sendJsonResponse(response).status(405).json({ error: '不支援此請求方式。' });
      return;
    }
    try {
      const data = await readJson(request);
      const hasAccountDetails = Array.isArray(data.accounts);
      let accounts = hasAccountDetails ? data.accounts.map((account, index) => ({
        id: String(account.id || `account-${index + 1}`),
        name: String(account.name || '').trim(),
        balance: Number(account.balance)
      })) : [];
      if (accounts.some((account) => !account.name || !Number.isFinite(account.balance) || account.balance < 0)) throw new Error('帳戶資料格式不正確。');
      const totalBalance = hasAccountDetails ? accounts.reduce((sum, account) => sum + account.balance, 0) : Number(data.totalBalance);
      if (!hasAccountDetails && Number.isFinite(totalBalance) && totalBalance > 0) accounts = [{ id: 'legacy-account', name: '帳戶', balance: totalBalance }];
      const holdingsValue = Number(data.holdingsValue);
      const pension = data.laborPension || {};
      const tenureYears = Number(pension.tenureYears ?? 20);
      const tenureMonths = Number(pension.tenureMonths ?? 8);
      const employerContribution = Number(pension.employerContribution || 0);
      const returns = Number(pension.returns || 0);
      if (!Number.isFinite(totalBalance) || totalBalance < 0 || !Number.isFinite(holdingsValue) || holdingsValue < 0 || !Number.isInteger(tenureYears) || tenureYears < 0 || !Number.isInteger(tenureMonths) || tenureMonths < 0 || tenureMonths > 11 || [employerContribution, returns].some((value) => !Number.isFinite(value) || value < 0)) throw new Error('資產資料格式不正確。');
      const output = {
        updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : new Date().toISOString(),
        totalBalance,
        accounts,
        holdingsValue,
        laborPension: {
          tenureYears,
          tenureMonths,
          employerContribution,
          returns,
          total: employerContribution + returns
        }
      };
      await fs.promises.writeFile(ASSETS_PATH, JSON.stringify(output, null, 2) + '\n', 'utf8');
      sendJsonResponse(response).status(200).json({ ok: true });
    } catch (error) {
      sendJsonResponse(response).status(400).json({ error: error.message });
    }
    return;
  }
  if (request.url === '/api/cashflows') {
    if (request.method !== 'PUT') {
      sendJsonResponse(response).status(405).json({ error: '不支援此請求方式。' });
      return;
    }
    try {
      const data = await readJson(request);
      if (!Array.isArray(data.records)) throw new Error('每月收支資料格式不正確。');
      const fields = ['baseSalary', 'mealAllowance', 'taxFreeOvertime', 'laborInsurance', 'healthInsurance', 'incomeTax', 'welfareFund', 'leaveDeduction', 'netSalary', 'bonus', 'cathayDividends', 'yuantaDividends', 'dividends', 'mortgage', 'utilities', 'internet', 'managementFee', 'livingExpenses', 'personalInsuranceExpenses', 'insuranceExpenses', 'petExpenses', 'educationExpenses', 'petInsuranceExpenses', 'propertyLandTax', 'comprehensiveIncomeTax', 'otherTaxes', 'totalIncome', 'fixedExpenses', 'totalExpense', 'net'];
      const noteFields = ['bonusNote', 'otherTaxesNote'];
      const records = data.records.map((record) => {
        if (!/^\d{4}-\d{2}$/.test(record.month || '')) throw new Error('年月份格式不正確。');
        const output = { month: record.month };
        for (const field of fields) {
          const value = Number(record[field] || 0);
          if (!Number.isFinite(value) || value < 0 && field !== 'net') throw new Error('收支金額格式不正確。');
          output[field] = value;
        }
        if (record.cathayDividends == null && record.yuantaDividends == null) output.cathayDividends = output.dividends;
        if (record.petExpenses == null) output.petExpenses = output.educationExpenses;
        if (record.personalInsuranceExpenses == null) output.personalInsuranceExpenses = output.insuranceExpenses;
        for (const field of noteFields) output[field] = typeof record[field] === 'string' ? record[field].trim() : '';
        return output;
      }).sort((a, b) => b.month.localeCompare(a.month));
      const output = { updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : new Date().toISOString(), records };
      await fs.promises.writeFile(CASHFLOWS_PATH, JSON.stringify(output, null, 2) + '\n', 'utf8');
      sendJsonResponse(response).status(200).json({ ok: true });
    } catch (error) {
      sendJsonResponse(response).status(400).json({ error: error.message });
    }
    return;
  }
  if (request.url === '/api/settings') {
    if (request.method !== 'PUT') {
      sendJsonResponse(response).status(405).json({ error: '不支援此請求方式。' });
      return;
    }
    try {
      const data = await readJson(request);
      const fields = ['currentAge', 'retirementAge', 'lifeExpectancy', 'retirementMonthlySpend', 'preReturn', 'postReturn', 'inflation'];
      const settings = Object.fromEntries(fields.map((field) => [field, Number(data.settings?.[field])]));
      if (Object.values(settings).some((value) => !Number.isFinite(value))) throw new Error('退休設定格式不正確。');
      const output = { updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : new Date().toISOString(), settings };
      await fs.promises.writeFile(SETTINGS_PATH, JSON.stringify(output, null, 2) + '\n', 'utf8');
      sendJsonResponse(response).status(200).json({ ok: true });
    } catch (error) {
      sendJsonResponse(response).status(400).json({ error: error.message });
    }
    return;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405);
    response.end('Method not allowed');
    return;
  }
  serveStatic(request, response);
});

server.listen(PORT, HOST, () => {
  console.log(`FIRE LIFE: http://${HOST}:${PORT}`);
});
