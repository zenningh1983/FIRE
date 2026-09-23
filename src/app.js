import { fetchPropertyValuation, validateGithubToken, writeAssets, writeCashflows, writeMortgage, writeSettings } from './api.js';
import { calculatePlan } from './calculator.js';
import { CONFIG } from './config.js';
import { clearGithubToken, loadGithubToken, loadState, saveGithubToken, saveState } from './store.js';

let state;
let toastTimer;
let returnToCashflowRecords = false;
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const money = new Intl.NumberFormat('zh-TW', { style: 'currency', currency: 'TWD', maximumFractionDigits: 0 });

function parseNumber(value) {
  const normalized = String(value).trim()
    .replace(/[０-９]/g, (digit) => String(digit.charCodeAt(0) - 65296))
    .replace(/，/g, ',').replace(/％/g, '%')
    .replace(/[,\s%]/g, '');
  return normalized === '' ? NaN : Number(normalized);
}

function currentYearMonth() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit' }).format(new Date()).slice(0, 7);
}

function shiftYearMonth(month, offset) {
  const [year, monthNumber] = month.split('-').map(Number);
  const date = new Date(Date.UTC(year, monthNumber - 1 + offset, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function evaluateNumberExpression(value) {
  const expression = String(value).trim()
    .replace(/今年|當年/g, String(new Date().getFullYear()))
    .replace(/[０-９]/g, (digit) => String(digit.charCodeAt(0) - 65296))
    .replace(/[，,]/g, '').replace(/．/g, '.').replace(/[＋]/g, '+').replace(/[－]/g, '-')
    .replace(/[×xX＊]/g, '*').replace(/[÷／]/g, '/').replace(/除以|除/g, '/').replace(/\s/g, '');
  if (!expression || !/^[0-9+\-*/().]+$/.test(expression)) return NaN;
  try {
    const result = Function(`"use strict"; return (${expression})`)();
    return Number.isFinite(result) ? result : NaN;
  } catch (_) { return NaN; }
}

function setMessage(element, text, error = false) {
  element.textContent = text;
  element.classList.toggle('error', error);
}

function toast(text, error = false) {
  const element = $('#toast');
  element.textContent = text;
  element.classList.toggle('error', error);
  element.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove('show'), 2800);
}

function setBusy(button, busy) {
  button.disabled = busy;
  button.dataset.label ||= button.textContent;
  button.textContent = busy ? '處理中…' : button.dataset.label;
}

function showGithubLogin(message = '', error = false) {
  $('#appView').hidden = true;
  $('#githubLoginView').hidden = false;
  setMessage($('#githubLoginMessage'), message, error);
}

async function unlockWithGithubToken(token) {
  await validateGithubToken(token);
  saveGithubToken(token);
  state = await loadState();
  $('#githubLoginView').hidden = true;
  $('#appView').hidden = false;
  configureCashflowForm(currentYearMonth());
  setCashflowTab('income');
  render();
  route();
}

function route() {
  const name = ['overview', 'assets', 'liabilities', 'cashflow', 'settings'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'overview';
  $$('.page').forEach((page) => { page.hidden = page.id !== `${name}Page`; });
  $$('.tabs a').forEach((link) => link.classList.toggle('active', link.dataset.route === name));
  if (name === 'liabilities') configureAnnualMortgageForm();
  if (name === 'cashflow') configureCashflowForm($('#cashflowForm').elements.month.value || currentYearMonth());
}

function metric(label, value, note, action = '') {
  return `<article class="metric"><div class="metric-heading"><div class="label">${label}</div>${action}</div><div class="value">${value}</div><div class="note">${note}</div></article>`;
}

function renderOverview() {
  const plan = calculatePlan(state);
  $('#metrics').innerHTML = [
    metric('目前淨資產', money.format(plan.assets), '帳戶餘額＋持股市值＋勞退－剩餘房貸'),
    metric('退休目標資產', money.format(plan.target), '以現在購買力估算'),
    metric('每月建議投入', money.format(plan.requiredMonthly), `距退休 ${plan.yearsToRetire} 年`),
    metric('55 歲預估資產', money.format(plan.projected), plan.projected >= plan.target ? '可達成目標' : '仍有資金缺口')
  ].join('');
  $('#progressText').textContent = `${plan.progress.toFixed(0)}%`;
  $('#progressBar').style.width = `${plan.progress}%`;
  $('#targetAgeBadge').textContent = `${state.settings.retirementAge} 歲`;
  $('#currentAssetsLabel').textContent = `目前 ${money.format(plan.assets)}`;
  $('#targetAssetsLabel').textContent = `目標 ${money.format(plan.target)}`;
  $('#updatedAt').textContent = `更新於 ${new Date().toLocaleDateString('zh-TW')}`;
  const recommendation = plan.gap >= 0
    ? ['每月可投入', money.format(plan.averageNet), '目前現金流足以支應退休投入目標']
    : ['每月仍需補足', money.format(Math.abs(plan.gap)), '可調整支出、收入或退休時間'];
  $('#recommendations').innerHTML = `<div class="recommendation"><span>${recommendation[0]}</span><strong>${recommendation[1]}</strong></div><div class="recommendation"><span>狀態</span><strong>${recommendation[2]}</strong></div>`;
}

function actionButtons(type, id) {
  return `<div class="row-actions"><button data-edit="${type}" data-id="${id}">編輯</button><button data-delete="${type}" data-id="${id}">刪除</button></div>`;
}

function assetBalanceAccounts(summary = {}) {
  if (Array.isArray(summary.accounts)) return summary.accounts;
  const legacyBalance = Number(summary.totalBalance) || 0;
  return legacyBalance > 0 ? [{ id: 'legacy-account', name: '帳戶', balance: legacyBalance }] : [];
}

function renderAssets() {
  const form = $('#assetForm');
  const pension = state.assetSummary?.laborPension || {};
  const accounts = assetBalanceAccounts(state.assetSummary);
  const totalBalance = accounts.reduce((sum, account) => sum + Number(account.balance || 0), 0);
  $('#accountTotalBalance').textContent = money.format(totalBalance);
  form.elements.holdingsValue.value = state.assetSummary?.holdingsValue ?? 0;
  form.elements.employerContribution.value = pension.employerContribution ?? 0;
  form.elements.pensionReturns.value = pension.returns ?? 0;
  $('#laborPensionTotal').textContent = money.format(pension.total ?? 0);
  $('#openTenureDialog').textContent = `（累積提繳年資：${Number(pension.tenureYears ?? 20)} 年 ${Number(pension.tenureMonths ?? 8)} 個月）`;
  $('#assetsUpdatedAt').textContent = state.assetsUpdatedAt ? `更新於 ${new Date(state.assetsUpdatedAt).toLocaleString('zh-TW')}` : '尚未建立資料';
}

let accountSequence = 0;

function createAccountId() {
  accountSequence += 1;
  return `account-${Date.now()}-${accountSequence}`;
}

function createAccountBalanceRow(account = {}) {
  const row = document.createElement('div');
  row.className = 'account-balance-row';
  row.dataset.accountId = account.id || createAccountId();
  row.innerHTML = '<label class="field"><span>帳戶名稱</span><input name="accountName" type="text" required placeholder="例如：國泰世華"></label><label class="field"><span>餘額</span><input name="accountBalance" type="text" inputmode="decimal" required placeholder="0"></label><button class="icon-button remove-account-balance" type="button" aria-label="刪除帳戶">×</button>';
  $('[name="accountName"]', row).value = account.name || '';
  $('[name="accountBalance"]', row).value = Number(account.balance) || 0;
  return row;
}

function updateAccountBalancesTotal() {
  const total = $$('#accountBalanceRows [name="accountBalance"]').reduce((sum, input) => {
    const value = parseNumber(input.value);
    return sum + (Number.isFinite(value) ? value : 0);
  }, 0);
  $('#accountBalancesTotal').textContent = money.format(total);
}

function renderAccountBalancesForm() {
  const accounts = assetBalanceAccounts(state.assetSummary);
  const rows = accounts.length ? accounts.map(createAccountBalanceRow) : [createAccountBalanceRow()];
  $('#accountBalanceRows').replaceChildren(...rows);
  $('#accountBalancesUpdatedAt').textContent = state.assetsUpdatedAt ? `更新於 ${new Date(state.assetsUpdatedAt).toLocaleString('zh-TW')}` : '尚未建立資料';
  setMessage($('#accountBalancesMessage'), '');
  updateAccountBalancesTotal();
}

async function saveAccountBalances(form) {
  if (!form.reportValidity()) return;
  const accounts = $$('.account-balance-row', form).map((row) => ({
    id: row.dataset.accountId || createAccountId(),
    name: $('[name="accountName"]', row).value.trim(),
    balance: parseNumber($('[name="accountBalance"]', row).value)
  }));
  if (!accounts.length || accounts.some((account) => !account.name || !Number.isFinite(account.balance) || account.balance < 0)) {
    setMessage($('#accountBalancesMessage'), '請輸入帳戶名稱及有效餘額。', true);
    return;
  }
  const totalBalance = accounts.reduce((sum, account) => sum + account.balance, 0);
  const updatedAt = new Date().toISOString();
  const summary = { ...state.assetSummary, accounts, totalBalance };
  const submit = $('button[type="submit"]', form);
  setBusy(submit, true);
  setMessage($('#accountBalancesMessage'), '正在寫入 JSON…');
  try {
    await writeAssets(summary, updatedAt);
    state.assetSummary = summary;
    state.assetsUpdatedAt = updatedAt;
    saveState(state);
    render();
    $('#accountBalancesDialog').close();
    toast(`帳戶總餘額已更新為 ${money.format(totalBalance)}`);
  } catch (error) {
    setMessage($('#accountBalancesMessage'), error.message, true);
  } finally { setBusy(submit, false); }
}

function estimateMortgageMonths(mortgage) {
  const balance = Number(mortgage.remainingPrincipal) || 0;
  const principalPaid = Number(mortgage.monthlyPrincipalPaid) || 0;
  const payment = Number(mortgage.monthlyPayment) || 0;
  const rate = (Number(mortgage.interestRate) || 0) / 100 / 12;
  if (balance <= 0) return 0;
  if (principalPaid > 0) return Math.ceil(balance / principalPaid);
  if (payment <= 0) return null;
  if (rate === 0) return Math.ceil(balance / payment);
  if (payment <= balance * rate) return null;
  return Math.ceil(-Math.log(1 - balance * rate / payment) / Math.log(1 + rate));
}

function renderMortgage() {
  const mortgage = state.mortgage;
  const form = $('#mortgageForm');
  const annualSummaries = (mortgage.annualSummaries || []).slice().sort((a, b) => b.year - a.year);
  const latestAnnual = annualSummaries[0];
  form.elements.asOfDate.value = latestAnnual?.asOfDate || `${latestAnnual?.year || new Date().getFullYear()}-12-20`;
  form.elements.annualRemainingPrincipal.value = latestAnnual?.closingPrincipal ?? mortgage.remainingPrincipal ?? '';
  form.elements.annualInterestRate.value = latestAnnual?.interestRate ?? mortgage.interestRate ?? '';
  form.elements.note.value = latestAnnual?.note || mortgage.note || '';
  const months = estimateMortgageMonths(mortgage);
  const ltv = mortgage.propertyValue > 0 ? mortgage.remainingPrincipal / mortgage.propertyValue * 100 : 0;
  const payoff = months === null ? '無法估算' : months === 0 ? '已清償' : `${Math.floor(months / 12)} 年 ${months % 12} 月`;
  $('#mortgageMetrics').innerHTML = [
    metric('剩餘房貸', money.format(mortgage.remainingPrincipal), `原始貸款本金 ${money.format(mortgage.originalPrincipal)}`),
    metric('每月還款', money.format(mortgage.monthlyPayment || 0), latestAnnual ? `${latestAnnual.year} 已還本金 ${money.format(latestAnnual.principalPaid)}・利息 ${money.format(latestAnnual.interestPaid)}` : '尚無年度紀錄'),
    metric('房貸剩餘時間', payoff, mortgage.startMonth ? `自 ${mortgage.startMonth} 起～${mortgage.termYears || 0} 年` : '尚無貸款起始年月'),
    metric('目前貸款成數', `${ltv.toFixed(1)}%`, mortgage.propertyValue > 0 ? `估值 ${money.format(mortgage.propertyValue)}（${mortgage.valuationUnitPriceWan || 0} 萬/坪）` : '尚無房屋估值', '<button id="refreshValuationButton" class="button secondary compact" type="button">更新估值</button>')
  ].join('');
  $('#mortgageUpdatedAt').textContent = mortgage.updatedAt ? `更新於 ${new Date(mortgage.updatedAt).toLocaleString('zh-TW')}` : '尚未建立資料';
  const totalInterestPaid = annualSummaries.reduce((total, payment) => total + Number(payment.interestPaid || 0), 0);
  const totalPrincipalPaid = annualSummaries.reduce((total, payment) => total + Number(payment.principalPaid || 0), 0);
  $('#totalMortgageInterest').textContent = money.format(totalInterestPaid);
  $('#totalMortgagePrincipal').textContent = money.format(totalPrincipalPaid);
  const historyRecords = annualSummaries.map((summary) => ({
    ...summary,
    period: summary.asOfDate ? `${summary.year}（截至 ${Number(summary.asOfDate.slice(5, 7))}/${Number(summary.asOfDate.slice(8, 10))}）` : `${summary.year} 年度`,
    annual: true,
    insurancePaid: summary.insurancePaid || 0
  }));
  const historyBody = $('#mortgageHistoryTable tbody');
  historyBody.replaceChildren(...historyRecords.map((payment) => {
    const row = document.createElement('tr');
    if (payment.annual) row.classList.add('annual-summary-row');
    row.innerHTML = `<td>${payment.period}</td><td class="number">${Number(payment.interestRate || 0).toFixed(2)}%</td><td class="number">${money.format(payment.openingPrincipal)}</td><td class="number">${money.format(payment.principalPaid)}</td><td class="number">${money.format(payment.interestPaid)}</td><td class="number">${money.format(payment.insurancePaid || 0)}</td><td class="number">${money.format(payment.totalPayment)}</td><td class="number">${money.format(payment.closingPrincipal)}</td>`;
    return row;
  }));
  $('#mortgageHistoryEmpty').hidden = historyRecords.length > 0;
  $('#mortgageHistoryTable').hidden = historyRecords.length === 0;
}

function configureAnnualMortgageForm() {
  const form = $('#mortgageForm');
  const summaries = (state.mortgage.annualSummaries || []).slice().sort((a, b) => b.year - a.year);
  const currentYear = new Date().getFullYear();
  const current = summaries.find((summary) => summary.year === currentYear) || summaries[0];
  if (!current) return;
  form.elements.asOfDate.value = current.asOfDate || `${current.year}-12-20`;
  form.elements.annualRemainingPrincipal.value = current.closingPrincipal;
  form.elements.annualInterestRate.value = current.interestRate;
  form.elements.note.value = current.note || '';
}

function countPaymentsThrough(asOfDate, loanStartMonth) {
  const [year, month, day] = asOfDate.split('-').map(Number);
  const [loanYear, loanMonth] = loanStartMonth.split('-').map(Number);
  const firstMonth = year === loanYear ? loanMonth : 1;
  const lastPaidMonth = day >= 20 ? month : month - 1;
  return Math.max(0, lastPaidMonth - firstMonth + 1);
}

function fixedExpenseForMonth(field, month, fallback) {
  const record = state.cashflows
    .filter((item) => item.month <= month && Number.isFinite(Number(item[field])))
    .sort((a, b) => b.month.localeCompare(a.month))[0];
  return Number(record?.[field] ?? fallback);
}

function simulateMortgagePeriod(openingPrincipal, annualRate, monthlyPayment, months, year, firstMonth = 1) {
  let balance = openingPrincipal;
  let interestPaid = 0;
  for (let index = 0; index < months; index += 1) {
    const paymentMonth = `${year}-${String(firstMonth + index).padStart(2, '0')}`;
    const payment = fixedExpenseForMonth('mortgage', paymentMonth, monthlyPayment);
    const interest = Math.round(balance * annualRate / 100 / 12);
    const principal = Math.max(0, payment - interest);
    interestPaid += interest;
    balance = Math.max(0, balance - principal);
  }
  return { interestPaid, scheduledClosingPrincipal: balance };
}

function cashflowValue(record, field) {
  if (field === 'cathayDividends' && record.cathayDividends == null && record.yuantaDividends == null) {
    return Number(record.dividends) || 0;
  }
  if (field === 'petExpenses' && record.petExpenses == null) return Number(record.educationExpenses) || 0;
  if (field === 'personalInsuranceExpenses' && record.personalInsuranceExpenses == null) return Number(record.insuranceExpenses) || 0;
  return Number(record[field]) || 0;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function amountWithNote(record, field, noteField) {
  const note = String(record[noteField] || '').trim();
  return `<span>${money.format(cashflowValue(record, field))}</span>${note ? `<small>${escapeHtml(note)}</small>` : ''}`;
}

function renderCashflows() {
  const records = state.cashflows.slice().sort((a, b) => b.month.localeCompare(a.month));
  const yearFilter = $('#cashflowYearFilter');
  const years = [...new Set(records.map((item) => item.month.slice(0, 4)))];
  const selectedYear = years.includes(yearFilter.value) ? yearFilter.value : '';
  const yearOptions = ['', ...years].map((year) => {
    const option = document.createElement('option');
    option.value = year;
    option.textContent = year ? `${year} 年` : '全部年份';
    return option;
  });
  yearFilter.replaceChildren(...yearOptions);
  yearFilter.value = selectedYear;
  const visibleRecords = selectedYear ? records.filter((item) => item.month.startsWith(`${selectedYear}-`)) : records;
  const body = $('#cashflowTable tbody');
  body.replaceChildren(...visibleRecords.map((item) => {
    const row = document.createElement('tr');
    row.innerHTML = `<td>${item.month}</td><td class="number">${money.format(item.netSalary || 0)}</td><td class="number tax-record-value">${amountWithNote(item, 'bonus', 'bonusNote')}</td><td class="number">${money.format(cashflowValue(item, 'cathayDividends'))}</td><td class="number">${money.format(cashflowValue(item, 'yuantaDividends'))}</td><td class="number">${money.format(item.fixedExpenses)}</td><td class="number">${money.format(item.livingExpenses)}</td><td class="number">${money.format(cashflowValue(item, 'personalInsuranceExpenses'))}</td><td class="number">${money.format(cashflowValue(item, 'petExpenses'))}</td><td class="number">${money.format(cashflowValue(item, 'petInsuranceExpenses'))}</td><td class="number">${money.format(cashflowValue(item, 'propertyLandTax'))}</td><td class="number">${money.format(cashflowValue(item, 'comprehensiveIncomeTax'))}</td><td class="number tax-record-value">${amountWithNote(item, 'otherTaxes', 'otherTaxesNote')}</td><td class="number">${money.format(item.totalExpense)}</td><td class="number">${money.format(item.net)}</td><td><div class="row-actions"><button data-edit-income="${item.month}">收入</button><button data-edit-expense="${item.month}">支出</button><button data-delete="cashflow" data-id="${item.month}">刪除</button></div></td>`;
    return row;
  }));
  $('#cashflowEmpty').hidden = state.cashflows.length > 0;
  $('#cashflowTable').hidden = state.cashflows.length === 0;
  $('#cashflowsUpdatedAt').textContent = state.cashflowsUpdatedAt ? `更新於 ${new Date(state.cashflowsUpdatedAt).toLocaleString('zh-TW')}` : '尚未建立資料';
  const hasRecords = records.length > 0;
  $('#cashflowAverageEmpty').hidden = hasRecords;
  $('#cashflowAverageOverview').hidden = !hasRecords;
  if (!hasRecords) return;
  const average = (field) => records.reduce((sum, record) => {
    return sum + cashflowValue(record, field);
  }, 0) / records.length;
  const averages = Object.fromEntries([
    'netSalary', 'bonus', 'cathayDividends', 'yuantaDividends', 'totalIncome', 'mortgage', 'utilities', 'internet',
    'managementFee', 'livingExpenses', 'personalInsuranceExpenses', 'petExpenses', 'petInsuranceExpenses',
    'propertyLandTax', 'comprehensiveIncomeTax', 'otherTaxes', 'totalExpense', 'net'
  ].map((field) => [field, average(field)]));
  const period = records.length === 1 ? records[0].month : `${records.at(-1).month} ～ ${records[0].month}`;
  $('#cashflowAverageMetrics').innerHTML = [
    metric('統計月份', `${records.length} 個月`, period),
    metric('平均收入', money.format(averages.totalIncome), '每月收入合計的平均'),
    metric('平均支出', money.format(averages.totalExpense), '每月支出合計的平均'),
    metric('平均月結餘', money.format(averages.net), averages.net >= 0 ? '平均可投入或保留的資金' : '平均每月支出超過收入')
  ].join('');
  const breakdown = (label, value) => `<div class="breakdown-row"><span>${label}</span><strong>${money.format(value || 0)}</strong></div>`;
  $('#averageIncomeBreakdown').innerHTML = [
    breakdown('薪資', averages.netSalary), breakdown('獎金', averages.bonus),
    breakdown('國泰配息', averages.cathayDividends), breakdown('元大配息', averages.yuantaDividends)
  ].join('');
  $('#averageExpenseBreakdown').innerHTML = [
    breakdown('房貸', averages.mortgage), breakdown('水電瓦斯', averages.utilities), breakdown('電信／網路', averages.internet),
    breakdown('管理費', averages.managementFee), breakdown('生活開銷', averages.livingExpenses),
    breakdown('個人保險', averages.personalInsuranceExpenses), breakdown('兩隻花費', averages.petExpenses),
    breakdown('兩隻保險', averages.petInsuranceExpenses), breakdown('房屋／地價稅', averages.propertyLandTax),
    breakdown('綜合所得稅', averages.comprehensiveIncomeTax), breakdown('其他稅務', averages.otherTaxes)
  ].join('');
}

const cashflowAmountFields = ['baseSalary', 'mealAllowance', 'taxFreeOvertime', 'laborInsurance', 'healthInsurance', 'incomeTax', 'welfareFund', 'leaveDeduction', 'bonus', 'cathayDividends', 'yuantaDividends', 'mortgage', 'utilities', 'internet', 'managementFee', 'livingExpenses', 'personalInsuranceExpenses', 'petExpenses', 'petInsuranceExpenses', 'propertyLandTax', 'comprehensiveIncomeTax', 'otherTaxes'];
const cashflowNoteFields = ['bonusNote', 'otherTaxesNote'];

function updateMonthlySalaryTotal() {
  const form = $('#cashflowForm');
  const additions = ['baseSalary', 'mealAllowance', 'taxFreeOvertime'].map((field) => parseNumber(form.elements[field].value));
  const deductions = ['laborInsurance', 'healthInsurance', 'incomeTax', 'welfareFund', 'leaveDeduction'].map((field) => parseNumber(form.elements[field].value));
  const values = [...additions, ...deductions];
  const total = additions.reduce((sum, value) => sum + value, 0) - deductions.reduce((sum, value) => sum + value, 0);
  $('#monthlySalaryTotal').textContent = values.every(Number.isFinite) ? money.format(total) : '—';
}

function configureCashflowForm(month = currentYearMonth()) {
  const form = $('#cashflowForm');
  const record = state.cashflows.find((item) => item.month === month);
  form.elements.month.value = month;
  const defaults = { ...state.cashflowDefaults, mortgage: Number(state.mortgage?.monthlyPayment || 0) };
  cashflowAmountFields.forEach((field) => {
    const carryForward = field === 'mortgage' || field === 'managementFee';
    const needsLegacyFallback = field === 'cathayDividends' || field === 'yuantaDividends' || field === 'petExpenses' || field === 'personalInsuranceExpenses';
    const existingValue = record ? (needsLegacyFallback ? cashflowValue(record, field) : record[field]) : null;
    form.elements[field].value = existingValue ?? (carryForward ? fixedExpenseForMonth(field, shiftYearMonth(month, -1), defaults[field]) : defaults[field] ?? 0);
  });
  cashflowNoteFields.forEach((field) => { form.elements[field].value = record?.[field] ?? ''; });
  updateMonthlySalaryTotal();
  setMessage($('#cashflowMessage'), record ? '此月份已有紀錄，送出後會直接更新。' : '');
}

function setCashflowTab(name) {
  $$('[data-cashflow-tab]').forEach((button) => button.classList.toggle('active', button.dataset.cashflowTab === name));
  $('#cashflowIncomePanel').hidden = name !== 'income';
  $('#cashflowExpensePanel').hidden = name !== 'expense';
  $('#cashflowEntryTitle').textContent = name === 'income' ? '新增收入' : '新增支出';
}

function openCashflowEntry(kind, month = currentYearMonth(), returnToRecords = false) {
  returnToCashflowRecords = returnToRecords;
  configureCashflowForm(month);
  setCashflowTab(kind);
  $('#cashflowEntryDialog').showModal();
}

function renderSettings() {
  const form = $('#settingsForm');
  Object.entries(state.settings).forEach(([key, value]) => { if (form.elements[key]) form.elements[key].value = value; });
}

function render() {
  renderOverview();
  renderAssets();
  renderMortgage();
  renderCashflows();
  renderSettings();
}

async function saveCashflow(form) {
  if (!form.reportValidity()) return;
  const values = Object.fromEntries(cashflowAmountFields.map((field) => [field, parseNumber(form.elements[field].value)]));
  const notes = Object.fromEntries(cashflowNoteFields.map((field) => [field, form.elements[field].value.trim()]));
  if (Object.values(values).some((value) => !Number.isFinite(value) || value < 0)) {
    setMessage($('#cashflowMessage'), '請確認所有收入與支出都是有效金額。', true); return;
  }
  const netSalary = values.baseSalary + values.mealAllowance + values.taxFreeOvertime - values.laborInsurance - values.healthInsurance - values.incomeTax - values.welfareFund - values.leaveDeduction;
  const dividends = values.cathayDividends + values.yuantaDividends;
  const totalIncome = netSalary + values.bonus + dividends;
  const fixedExpenses = values.mortgage + values.utilities + values.internet + values.managementFee;
  const totalExpense = fixedExpenses + values.livingExpenses + values.personalInsuranceExpenses + values.petExpenses
    + values.petInsuranceExpenses + values.propertyLandTax + values.comprehensiveIncomeTax + values.otherTaxes;
  const record = { month: form.elements.month.value, ...values, ...notes, netSalary, dividends, totalIncome, fixedExpenses, totalExpense, net: totalIncome - totalExpense };
  const records = state.cashflows.filter((item) => item.month !== record.month);
  records.push(record);
  records.sort((a, b) => b.month.localeCompare(a.month));
  const updatedAt = new Date().toISOString();
  const latestMortgagePayment = Number(records.find((item) => Number.isFinite(Number(item.mortgage)))?.mortgage ?? state.mortgage.monthlyPayment ?? 0);
  const mortgageChanged = latestMortgagePayment !== Number(state.mortgage.monthlyPayment || 0);
  const nextMortgage = mortgageChanged ? { ...state.mortgage, monthlyPayment: latestMortgagePayment, updatedAt } : state.mortgage;
  const submit = $('button[type="submit"]', form);
  setBusy(submit, true);
  setMessage($('#cashflowMessage'), '正在寫入 JSON…');
  try {
    await writeCashflows(records, updatedAt);
    if (mortgageChanged) await writeMortgage(nextMortgage);
    state.cashflows = records;
    state.cashflowsUpdatedAt = updatedAt;
    state.mortgage = nextMortgage;
    saveState(state);
    render();
    configureCashflowForm(record.month);
    $('#cashflowEntryDialog').close();
    if (returnToCashflowRecords) $('#cashflowRecordsDialog').showModal();
    returnToCashflowRecords = false;
    toast(`已更新 ${record.month} 每月收支`);
  } catch (error) {
    setMessage($('#cashflowMessage'), error.message, true);
  } finally { setBusy(submit, false); }
}

async function saveAssetSummary(form) {
  const accounts = assetBalanceAccounts(state.assetSummary);
  const totalBalance = accounts.reduce((sum, account) => sum + Number(account.balance || 0), 0);
  const holdingsValue = parseNumber(form.elements.holdingsValue.value);
  const employerContribution = parseNumber(form.elements.employerContribution.value);
  const returns = parseNumber(form.elements.pensionReturns.value);
  const amounts = [totalBalance, holdingsValue, employerContribution, returns];
  if (amounts.some((value) => !Number.isFinite(value) || value < 0)) {
    setMessage($('#assetMessage'), '請確認可運用資產與勞退資料皆正確。', true); return;
  }
  const updatedAt = new Date().toISOString();
  const laborPension = { tenureYears: Number(state.assetSummary?.laborPension?.tenureYears ?? 20), tenureMonths: Number(state.assetSummary?.laborPension?.tenureMonths ?? 8), employerContribution, returns, total: employerContribution + returns };
  const summary = { totalBalance, accounts, holdingsValue, laborPension };
  const submit = $('button[type="submit"]', form);
  setBusy(submit, true); setMessage($('#assetMessage'), '正在寫入 JSON…');
  try {
    await writeAssets(summary, updatedAt);
    state.assetSummary = summary;
    state.assetsUpdatedAt = updatedAt;
    saveState(state); render(); setMessage($('#assetMessage'), '已更新 data/assets.json');
  } catch (error) { setMessage($('#assetMessage'), error.message, true); }
  finally { setBusy(submit, false); }
}

async function deleteCashflow(month) {
  const record = state.cashflows.find((item) => item.month === month);
  if (!record || !confirm(`確定刪除 ${month} 的收支紀錄？`)) return;
  const records = state.cashflows.filter((item) => item.month !== month);
  const updatedAt = new Date().toISOString();
  try {
    await writeCashflows(records, updatedAt);
    state.cashflows = records;
    state.cashflowsUpdatedAt = updatedAt;
    saveState(state);
    render();
    configureCashflowForm(currentYearMonth());
    toast('已刪除');
  } catch (error) { toast(error.message, true); }
}

window.addEventListener('hashchange', route);
$('[data-cashflow-tab="income"]').closest('.section-tabs').addEventListener('click', (event) => {
  const button = event.target.closest('[data-cashflow-tab]');
  if (button) setCashflowTab(button.dataset.cashflowTab);
});
$('#assetForm').addEventListener('submit', (event) => { event.preventDefault(); saveAssetSummary(event.currentTarget); });
$('#accountBalancesForm').addEventListener('submit', (event) => { event.preventDefault(); saveAccountBalances(event.currentTarget); });
$('#cashflowForm').addEventListener('submit', (event) => { event.preventDefault(); saveCashflow(event.currentTarget); });
$('#cashflowForm').elements.month.addEventListener('change', (event) => configureCashflowForm(event.currentTarget.value));
$('#openIncomeDialog').addEventListener('click', () => openCashflowEntry('income'));
$('#openExpenseDialog').addEventListener('click', () => openCashflowEntry('expense'));
$('#openMortgageHistoryDialog').addEventListener('click', () => $('#mortgageHistoryDialog').showModal());
$('#openCashflowRecordsDialog').addEventListener('click', () => $('#cashflowRecordsDialog').showModal());
$('#cashflowYearFilter').addEventListener('change', renderCashflows);
$('#openAccountBalancesDialog').addEventListener('click', () => {
  renderAccountBalancesForm();
  $('#accountBalancesDialog').showModal();
});
$('#addAccountBalance').addEventListener('click', () => {
  $('#accountBalanceRows').append(createAccountBalanceRow());
  updateAccountBalancesTotal();
});
$('#accountBalanceRows').addEventListener('input', updateAccountBalancesTotal);
$('#accountBalanceRows').addEventListener('click', (event) => {
  const remove = event.target.closest('.remove-account-balance');
  if (!remove) return;
  remove.closest('.account-balance-row').remove();
  if (!$('#accountBalanceRows').children.length) $('#accountBalanceRows').append(createAccountBalanceRow());
  updateAccountBalancesTotal();
});
$('#openGithubSettingsDialog').addEventListener('click', () => {
  $('#githubToken').value = loadGithubToken();
  setMessage($('#githubSettingsMessage'), '');
  $('#githubSettingsDialog').showModal();
});
$('#openTenureDialog').addEventListener('click', () => {
  const pension = state.assetSummary?.laborPension || {};
  const form = $('#tenureForm');
  form.elements.years.value = pension.tenureYears ?? 20;
  form.elements.months.value = pension.tenureMonths ?? 8;
  setMessage($('#tenureMessage'), '');
  $('#tenureDialog').showModal();
});
$$('[data-close-dialog]').forEach((button) => button.addEventListener('click', () => button.closest('dialog').close()));
$$('dialog').forEach((dialog) => dialog.addEventListener('click', (event) => {
  if (event.target === dialog) dialog.close();
}));
$('#githubLoginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const token = $('#githubLoginToken').value.trim();
  if (!token) { setMessage($('#githubLoginMessage'), '請輸入 GitHub Token。', true); return; }
  const button = $('#githubLoginButton');
  setBusy(button, true); setMessage($('#githubLoginMessage'), '正在驗證…');
  try { await unlockWithGithubToken(token); }
  catch (error) { setMessage($('#githubLoginMessage'), error.message, true); }
  finally { setBusy(button, false); }
});
$('#githubSettingsForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const token = $('#githubToken').value.trim();
  if (!token) { setMessage($('#githubSettingsMessage'), '請輸入 GitHub Token。', true); return; }
  const button = $('button[type="submit"]', event.currentTarget);
  setBusy(button, true); setMessage($('#githubSettingsMessage'), '正在驗證…');
  try {
    await validateGithubToken(token);
    saveGithubToken(token);
    $('#githubSettingsDialog').close();
    toast('GitHub Token 已驗證並儲存在此瀏覽器');
  } catch (error) { setMessage($('#githubSettingsMessage'), error.message, true); }
  finally { setBusy(button, false); }
});
$('#clearGithubToken').addEventListener('click', () => {
  clearGithubToken();
  $('#githubSettingsForm').reset();
  $('#githubLoginForm').reset();
  $('#githubSettingsDialog').close();
  showGithubLogin('Token 已清除，請重新登入。');
});
$('#tenureForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const years = parseNumber(form.elements.years.value);
  const months = parseNumber(form.elements.months.value);
  if (!Number.isInteger(years) || years < 0 || !Number.isInteger(months) || months < 0 || months > 11) {
    setMessage($('#tenureMessage'), '請輸入有效年資，月份需介於 0～11。', true); return;
  }
  const updatedAt = new Date().toISOString();
  const summary = { ...state.assetSummary, laborPension: { ...state.assetSummary.laborPension, tenureYears: years, tenureMonths: months } };
  const button = $('button[type="submit"]', form);
  setBusy(button, true); setMessage($('#tenureMessage'), '正在寫入 JSON…');
  try {
    await writeAssets(summary, updatedAt);
    state.assetSummary = summary; state.assetsUpdatedAt = updatedAt; saveState(state); render();
    $('#tenureDialog').close(); toast('已更新累積提繳年資');
  } catch (error) { setMessage($('#tenureMessage'), error.message, true); }
  finally { setBusy(button, false); }
});
$('#settingsForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = Object.fromEntries(Object.keys(state.settings).map((key) => [key, key === 'currentAge' ? evaluateNumberExpression(form.elements[key].value) : parseNumber(form.elements[key].value)]));
  if (Object.values(values).some((value) => !Number.isFinite(value))) {
    setMessage($('#settingsMessage'), '請確認所有欄位都是有效數值。', true); return;
  }
  if (values.currentAge < 18 || values.retirementAge <= values.currentAge || values.lifeExpectancy <= values.retirementAge) {
    setMessage($('#settingsMessage'), '退休年齡需大於目前年齡，規劃年齡需大於退休年齡。', true); return;
  }
  if (values.retirementMonthlySpend < 0 || values.preReturn < -20 || values.preReturn > 30 || values.postReturn < -20 || values.postReturn > 30 || values.inflation < -5 || values.inflation > 20) {
    setMessage($('#settingsMessage'), '請確認金額與百分比位於合理範圍。', true); return;
  }
  Object.assign(state.settings, values);
  const button = $('button[type="submit"]', form);
  const updatedAt = new Date().toISOString();
  setBusy(button, true);
  setMessage($('#settingsMessage'), '正在寫入 JSON…');
  try {
    await writeSettings(state.settings, updatedAt);
    state.settingsUpdatedAt = updatedAt;
    saveState(state); render(); setMessage($('#settingsMessage'), '已更新 data/retirement-settings.json');
  } catch (error) {
    setMessage($('#settingsMessage'), error.message, true);
  } finally { setBusy(button, false); }
});

