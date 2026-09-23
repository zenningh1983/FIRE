import { fetchPropertyValuation, validateGithubToken, writeAssets, writeCashflows, writeMortgage, writeSettings } from './api.js';
import { calculatePlan } from './calculator.js';
import { CONFIG } from './config.js';
import { clearGithubToken, loadGithubToken, loadState, saveGithubToken, saveState } from './store.js';

let state;
let toastTimer;
let returnToCashflowRecords = false;
let retirementAgePreview = null;
let retirementAssessmentVisible = false;
let retirementPreviewFrame = null;
let settingsSyncTimer = null;
let settingsSyncInFlight = false;
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

function currentAgeFromBirthYear() {
  const year = Number(new Intl.DateTimeFormat('en', { timeZone: 'Asia/Taipei', year: 'numeric' }).format(new Date()));
  return year - 1983;
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
  state.settings.currentAge = currentAgeFromBirthYear();
  retirementAgePreview = Number(state.settings.retirementAge);
  retirementAssessmentVisible = false;
  $('#githubLoginView').hidden = true;
  $('#appView').hidden = false;
  configureCashflowForm(currentYearMonth());
  setCashflowTab('income');
  render();
  route();
  startSettingsBackgroundSync();
}

function route() {
  const name = ['overview', 'assets', 'liabilities', 'cashflow'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'overview';
  $$('.page').forEach((page) => { page.hidden = page.id !== `${name}Page`; });
  $$('.tabs a').forEach((link) => link.classList.toggle('active', link.dataset.route === name));
  if (name === 'liabilities') configureAnnualMortgageForm();
  if (name === 'cashflow') configureCashflowForm($('#cashflowForm').elements.month.value || currentYearMonth());
}

function metric(label, value, note, action = '', formula = '') {
  return `<article class="metric"><div class="metric-heading"><div class="label">${label}</div>${action}</div><div class="value">${value}</div><div class="note">${note}</div>${formula ? `<div class="formula">公式：${formula}</div>` : ''}</article>`;
}

const FIXED_RETIREMENT_RATES = { preReturn: 5, postReturn: 3, inflation: 2 };
const overviewSettingFields = ['lifeExpectancy', 'retirementMonthlySpend', 'annualTravelTrips', 'carBudget', 'emergencyCashReserve', 'parentMedicalReserve', 'personalMedicalReserve', 'childrenMonthlySupportAfterRetirement', 'childrenMilestoneReserve', 'preReturn', 'postReturn', 'inflation'];

function previewRetirementSettings() {
  const form = $('#settingsForm');
  const settings = { ...state.settings, currentAge: currentAgeFromBirthYear(), retirementAge: Number(retirementAgePreview ?? state.settings.retirementAge) };
  overviewSettingFields.forEach((key) => {
    const value = parseNumber(form.elements[key].value);
    if (Number.isFinite(value)) settings[key] = value;
  });
  settings.laborPensionPayoutMode = form.elements.laborPensionPayoutMode.value || 'lump';
  settings.laborInsurancePayoutMode = form.elements.laborInsurancePayoutMode.value || 'monthly';
  Object.assign(settings, FIXED_RETIREMENT_RATES);
  settings.semiRetirementEndAge = Math.max(settings.retirementAge, 65);
  return settings;
}

function persistOverviewSettingsLocally(settings = previewRetirementSettings()) {
  const updatedAt = new Date().toISOString();
  state.settings = { ...settings };
  state.settingsUpdatedAt = updatedAt;
  state.settingsSyncPending = true;
  saveState(state);
}

async function syncPendingSettings() {
  if (!state?.settingsSyncPending || settingsSyncInFlight) return;
  const settings = { ...state.settings };
  const updatedAt = state.settingsUpdatedAt;
  settingsSyncInFlight = true;
  try {
    await writeSettings(settings, updatedAt);
    if (state.settingsUpdatedAt === updatedAt) {
      state.settingsSyncPending = false;
      saveState(state);
    }
  } catch (error) {
    console.warn('Retirement settings background sync failed:', error);
  } finally {
    settingsSyncInFlight = false;
  }
}

function startSettingsBackgroundSync() {
  if (settingsSyncTimer) clearInterval(settingsSyncTimer);
  settingsSyncTimer = setInterval(syncPendingSettings, 60000);
}

function renderOverview() {
  const previewSettings = previewRetirementSettings();
  const minimumAge = Math.ceil(Number(previewSettings.currentAge || 0)) + 1;
  const planningMaximumAge = 110;
  let lifeExpectancy = Math.min(planningMaximumAge, Math.max(minimumAge + 1, Math.round(Number(previewSettings.lifeExpectancy || 90))));
  const maximumAge = Math.max(minimumAge, lifeExpectancy - 1);
  const selectedAge = Math.min(maximumAge, Math.max(minimumAge, Number(retirementAgePreview ?? state.settings.retirementAge)));
  lifeExpectancy = Math.max(selectedAge + 1, lifeExpectancy);
  retirementAgePreview = selectedAge;
  previewSettings.lifeExpectancy = lifeExpectancy;
  $('#settingsForm').elements.lifeExpectancy.value = lifeExpectancy;
  const previewState = { ...state, settings: { ...previewSettings, retirementAge: selectedAge, lifeExpectancy } };
  const plan = calculatePlan(previewState);
  $('#retirementAgeSlider').min = minimumAge;
  $('#retirementAgeSlider').max = maximumAge;
  $('#retirementAgeSlider').value = selectedAge;
  $('#retirementAgePreview').textContent = `${selectedAge} 歲`;
  $('#retirementAgeMin').textContent = `${minimumAge} 歲`;
  $('#retirementAgeMax').textContent = `${maximumAge} 歲`;
  $('#lifeExpectancySlider').min = selectedAge + 1;
  $('#lifeExpectancySlider').max = planningMaximumAge;
  $('#lifeExpectancySlider').value = lifeExpectancy;
  $('#lifeExpectancyPreview').textContent = `${lifeExpectancy} 歲`;
  $('#lifeExpectancyMin').textContent = `${selectedAge + 1} 歲`;
  $('#lifeExpectancyMax').textContent = `${planningMaximumAge} 歲`;
  $('#retirementRateAssumptions').textContent = `試算假設：退休前年化報酬率 ${FIXED_RETIREMENT_RATES.preReturn}%、退休後年化報酬率 ${FIXED_RETIREMENT_RATES.postReturn}%、預估通膨率 ${FIXED_RETIREMENT_RATES.inflation}%。`;
  const investmentNote = plan.gap >= 0
    ? `平均月結餘 ${money.format(plan.availableMonthlyInvestment)}，配息持續再投入`
    : `平均月結餘 ${money.format(plan.availableMonthlyInvestment)}；原訂年齡不足則調整退休年齡`;
  const partTimeNote = plan.partTimeIncomeGap > 0
    ? `原訂年齡資金需求為 ${money.format(plan.requiredSemiIncome)}，仍有 ${money.format(plan.partTimeIncomeGap)} 缺口`
    : `足以支應原訂年齡所需的 ${money.format(plan.requiredSemiIncome)}`;
  $('#metrics').innerHTML = [
    metric('目前淨資產', money.format(plan.assets), '帳戶餘額＋持股市值＋勞退－剩餘房貸', '', '帳戶餘額＋持股市值＋勞退專戶－剩餘房貸'),
    metric('半退休目標資產', money.format(plan.target), '含家庭、健康、保費與退休給付', '', '逐月反推可支付至規劃年齡，且全程保留各項預備金的最低資產'),
    metric(`${selectedAge} 歲預估資產`, money.format(plan.projected), plan.projected >= plan.target ? '可達成目標' : '仍有資金缺口', '', '目前可投資資產＋每月投入的退休前實質複利＋屆時勞退'),
    metric('半退休後預估兼職月收入', money.format(plan.estimatedPartTimeIncome), partTimeNote, '', '依個人職能設定的保守基準＝每月 25,000'),
    metric('半退休投資月收益', money.format(plan.projectedInvestmentIncome), '以半退休時可投資資產與退休後實質報酬率估算', '', '（半退休可投資資產－預備金）× 退休後實質月報酬率')
  ].join('');
  const investmentGap = Math.max(0, -plan.gap);
  const retirementAction = plan.configuredPlanFeasible
    ? `<strong>維持 ${selectedAge} 歲</strong><small>依目前條件可行</small>`
    : plan.suggestedRetirementAge != null
      ? `<strong>調整至 ${plan.suggestedRetirementAge} 歲</strong><small>若維持 ${selectedAge} 歲，每月需再投入 ${money.format(investmentGap)}</small>`
      : `<strong>需調整計畫</strong><small>降低支出、增加投入或延後半退休</small>`;
  const semiRetirementAction = plan.partTimeIncomeGap > 0
    ? `<strong>準備兼職 ${money.format(plan.estimatedPartTimeIncome)}／月</strong><small>${selectedAge} 歲半退休後開始；執行後仍缺 ${money.format(plan.partTimeIncomeGap)}／月</small>`
    : `<strong>準備兼職 ${money.format(plan.estimatedPartTimeIncome)}／月</strong><small>${selectedAge} 歲半退休後開始；預估可支應收入需求</small>`;
  $('#actionItems').innerHTML = `<article class="action-item"><span>現在</span><strong>每月投入 ${money.format(plan.reasonableMonthlyInvestment)}</strong><small>${investmentNote}</small><div class="formula">公式：（平均總收入〔含配息〕－平均總支出）× 90%</div></article><article class="action-item"><span>退休時機</span>${retirementAction}</article><article class="action-item"><span>半退休後待辦</span>${semiRetirementAction}</article>`;
  $('#progressText').textContent = `${plan.progress.toFixed(0)}%`;
  $('#progressRing').style.setProperty('--progress', `${plan.progress}%`);
  $('#targetAgeBadge').textContent = `${selectedAge} 歲`;
  $('#currentAssetsLabel').textContent = `目前 ${money.format(plan.assets)}`;
  $('#targetAssetsLabel').textContent = `目標 ${money.format(plan.target)}`;
  const overviewUpdatedAt = Math.max(...[
    state.assetsUpdatedAt, state.cashflowsUpdatedAt, state.settingsUpdatedAt, state.mortgage?.updatedAt
  ].map((value) => Date.parse(value || '') || 0));
  $('#updatedAt').textContent = overviewUpdatedAt ? `更新於 ${new Date(overviewUpdatedAt).toLocaleString('zh-TW')}` : '尚未建立資料';
  const planStatus = plan.configuredPlanFeasible ? `${selectedAge} 歲計畫可行` : `${selectedAge} 歲計畫目前不可行`;
  const timing = plan.suggestedRetirementAge == null
    ? '目前條件下無可行年齡'
    : `${plan.suggestedRetirementAge} 歲`;
  const spendingControl = plan.requiredMonthlySpendingReduction == null
    ? '只降低生活費仍不足，需搭配延後退休或增加資產'
    : plan.requiredMonthlySpendingReduction > 1
      ? `每月降低 ${money.format(plan.requiredMonthlySpendingReduction)}`
      : '不需降低生活費';
  const laborPensionPlan = plan.laborPensionPayoutMode === 'monthly'
    ? `<strong>按月領：約 ${money.format(plan.laborPensionEstimatedMonthlyBenefit)}／月</strong><small>60 歲可請領；暫以 ${plan.laborPensionMonthlyPaymentMonths / 12} 年、年金利率 ${(plan.laborPensionAnnuityAnnualRate * 100).toFixed(1)}% 估算，實際依勞保局公告計算。</small>`
    : `<strong>一次領：約 ${money.format(plan.laborPensionEstimatedLumpSum)}</strong><small>60 歲可請領；屆時整筆納入可運用退休資產。</small>`;
  const laborInsurancePlan = plan.laborInsurancePayoutMode === 'monthly'
    ? `<strong>按月領：約 ${money.format(plan.laborInsuranceMonthlyBenefit)}／月</strong><small>65 歲起領；依目前薪資與預估投保年資，採較高年金公式估算。</small>`
    : `<strong>一次領：約 ${money.format(plan.laborInsuranceLumpSumBenefit)}</strong><small>65 歲估算；平均投保薪資 ${money.format(plan.estimatedInsuredSalary)} × ${plan.laborInsuranceBenefitMonths.toFixed(1)} 個月。實際資格與金額以勞保局核定為準。</small>`;
  $('#retirementBenefitAssumption').innerHTML = `<div><span>勞退</span>${laborPensionPlan}</div><div><span>勞保</span>${laborInsurancePlan}</div>`;
  $('#vehiclePlanAssumption').innerHTML = plan.carBudget > 0
    ? `<div><span>代步車規劃</span><strong>購車 ${money.format(plan.carBudget)}</strong></div><small>半退休後開始，分 ${plan.carLoanMonths / 12} 年本息平均攤還，年利率 ${(plan.carLoanAnnualRate * 100).toFixed(0)}%，預估每月 ${money.format(plan.carLoanMonthlyPayment)}。</small>`
    : `<div><span>代步車規劃</span><strong>不買車</strong></div><small>若選擇購車，試算預設於半退休後開始，分 ${plan.carLoanMonths / 12} 年本息平均攤還，年利率 ${(plan.carLoanAnnualRate * 100).toFixed(0)}%。</small>`;
  $('#recommendations').innerHTML = `<div class="recommendation"><span>原訂計畫狀態</span><strong>${planStatus}</strong></div><div class="recommendation"><span>平均月結餘／合理投入</span><strong>${money.format(plan.availableMonthlyInvestment)}／${money.format(plan.reasonableMonthlyInvestment)}</strong></div><div class="recommendation"><span>若維持原訂年齡：每月投資需再增加</span><strong>${money.format(Math.max(0, -plan.gap))}</strong></div><div class="recommendation"><span>若只調整半退休生活費</span><strong>${spendingControl}</strong></div><div class="recommendation"><span>半退休兼職合理估計／資金需求</span><strong>${money.format(plan.estimatedPartTimeIncome)}／${money.format(plan.requiredSemiIncome)}</strong></div><div class="recommendation"><span>維持生活品質的最早建議年齡</span><strong>${timing}</strong></div>`;
  const scenarios = plan.retirementScenarios || [];
  $('#retirementScenarios').innerHTML = scenarios.length ? scenarios.map((scenario, index) => {
    const investmentGap = Math.max(0, scenario.requiredMonthlyInvestment - scenario.reasonableMonthlyInvestment);
    const incomeGap = Math.max(0, scenario.requiredSemiIncome - plan.estimatedPartTimeIncome);
    const label = scenario.feasible ? '穩健方案' : (index === 0 ? '折衷方案' : '調整方案');
    return `<article class="scenario-card"><div class="scenario-heading"><div><p class="caption">${label}</p><h4>${scenario.age} 歲半退休</h4></div><span class="scenario-status ${scenario.feasible ? 'feasible' : ''}">${scenario.feasible ? '目前條件可行' : '仍有資金缺口'}</span></div><div class="scenario-values"><div><span>預估資產</span><strong>${money.format(scenario.projectedAssets)}</strong></div><div><span>合理／所需月投入</span><strong>${money.format(scenario.reasonableMonthlyInvestment)}／${money.format(scenario.requiredMonthlyInvestment)}</strong></div><div><span>每月投資缺口</span><strong>${money.format(investmentGap)}</strong></div><div><span>半退休兼職需求</span><strong>${money.format(scenario.requiredSemiIncome)}</strong></div><div><span>合理兼職後缺口</span><strong>${money.format(incomeGap)}</strong></div><div><span>投資月收益</span><strong>${money.format(scenario.investmentIncome)}</strong></div></div></article>`;
  }).join('') : '<p class="empty">目前設定範圍內找不到可行替代年齡，需先調整生活費、旅遊、車款或預備金。</p>';
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
  if (field === 'otherCardExpenses' && record.cathayCardExpenses == null && record.fubonCardExpenses == null
    && record.otherCardExpenses == null && record.cashExpenses == null && record.accountExpenses == null) {
    return Number(record.livingExpenses) || 0;
  }
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
    const totalTaxes = cashflowValue(item, 'propertyLandTax') + cashflowValue(item, 'comprehensiveIncomeTax') + cashflowValue(item, 'otherTaxes');
    const totalChildren = cashflowValue(item, 'petExpenses') + cashflowValue(item, 'petInsuranceExpenses');
    row.innerHTML = `<td>${item.month}</td><td class="number">${money.format(item.netSalary || 0)}</td><td class="number tax-record-value">${amountWithNote(item, 'bonus', 'bonusNote')}</td><td class="number">${money.format(cashflowValue(item, 'cathayDividends'))}</td><td class="number">${money.format(cashflowValue(item, 'yuantaDividends'))}</td><td class="number">${money.format(item.fixedExpenses)}</td><td class="number">${money.format(cashflowValue(item, 'cathayCardExpenses'))}</td><td class="number">${money.format(cashflowValue(item, 'fubonCardExpenses'))}</td><td class="number">${money.format(cashflowValue(item, 'otherCardExpenses'))}</td><td class="number">${money.format(cashflowValue(item, 'cashExpenses'))}</td><td class="number">${money.format(cashflowValue(item, 'accountExpenses'))}</td><td class="number">${money.format(cashflowValue(item, 'personalInsuranceExpenses'))}</td><td class="number">${money.format(totalChildren)}</td><td class="number">${money.format(totalTaxes)}</td><td class="number">${money.format(item.totalExpense)}</td><td class="number">${money.format(item.net)}</td><td><div class="row-actions"><button data-edit-cashflow="${item.month}">修改</button></div></td>`;
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
    'managementFee', 'cathayCardExpenses', 'fubonCardExpenses', 'otherCardExpenses', 'cashExpenses', 'accountExpenses', 'personalInsuranceExpenses', 'petExpenses', 'petInsuranceExpenses',
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
    breakdown('管理費', averages.managementFee), breakdown('國泰信用卡', averages.cathayCardExpenses),
    breakdown('富邦信用卡', averages.fubonCardExpenses), breakdown('其他信用卡', averages.otherCardExpenses),
    breakdown('現金支出', averages.cashExpenses), breakdown('帳戶支出', averages.accountExpenses),
    breakdown('個人保險', averages.personalInsuranceExpenses), breakdown('兩隻花費', averages.petExpenses),
    breakdown('兩隻保險', averages.petInsuranceExpenses), breakdown('房屋／地價稅', averages.propertyLandTax),
    breakdown('綜合所得稅', averages.comprehensiveIncomeTax), breakdown('其他稅務', averages.otherTaxes)
  ].join('');
}

const cashflowAmountFields = ['baseSalary', 'mealAllowance', 'taxFreeOvertime', 'laborInsurance', 'healthInsurance', 'incomeTax', 'welfareFund', 'leaveDeduction', 'bonus', 'cathayDividends', 'yuantaDividends', 'mortgage', 'utilities', 'internet', 'managementFee', 'cathayCardExpenses', 'fubonCardExpenses', 'otherCardExpenses', 'cashExpenses', 'accountExpenses', 'personalInsuranceExpenses', 'petExpenses', 'petInsuranceExpenses', 'propertyLandTax', 'comprehensiveIncomeTax', 'otherTaxes'];
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
    const needsLegacyFallback = field === 'cathayDividends' || field === 'yuantaDividends' || field === 'petExpenses'
      || field === 'personalInsuranceExpenses' || field === 'otherCardExpenses';
    const existingValue = record ? (needsLegacyFallback ? cashflowValue(record, field) : record[field]) : null;
    form.elements[field].value = existingValue ?? (carryForward ? fixedExpenseForMonth(field, shiftYearMonth(month, -1), defaults[field]) : defaults[field] ?? 0);
  });
  cashflowNoteFields.forEach((field) => { form.elements[field].value = record?.[field] ?? ''; });
  $('#deleteCashflowRecord').hidden = !record;
  updateMonthlySalaryTotal();
  setMessage($('#cashflowMessage'), record ? '此月份已有紀錄，送出後會直接更新。' : '');
}