$('#mortgageForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const next = { ...state.mortgage };
  const asOfDate = form.elements.asOfDate.value;
  const closingPrincipal = parseNumber(form.elements.annualRemainingPrincipal.value);
  const year = Number(asOfDate.slice(0, 4));
  const summaries = Array.isArray(next.annualSummaries) ? next.annualSummaries : [];
  const existing = summaries.find((summary) => summary.year === year);
  const previous = summaries.filter((summary) => summary.year < year).sort((a, b) => b.year - a.year)[0];
  const rateInput = form.elements.annualInterestRate.value.trim();
  const interestRate = rateInput === '' ? Number(existing?.interestRate ?? previous?.interestRate) : parseNumber(rateInput);
  const openingPrincipal = Number(previous?.closingPrincipal ?? (year === 2018 ? next.originalPrincipal : NaN));
  const monthlyPayment = Number(next.monthlyPayment) || 0;
  const monthsPaid = countPaymentsThrough(asOfDate, next.startMonth);
  const principalPaid = openingPrincipal - closingPrincipal;
  const firstPaymentMonth = year === Number(next.startMonth.slice(0, 4)) ? Number(next.startMonth.slice(5, 7)) : 1;
  const simulation = simulateMortgagePeriod(openingPrincipal, interestRate, monthlyPayment, monthsPaid, year, firstPaymentMonth);
  const interestPaid = simulation.interestPaid;
  const balanceAdjustment = simulation.scheduledClosingPrincipal - closingPrincipal;
  const insurancePaid = Number(asOfDate.slice(5, 7)) >= 12 ? Number(next.annualInsurancePremium || 1920) : 0;
  const totalPayment = principalPaid + interestPaid + insurancePaid;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate) || !Number.isFinite(closingPrincipal) || closingPrincipal < 0 || !Number.isFinite(interestRate) || interestRate < 0 || !Number.isFinite(openingPrincipal) || monthsPaid < 1 || principalPaid < 0) {
    setMessage($('#mortgageMessage'), '請確認截至日期、剩餘房貸與年度利率皆正確。', true); return;
  }
  const annualSummary = { year, asOfDate, monthsPaid, interestRate, openingPrincipal, principalPaid, interestPaid, insurancePaid, totalPayment, closingPrincipal, balanceAdjustment, note: form.elements.note.value.trim() };
  next.annualSummaries = summaries.filter((summary) => summary.year !== year);
  next.annualSummaries.push(annualSummary);
  const latestAnnual = next.annualSummaries.slice().sort((a, b) => b.year - a.year)[0];
  next.recordMonth = latestAnnual.asOfDate.slice(0, 7);
  next.interestRate = latestAnnual.interestRate;
  next.lastMonthRemainingPrincipal = latestAnnual.openingPrincipal;
  next.remainingPrincipal = latestAnnual.closingPrincipal;
  next.monthlyPayment = monthlyPayment;
  next.monthlyPrincipalPaid = Math.round(latestAnnual.principalPaid / latestAnnual.monthsPaid);
  next.monthlyInterestPaid = Math.round(latestAnnual.interestPaid / latestAnnual.monthsPaid);
  next.insurancePaid = latestAnnual.insurancePaid || 0;
  next.note = latestAnnual.note || '';
  next.updatedAt = new Date().toISOString();
  const button = $('button[type="submit"]', form);
  setBusy(button, true); setMessage($('#mortgageMessage'), '正在寫入 JSON…');
  try {
    await writeMortgage(next);
    state.mortgage = next; saveState(state); render();
    setMessage($('#mortgageMessage'), '已更新 data/mortgage.json');
  } catch (error) { setMessage($('#mortgageMessage'), error.message, true); }
  finally { setBusy(button, false); }
});