function setCashflowTab(name) {
  $$('[data-cashflow-tab]').forEach((button) => button.classList.toggle('active', button.dataset.cashflowTab === name));
  $('#cashflowIncomePanel').hidden = name !== 'income';
  $('#cashflowExpensePanel').hidden = name !== 'expense';
  const month = $('#cashflowForm').elements.month.value;
  const isExisting = state.cashflows.some((item) => item.month === month);
  $('#cashflowEntryTitle').textContent = isExisting ? `修改 ${month} 每月收支` : (name === 'income' ? '新增收入' : '新增支出');
}

function openCashflowEntry(kind, month = currentYearMonth(), returnToRecords = false) {
  returnToCashflowRecords = returnToRecords;
  configureCashflowForm(month);
  setCashflowTab(kind);
  $('#cashflowEntryDialog').showModal();
}

function setCompactChoice(form, key, value) {
  const buttons = $$(`[data-setting="${key}"]`, form);
  if (!buttons.length) return false;
  const selected = buttons.find((button) => button.dataset.value === String(value))
    || buttons.reduce((closest, button) => Math.abs(Number(button.dataset.value) - Number(value)) < Math.abs(Number(closest.dataset.value) - Number(value)) ? button : closest);
  form.elements[key].value = selected.dataset.value;
  buttons.forEach((button) => {
    const active = button === selected;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  return true;
}

function renderSettings() {
  state.settings.currentAge = currentAgeFromBirthYear();
  const form = $('#settingsForm');
  Object.entries(state.settings).forEach(([key, value]) => {
    const field = form.elements[key];
    if (!field) return;
    if (setCompactChoice(form, key, value)) return;
    if (field.tagName === 'SELECT') {
      const options = [...field.options];
      const selected = options.find((option) => option.value === String(value))
        || options.reduce((closest, option) => Math.abs(Number(option.value) - Number(value)) < Math.abs(Number(closest.value) - Number(value)) ? option : closest);
      field.value = selected.value;
      return;
    }
    field.value = value;
  });
  Object.entries(FIXED_RETIREMENT_RATES).forEach(([key, value]) => { form.elements[key].value = value; });
}

function render() {
  renderSettings();
  renderOverview();
  renderAssets();
  renderMortgage();
  renderCashflows();
}

async function generateRetirementAssessment() {
  const form = $('#settingsForm');
  if (!form.reportValidity()) return;
  const selectedAge = Number(retirementAgePreview);
  const nextSettings = { ...previewRetirementSettings(), retirementAge: selectedAge, semiRetirementEndAge: Math.max(selectedAge, 65) };
  if (overviewSettingFields.some((key) => !Number.isFinite(parseNumber(form.elements[key].value)))) {
    setMessage($('#retirementAgeMessage'), '請確認所有設定都是有效數值。', true);
    return;
  }
  if (!Number.isFinite(selectedAge) || selectedAge <= nextSettings.currentAge || selectedAge >= nextSettings.lifeExpectancy) {
    setMessage($('#retirementAgeMessage'), '請選擇介於目前年齡與規劃年齡之間的半退休年齡。', true);
    return;
  }
  if (nextSettings.retirementMonthlySpend < 0 || nextSettings.carBudget < 0 || nextSettings.carBudget > 1200000
    || nextSettings.emergencyCashReserve < 50000 || nextSettings.emergencyCashReserve > 100000
    || !Number.isInteger(nextSettings.annualTravelTrips) || nextSettings.annualTravelTrips < 0
    || nextSettings.parentMedicalReserve < 0 || nextSettings.personalMedicalReserve < 0
    || nextSettings.childrenMonthlySupportAfterRetirement < 0 || nextSettings.childrenMilestoneReserve < 0
    || nextSettings.preReturn < -20 || nextSettings.preReturn > 30 || nextSettings.postReturn < -20 || nextSettings.postReturn > 30
    || nextSettings.inflation < -5 || nextSettings.inflation > 20) {
    setMessage($('#retirementAgeMessage'), '請確認設定範圍；緊急預備金需為 5～10 萬，代步車不可超過 120 萬。', true);
    return;
  }
  persistOverviewSettingsLocally(nextSettings);
  retirementAssessmentVisible = true;
  render();
  setMessage($('#retirementAgeMessage'), '');
  $('#retirementAssessmentDialog').showModal();
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
  const livingExpenses = values.cathayCardExpenses + values.fubonCardExpenses + values.otherCardExpenses + values.cashExpenses + values.accountExpenses;
  const totalExpense = fixedExpenses + livingExpenses + values.personalInsuranceExpenses + values.petExpenses
    + values.petInsuranceExpenses + values.propertyLandTax + values.comprehensiveIncomeTax + values.otherTaxes;
  const record = { month: form.elements.month.value, ...values, ...notes, netSalary, dividends, totalIncome, fixedExpenses, livingExpenses, totalExpense, net: totalIncome - totalExpense };
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

function requestDeleteCashflow(month) {
  const record = state.cashflows.find((item) => item.month === month);
  if (!record) return;
  const dialog = $('#deleteCashflowDialog');
  dialog.dataset.month = month;
  $('#deleteCashflowDescription').textContent = `即將清除 ${month} 的整月收支資料：`;
  $('#deleteCashflowIncome').textContent = money.format(record.totalIncome || 0);
  $('#deleteCashflowExpense').textContent = money.format(record.totalExpense || 0);
  $('#deleteCashflowNet').textContent = money.format(record.net || 0);
  dialog.showModal();
}

async function deleteCashflow(month) {
  const record = state.cashflows.find((item) => item.month === month);
  if (!record) return;
  const records = state.cashflows.filter((item) => item.month !== month);
  const updatedAt = new Date().toISOString();
  const button = $('#confirmDeleteCashflow');
  setBusy(button, true);
  try {
    await writeCashflows(records, updatedAt);
    state.cashflows = records;
    state.cashflowsUpdatedAt = updatedAt;
    saveState(state);
    render();
    configureCashflowForm(currentYearMonth());
    $('#deleteCashflowDialog').close();
    $('#cashflowEntryDialog').close();
    if (returnToCashflowRecords) $('#cashflowRecordsDialog').showModal();
    returnToCashflowRecords = false;
    toast(`已清除 ${month} 全部紀錄`);
  } catch (error) { toast(error.message, true); }
  finally { setBusy(button, false); }
}

window.addEventListener('hashchange', route);
$('#retirementAgeSlider').addEventListener('input', (event) => {
  retirementAgePreview = Number(event.currentTarget.value);
  retirementAssessmentVisible = false;
  $('#retirementAgePreview').textContent = `${retirementAgePreview} 歲`;
  setMessage($('#retirementAgeMessage'), '');
  persistOverviewSettingsLocally();
  if (retirementPreviewFrame) cancelAnimationFrame(retirementPreviewFrame);
  retirementPreviewFrame = requestAnimationFrame(() => {
    retirementPreviewFrame = null;
    renderOverview();
  });
});
$('#lifeExpectancySlider').addEventListener('input', (event) => {
  const lifeExpectancy = Number(event.currentTarget.value);
  $('#settingsForm').elements.lifeExpectancy.value = lifeExpectancy;
  retirementAssessmentVisible = false;
  $('#lifeExpectancyPreview').textContent = `${lifeExpectancy} 歲`;
  setMessage($('#retirementAgeMessage'), '');
  persistOverviewSettingsLocally();
  if (retirementPreviewFrame) cancelAnimationFrame(retirementPreviewFrame);
  retirementPreviewFrame = requestAnimationFrame(() => {
    retirementPreviewFrame = null;
    renderOverview();
  });
});
$('#settingsForm').addEventListener('input', () => {
  retirementAssessmentVisible = false;
  setMessage($('#retirementAgeMessage'), '');
  persistOverviewSettingsLocally();
  if (retirementPreviewFrame) cancelAnimationFrame(retirementPreviewFrame);
  retirementPreviewFrame = requestAnimationFrame(() => {
    retirementPreviewFrame = null;
    renderOverview();
  });
});
$('#settingsForm').addEventListener('click', (event) => {
  const button = event.target.closest('[data-setting]');
  if (!button) return;
  setCompactChoice(event.currentTarget, button.dataset.setting, button.dataset.value);
  event.currentTarget.elements[button.dataset.setting].dispatchEvent(new Event('input', { bubbles: true }));
});
$('#toggleOverviewSettings').addEventListener('click', (event) => {
  const button = event.currentTarget;
  const panel = $('#overviewSettingsPanel');
  const expanded = button.getAttribute('aria-expanded') !== 'true';
  button.setAttribute('aria-expanded', String(expanded));
  const label = expanded ? '收合退休設定' : '展開退休設定';
  button.setAttribute('aria-label', label);
  button.title = label;
  panel.hidden = !expanded;
});
$('#generateRetirementPlan').addEventListener('click', generateRetirementAssessment);
$('[data-cashflow-tab="income"]').closest('.section-tabs').addEventListener('click', (event) => {
  const button = event.target.closest('[data-cashflow-tab]');
  if (button) setCashflowTab(button.dataset.cashflowTab);
});
$('#assetForm').addEventListener('submit', (event) => { event.preventDefault(); saveAssetSummary(event.currentTarget); });
$('#accountBalancesForm').addEventListener('submit', (event) => { event.preventDefault(); saveAccountBalances(event.currentTarget); });
$('#cashflowForm').addEventListener('submit', (event) => { event.preventDefault(); saveCashflow(event.currentTarget); });
$('#cashflowForm').elements.month.addEventListener('change', (event) => configureCashflowForm(event.currentTarget.value));
$('#deleteCashflowRecord').addEventListener('click', () => requestDeleteCashflow($('#cashflowForm').elements.month.value));
$('#confirmDeleteCashflow').addEventListener('click', () => deleteCashflow($('#deleteCashflowDialog').dataset.month));
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
  if (settingsSyncTimer) clearInterval(settingsSyncTimer);
  settingsSyncTimer = null;
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
$('#settingsForm').addEventListener('submit', (event) => event.preventDefault());

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
  const editCashflow = event.target.closest('[data-edit-cashflow]');
  if (editCashflow) {
    $('#cashflowRecordsDialog').close();
    openCashflowEntry('income', editCashflow.dataset.editCashflow, true);
  }
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