$('#mortgageMetrics').addEventListener('click', async (event) => {
  const button = event.target.closest('#refreshValuationButton');
  if (!button) return;
  setBusy(button, true); setMessage($('#mortgageMessage'), '正在更新社區行情…');
  try {
    const valuation = await fetchPropertyValuation();
    const next = { ...state.mortgage, ...valuation, updatedAt: new Date().toISOString() };
    await writeMortgage(next);
    state.mortgage = next; saveState(state); render();
    setMessage($('#mortgageMessage'), `已更新：${valuation.valuationUnitPriceWan} 萬/坪 × ${valuation.valuationArea} 坪 = ${money.format(valuation.propertyValue)}`);
  } catch (error) { setMessage($('#mortgageMessage'), error.message, true); }
  finally { setBusy(button, false); }
});

$('#settingsForm').elements.currentAge.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  const age = evaluateNumberExpression(event.currentTarget.value);
  if (!Number.isFinite(age) || age < 0 || age > 120) {
    setMessage($('#settingsMessage'), '請輸入有效的年齡算式，例如：今年-1983。', true); return;
  }
  event.currentTarget.value = String(Math.floor(age));
  setMessage($('#settingsMessage'), `已計算為 ${Math.floor(age)} 歲`);
});

function enableAmountCalculations(formSelector, messageSelector) {
  $$(`${formSelector} input[inputmode="decimal"]`).forEach((input) => input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const result = evaluateNumberExpression(event.currentTarget.value);
    if (!Number.isFinite(result)) {
      setMessage($(messageSelector), '請輸入有效算式，例如：30000+5000、120000/12。', true);
      return;
    }
    const rounded = Math.round(result * 100) / 100;
    event.currentTarget.value = new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 2 }).format(rounded);
    event.currentTarget.dispatchEvent(new Event('input', { bubbles: true }));
    setMessage($(messageSelector), `計算結果：${event.currentTarget.value}`);
  }));
}

enableAmountCalculations('#assetForm', '#assetMessage');
enableAmountCalculations('#cashflowForm', '#cashflowMessage');
['baseSalary', 'mealAllowance', 'taxFreeOvertime', 'laborInsurance', 'healthInsurance', 'incomeTax', 'welfareFund', 'leaveDeduction'].forEach((name) => {
  $('#cashflowForm').elements[name].addEventListener('input', updateMonthlySalaryTotal);
});
['employerContribution', 'pensionReturns'].forEach((name) => {
  $('#assetForm').elements[name].addEventListener('input', () => {
    const form = $('#assetForm');
    const values = ['employerContribution', 'pensionReturns'].map((field) => parseNumber(form.elements[field].value));
    $('#laborPensionTotal').textContent = values.every(Number.isFinite) ? money.format(values.reduce((sum, value) => sum + value, 0)) : '—';
  });
});
document.addEventListener('click', (event) => {
  const editIncome = event.target.closest('[data-edit-income]');
  const editExpense = event.target.closest('[data-edit-expense]');
  if (editIncome || editExpense) {
    const button = editIncome || editExpense;
    $('#cashflowRecordsDialog').close();
    openCashflowEntry(editIncome ? 'income' : 'expense', editIncome ? button.dataset.editIncome : button.dataset.editExpense, true);
  }
  const remove = event.target.closest('[data-delete]');
  if (remove?.dataset.delete === 'cashflow') deleteCashflow(remove.dataset.id);
});

$('#appVersion').textContent = CONFIG.appVersion;
const storedGithubToken = loadGithubToken();
if (storedGithubToken) {
  $('#githubLoginToken').value = storedGithubToken;
  setMessage($('#githubLoginMessage'), '正在驗證已儲存的 Token…');
  unlockWithGithubToken(storedGithubToken).catch((error) => showGithubLogin(error.message, true));
} else {
  showGithubLogin();
}
