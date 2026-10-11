import { fetchPropertyValuation, validateGithubToken, writeAssets, writeCashflows, writeMortgage, writeSettings } from './api.js';
import { calculatePlan } from './calculator.js';
import { CONFIG } from './config.js';
import { expenseBreakdown } from './cashflow.js';
import { clearGithubToken, loadGithubToken, loadState, saveGithubToken, saveState } from './store.js';

let state;
let toastTimer;
let returnToCashflowRecords = false;
let retirementAgePreview = null;
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

function formulaIcon(formula, label = '查看公式', wide = false) {
  return `<button class="formula-info" type="button" data-formula="${escapeHtml(formula)}"${wide ? ' data-formula-wide="true"' : ''} aria-label="${escapeHtml(label)}" aria-expanded="false" aria-controls="formulaTooltip">i</button>`;
}

function metric(label, value, note, action = '', formula = '', wideFormula = false) {
  return `<article class="metric"><div class="metric-heading"><div class="label">${label}</div><div class="metric-tools">${action}${formula ? formulaIcon(formula, `${label}公式`, wideFormula) : ''}</div></div><div class="value">${value}</div>${note ? `<div class="note">${note}</div>` : ''}</article>`;
}

function formulaValue(value) {
  if (typeof value !== 'number') return String(value);
  return Number.isFinite(value) ? money.format(value) : '—';
}

function formulaLine(sign, value, label, amountWidth = 0) {
  const detailLabel = String(label).replace(/（([^（）]+)）/g, '，$1').replace(/[:：]\s*/g, '，');
  return `${{ '+': '＋', '-': '－', '*': '×', '/': '÷' }[sign] || '　'}${formulaValue(value).padStart(amountWidth, ' ')}（${detailLabel}）`;
}

function formulaBlock(terms, result, label, note = '') {
  const amountWidth = Math.max(0, ...terms.map(([, value]) => formulaValue(value).length), formulaValue(result).length);
  return [...terms.map(([sign, value, name]) => formulaLine(sign, value, name, amountWidth)),
    '─'.repeat(36), formulaLine('', result, label, amountWidth), ...(note ? [note] : [])].join('\n');
}

function setFormula(selector, formula) {
  const button = $(selector);
  if (button) button.dataset.formula = formula;
}

function retirementFundingDetails(plan, settings) {
  const breakdown = plan.targetCashflowBreakdown || {};
  const values = breakdown.presentValues || {};
  const counts = breakdown.paymentCounts || {};
  const retirementMonths = Math.max(0, Math.round((settings.lifeExpectancy - settings.retirementAge) * 12));
  const expenseMonthCount = (count) => count === retirementMonths ? '' : `，共 ${count || 0} 個月`;
  const travelTrips = (settings.annualTravelTrips || 0) * (counts.travel || 0) / 12;
  const travelCount = Number.isInteger(travelTrips) ? `共 ${travelTrips} 次` : `折算約 ${travelTrips.toFixed(1)} 次`;
  const expenseItems = [
    [`生活費（每月 ${money.format(settings.retirementMonthlySpend || 0)}${expenseMonthCount(counts.living)}）`, values.living],
    [`出國旅遊（每年 ${settings.annualTravelTrips || 0} 次，${travelCount}）`, values.travel],
    [`本人第六類健保（每月 ${money.format(plan.healthInsuranceMonthly)}${expenseMonthCount(counts.healthInsurance)}）`, values.healthInsurance],
    [`國民年金保費（每月 ${money.format(plan.nationalPensionMonthlyPremium)}，繳至 65 歲${expenseMonthCount(counts.nationalPensionPremium)}）`, values.nationalPensionPremium],
    ...(values.child ? [[`小孩未成年支出（退休後依孩子年齡計${expenseMonthCount(counts.child)}）`, values.child]] : []),
    ...(values.youngAdultChild ? [[`小孩成年至 25 歲後支出${expenseMonthCount(counts.youngAdultChild)}`, values.youngAdultChild]] : []),
    [`房貸（每月 ${money.format(plan.mortgageMonthlyPayment)}${expenseMonthCount(counts.mortgage)}）`, values.mortgage],
    [`代步車貸款（年利率 ${(plan.carLoanAnnualRate * 100).toFixed(0)}%，每月 ${money.format(plan.carLoanMonthlyPayment)}${expenseMonthCount(counts.car)}）`, values.car]
  ];
  const requiredFundsTotal = expenseItems.reduce((sum, [, amount]) => sum + (amount || 0), breakdown.reserveFloor || 0);
  const laborPensionStartAge = Math.max(settings.retirementAge, 60);
  const incomeItems = [
    [`勞退給付（${plan.laborPensionPayoutMode === 'lump' ? `${laborPensionStartAge} 歲一次領，共 ${counts.laborPension || 0} 次` : `${laborPensionStartAge} 歲起每月 ${money.format(breakdown.laborPensionMonthlyPayment ?? plan.laborPensionEstimatedMonthlyBenefit)}，共 ${counts.laborPension || 0} 個月`}）`, values.laborPension],
    [`勞保給付（${plan.laborInsurancePayoutMode === 'lump' ? `一次領，共 ${counts.laborInsurance || 0} 次` : `65 歲起每月 ${money.format(plan.laborInsuranceMonthlyBenefit)}，共 ${counts.laborInsurance || 0} 個月`}）`, values.laborInsurance],
    [`國保年金（65 歲起每月 ${money.format(plan.nationalPensionMonthlyBenefit)}，共 ${counts.nationalPensionBenefit || 0} 個月）`, values.nationalPensionBenefit],
    [`兼職收入（共 ${counts.partTimeIncome || 0} 個月）`, values.partTimeIncome]
  ];
  const cashAtRetirement = Number(plan.projectedCash || 0);
  const futureIncomeTotal = incomeItems.reduce((sum, [, amount]) => sum + (amount || 0), cashAtRetirement);
  const expenseWidth = Math.max(...expenseItems.map(([, amount]) => formulaValue(amount || 0).length),
    formulaValue(requiredFundsTotal).length, formulaValue(breakdown.reserveFloor || 0).length);
  const requiredFundsFormula = [
    ...expenseItems.map(([label, amount], index) => formulaLine(index === 0 ? '' : '+', amount || 0, label, expenseWidth)),
    formulaLine('+', breakdown.reserveFloor || 0, '保留預備金', expenseWidth),
    '─'.repeat(36),
    formulaLine('', requiredFundsTotal, `${settings.retirementAge} 歲退休目標`, expenseWidth)
  ].join('\n');
  return {
    requiredFundsTotal,
    futureIncomeTotal,
    incomeItems,
    retirementMonths,
    requiredFundsFormula: `試算自 ${settings.retirementAge} 歲到 ${settings.lifeExpectancy} 歲（共 ${retirementMonths} 個月）資金需求\n${requiredFundsFormula}`,
  };
}

const FIXED_RETIREMENT_RATES = { preReturn: 5, postReturn: 3, inflation: 2 };
const overviewSettingFields = ['lifeExpectancy', 'retirementMonthlySpend', 'annualTravelTrips', 'carBudget', 'emergencyCashReserve', 'parentMedicalReserve', 'personalMedicalReserve', 'childrenMonthlySupportAfterRetirement', 'childrenMilestoneReserve', 'preReturn', 'postReturn', 'inflation'];

function previewRetirementSettings() {
  const form = $('#settingsForm');
  const settings = { ...state.settings, currentAge: currentAgeFromBirthYear(), retirementAge: Number(retirementAgePreview ?? state.settings.retirementAge) };
  delete settings.unionInsuranceMonthly;
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
  closeFormulaTooltip();
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
  const settings = previewState.settings;
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
  const funding = retirementFundingDetails(plan, settings);
  const hasRetirementTarget = Number.isFinite(plan.requiredPortfolio);
  const reserveFloor = plan.targetCashflowBreakdown.reserveFloor || 0;
  const cashReserveShortfall = Math.max(0, reserveFloor - plan.projectedCash);
  const investableAtRetirement = plan.projectedHoldings + Math.max(0, plan.projectedCash - reserveFloor);
  const holdingsShortfall = hasRetirementTarget ? Math.max(0, plan.requiredHoldings - investableAtRetirement) : null;
  const noSaleAssetShortfall = holdingsShortfall == null ? null : holdingsShortfall + cashReserveShortfall;
  const cashflowDifference = Math.round(funding.futureIncomeTotal) - Math.round(funding.requiredFundsTotal);
  const projection = plan.projectedFinancialBreakdown;
  const monthsToRetire = Math.round(plan.yearsToRetire * 12);
  const currentHoldings = Number(state.assetSummary?.holdingsValue || 0);
  const currentAssetFormula = formulaBlock([
    ['', Number(state.assetSummary?.totalBalance || 0), '帳戶餘額'],
    ['+', Number(state.assetSummary?.holdingsValue || 0), '持股市值'],
    ['+', Number(state.assetSummary?.laborPension?.total || 0), '勞退專戶'],
    ['-', Number(state.mortgage?.remainingPrincipal || 0), '目前剩餘房貸']
  ], plan.assets, '目前淨資產');
  const projectedMonthlyCashflow = projection.nonDividendNetTotal;
  const monthlyNetWithoutDividends = plan.averageNet - plan.averageMonthlyDividends;
  const projectedCashTerms = [
    ['', projection.openingCash, '目前帳戶餘額'],
    [projectedMonthlyCashflow >= 0 ? '+' : '-', Math.abs(projectedMonthlyCashflow),
      `平均月結餘 ${money.format(monthlyNetWithoutDividends)}，不含每月配息`]
  ];
  if (projection.investmentTotal) projectedCashTerms.push(['-', projection.investmentTotal, `每月投入持股 ${money.format(plan.reasonableMonthlyInvestment)}，共 ${monthsToRetire} 個月`]);
  if (projection.mortgageCashAdjustment) projectedCashTerms.push([
    projection.mortgageCashAdjustment > 0 ? '+' : '-', Math.abs(projection.mortgageCashAdjustment), '房貸月付與目前紀錄的差異'
  ]);
  const projectedHoldingsTerms = [
    ['', currentHoldings, '目前持股市值'],
    [projection.openingHoldingsGrowth >= currentHoldings ? '+' : '-', Math.abs(projection.openingHoldingsGrowth - currentHoldings),
      `預估年成長: 目前持股市值 × ${settings.preReturn - settings.inflation}% × ${monthsToRetire / 12} 年`],
    ['+', projection.dividendTotal, `預估配息再投入: 過去平均一年配息 ${money.format(plan.averageMonthlyDividends * 12)} × ${monthsToRetire / 12} 年`],
    ['+', projection.reinvestedDividendGrowth, `預估再投入配息的股價成長: 過去平均一年配息 × ${settings.preReturn - settings.inflation}% × ${monthsToRetire / 12} 年`]
  ];
  if (projection.investmentGrowth) projectedHoldingsTerms.push(['+', projection.investmentGrowth, `每月投入 ${money.format(plan.reasonableMonthlyInvestment)}，共 ${monthsToRetire} 個月，含報酬`]);
  const projectedAssetFormula = [
    `從目前 ${settings.currentAge} 歲推算至 ${selectedAge} 歲（${monthsToRetire} 個月）。`,
    formulaBlock(projectedHoldingsTerms, plan.projectedHoldings, `${selectedAge} 歲預估資產`)
  ].join('\n\n');
  const cashflowWidth = Math.max(formulaValue(plan.projectedCash).length,
    ...funding.incomeItems.map(([, amount]) => formulaValue(amount || 0).length),
    formulaValue(funding.futureIncomeTotal).length);
  const cashDetailWidth = Math.max(...projectedCashTerms.map(([, amount]) => formulaValue(amount).length));
  const projectedCashflowFormula = [
    `試算自 ${selectedAge} 歲到 ${settings.lifeExpectancy} 歲（共 ${funding.retirementMonths} 個月）預估現金流`,
    formulaLine('', plan.projectedCash, `預估帳戶餘額，從 ${settings.currentAge} 歲推算至 ${selectedAge} 歲，共 ${monthsToRetire} 個月`, cashflowWidth),
    ...projectedCashTerms.map(([sign, amount, label]) => `${' '.repeat(13)}${formulaLine(sign, amount, label, cashDetailWidth)}`),
    ...funding.incomeItems.map(([label, amount]) => formulaLine('+', amount || 0, label, cashflowWidth)),
    '─'.repeat(70),
    formulaLine('', funding.futureIncomeTotal, `${selectedAge} 歲預估現金流`, cashflowWidth)
  ].join('\n');
  const requiredPortfolioFormula = [
    `退休後不出售持股；每月配息與勞退、勞保、國保收入先支付支出，剩餘款再投入持股。`,
    `預估年殖利率 = 過去 ${plan.dividendObservationMonths} 個月的月均配息 ${money.format(plan.averageMonthlyDividends)} × 12 ÷ ${selectedAge} 歲預估資產 ${money.format(plan.projectedHoldings)} = ${(plan.dividendYield * 100).toFixed(2)}%；紀錄未滿一年時屬暫估。`,
    `退休後股價實質年成長 ${settings.postReturn - settings.inflation}%（不含配息）；配息另外計入現金流。`,
    `按預估持股與可投入的帳戶餘額，${selectedAge} 歲首月月均配息約 ${money.format(plan.estimatedRetirementMonthlyDividend)}；配息以月均值試算。`,
    formulaBlock([
      ['', plan.requiredHoldings, '不賣股時所需持股'],
      ['+', plan.targetCashflowBreakdown.reserveFloor || 0, '須保留的現金預備金']
    ], plan.requiredPortfolio, `${selectedAge} 歲不賣股所需持股與現金`, hasRetirementTarget
      ? '逐月反推至規劃年齡。'
      : '依目前配息紀錄，無法在不出售持股的條件下完成試算；請先確認配息紀錄與支出設定。')
  ].join('\n\n');
  const monthlyExtraInvestment = Number.isFinite(plan.requiredMonthly) ? Math.ceil(Math.max(0, plan.requiredMonthly)) : null;
  const differenceFormula = formulaBlock([
    ['', Math.round(funding.futureIncomeTotal), `${selectedAge} 歲預估現金流`],
    ['-', Math.round(funding.requiredFundsTotal), `${selectedAge} 歲退休目標`]
  ], cashflowDifference, '差額', '只比較退休目標與預估現金流；持股不出售，另於下方代辦事項規劃。');
  $('#metrics').innerHTML = [
    metric('目前淨資產', money.format(plan.assets), '', '', currentAssetFormula),
    metric(`${selectedAge} 歲退休目標`, money.format(funding.requiredFundsTotal), '', '', funding.requiredFundsFormula, true),
    metric(`${selectedAge} 歲預估資產`, money.format(plan.projectedHoldings), '', '', projectedAssetFormula, true),
    metric(`${selectedAge} 歲預估現金流`, money.format(funding.futureIncomeTotal), '', '', projectedCashflowFormula, true),
    metric('差額', money.format(cashflowDifference), '', '', differenceFormula)
  ].join('');
  const partTimeMonthlyInvestment = Number.isFinite(plan.requiredMonthlyWithPartTime)
    ? Math.ceil(Math.max(0, plan.requiredMonthlyWithPartTime)) : null;
  const partTimeMonthlyIncome = Number.isFinite(plan.requiredPartTimeIncomeWithInvestment)
    ? Math.ceil(Math.max(0, plan.requiredPartTimeIncomeWithInvestment)) : null;
  const displayPlanMoney = (amount) => Number.isFinite(amount) ? money.format(amount) : '無法試算';
  const extraNoWorkDividend = plan.noWorkRetirementDividend == null ? null
    : Math.max(0, plan.noWorkRetirementDividend - plan.estimatedRetirementMonthlyDividend);
  const extraPartTimeDividend = plan.partTimeRetirementDividend == null ? null
    : Math.max(0, plan.partTimeRetirementDividend - plan.estimatedRetirementMonthlyDividend);
  const partTimeHoursPerDay = partTimeMonthlyIncome == null || !plan.partTimeMonthlyCap ? 0
    : Math.min(plan.partTimeHoursPerDay, partTimeMonthlyIncome / (plan.partTimeHourlyRate * plan.partTimeDaysPerMonth));
  const canCalculateExpenseTarget = plan.cashflowObservationMonths > 0 && monthlyExtraInvestment != null;
  const monthlyExpenseTarget = canCalculateExpenseTarget
    ? Math.floor(Math.max(0, plan.averageMonthlyExpense - monthlyExtraInvestment)) : null;
  const actualExpenseCut = monthlyExpenseTarget == null ? null : plan.averageMonthlyExpense - monthlyExpenseTarget;
  const targetMonthlySurplus = actualExpenseCut == null ? null
    : monthlyNetWithoutDividends + actualExpenseCut;
  const additionalInvestmentAfterCut = actualExpenseCut == null ? null
    : Math.max(0, monthlyExtraInvestment - actualExpenseCut);
  const monthlyInvestmentFormula = [requiredPortfolioFormula, formulaBlock([
    ['', plan.requiredHoldings, `${selectedAge} 歲不賣股所需持股`],
    ['-', investableAtRetirement, `${selectedAge} 歲預估持股與可投入現金`]
  ], hasRetirementTarget ? plan.requiredHoldings - investableAtRetirement : '無法試算', '可產生配息資產差額'),
  formulaBlock([
    ['', holdingsShortfall ?? '無法試算', '尚需增加可產生配息資產'],
    ['+', cashReserveShortfall, '尚需補足現金預備金']
  ], noSaleAssetShortfall ?? '無法試算', `${selectedAge} 歲仍需增加資產`),
  formulaBlock([
    ['', noSaleAssetShortfall ?? '無法試算', `${selectedAge} 歲仍需增加資產`],
    ['', `${monthsToRetire} 個月`, '退休前投入期間']
  ], monthlyExtraInvestment ?? '無法試算', '現在每月需額外投入', '依預估資產與過去月均配息推估殖利率，逐月反推；新增投入先補足預備金，再買入持股。'),
  formulaBlock([
    ['', plan.estimatedRetirementMonthlyDividend, `${selectedAge} 歲原預估首月配息`],
    ['+', extraNoWorkDividend ?? '無法試算', '額外投入增加的首月配息']
  ], plan.noWorkRetirementDividend ?? '無法試算', `${selectedAge} 歲首月預估配息`)].join('\n\n');
  const partTimeInvestmentFormula = [
    plan.partTimeMonthlyCap ? `兼職只計 ${selectedAge} 歲至未滿 65 歲；先以每天最多 ${plan.partTimeHoursPerDay} 小時反推最低投入，再算實際所需兼職收入。`
      : '退休年齡已滿 65 歲，沒有兼職試算期間。',
    plan.partTimeMonthlyCap ? formulaBlock([
      ['', plan.partTimeHourlyRate, '試算時薪'],
      ['*', `${plan.partTimeDaysPerMonth} 天 × ${plan.partTimeHoursPerDay} 小時`, '每月工作上限']
    ], plan.partTimeMonthlyCap, '兼職月收入上限') : '',
    `退休前每月額外投入持股 ${displayPlanMoney(partTimeMonthlyInvestment)}；退休後每月兼職收入 ${displayPlanMoney(partTimeMonthlyIncome)}，約每天 ${partTimeHoursPerDay.toFixed(1)} 小時。`,
    '逐月檢查不出售持股、現金不低於預備金；每月投入與兼職收入共同補足需求。',
    formulaBlock([
      ['', plan.estimatedRetirementMonthlyDividend, `${selectedAge} 歲原預估首月配息`],
      ['+', extraPartTimeDividend ?? '無法試算', '額外投入增加的首月配息']
    ], plan.partTimeRetirementDividend ?? '無法試算', `${selectedAge} 歲首月預估配息`)
  ].join('\n\n');
  const expenseTargetFormula = !canCalculateExpenseTarget
    ? plan.cashflowObservationMonths === 0
      ? '需有每月收支紀錄，才能計算降低開支後的目標結餘。'
      : '目前無法在不兼職、不賣股的條件下反推每月減支目標。'
    : [
      `依 ${plan.cashflowObservationMonths} 個月的收支紀錄平均；不兼職、不出售持股。`,
      formulaBlock([
        ['', plan.averageMonthlyExpense, '目前平均每月開支'],
        ['-', actualExpenseCut, '每月需減少的開支']
      ], monthlyExpenseTarget, '退休前每月開支目標'),
      formulaBlock([
        ['', monthlyNetWithoutDividends, '目前每月結餘，不含配息'],
        ['+', actualExpenseCut, '減支增加的每月結餘']
      ], targetMonthlySurplus, '目標每月結餘，不含配息'),
      formulaBlock([
        ['', monthlyExtraInvestment, '每月所需新增投入'],
        ['-', Math.min(actualExpenseCut, monthlyExtraInvestment), '減支可提供的投入']
      ], additionalInvestmentAfterCut, '仍需外加投入'),
      `預估年殖利率 = 過去月均配息 ${money.format(plan.averageMonthlyDividends)} × 12 ÷ ${selectedAge} 歲預估資產 ${money.format(plan.projectedHoldings)} = ${(plan.dividendYield * 100).toFixed(2)}%。`,
      formulaBlock([
        ['', plan.estimatedRetirementMonthlyDividend, `${selectedAge} 歲原預估首月配息`],
        ['+', extraNoWorkDividend ?? '無法試算', '新增投入增加的首月配息']
      ], plan.noWorkRetirementDividend ?? '無法試算', `${selectedAge} 歲首月預估配息`),
      `減少的開支形成新結餘，先補足現金預備金，剩餘款投入持股，共 ${monthsToRetire} 個月。`
    ].join('\n\n');
  const retirementTimingFormula = [
    `從 ${Math.ceil(settings.currentAge) + 1} 歲起，逐歲試算至 ${Math.floor(settings.lifeExpectancy) - 1} 歲。`,
    '維持目前收支與投入，不兼職、不出售持股。',
    '每月以配息、勞退、勞保與國保收入支付支出；剩餘款再投入持股。',
    `可行條件：每月現金不低於預備金 ${money.format(reserveFloor)}，持股實質市值不下降。`,
    `最早可行退休年齡：${plan.suggestedRetirementAge == null ? '目前找不到' : `${plan.suggestedRetirementAge} 歲`}`
  ].join('\n');
  const planLine = (label, value) => `<div class="action-item-line"><span>${label}</span><strong>${value}</strong></div>`;
  const planCashflowFormula = (cashflow) => cashflow ? formulaBlock([
    ['', cashflow.dividend, '首月預估配息'],
    ...[
      [cashflow.laborPensionIncome, '勞退月領'],
      [cashflow.laborInsuranceIncome, '勞保月領'],
      [cashflow.nationalPensionIncome, '國保月領'],
      [cashflow.partTimeIncome, '兼職月收入']
    ].filter(([amount]) => amount > 0).map(([amount, description]) => ['+', amount, description]),
    ['-', cashflow.expenses, '首月支出']
  ], cashflow.balance, `${cashflow.age} 歲退休首月預估現金流`, '一次領給付不列入每月收入。') : '目前沒有可行的退休首月現金流試算。';
  const baselineCashflow = plan.baselineAverageCashflow;
  const baselineFirstMonth = plan.baselineFirstMonthCashflow;
  const monthlyGap = baselineCashflow?.shortfall ?? null;
  const firstMonthGap = baselineFirstMonth
    ? Math.max(0, baselineFirstMonth.expenses - baselineFirstMonth.income) : null;
  const firstMonthHoldingsGap = firstMonthGap != null && plan.dividendYield > 0
    ? firstMonthGap * 12 / ((1 + plan.postPriceRate) * plan.dividendYield) : null;
  const summaryFormula = baselineCashflow ? [
    `從 ${selectedAge} 歲至 ${settings.lifeExpectancy} 歲，共 ${baselineCashflow.months} 個月；以下皆以各月金額合計後除以 ${baselineCashflow.months}。`,
    `平均每月開銷 ${money.format(baselineCashflow.expenses)}：生活費、旅遊、健保、國保保費、小孩支出、房貸與車貸。現金預備金不計入每月開銷。`,
    `退休後平均月收入 ${money.format(baselineCashflow.income)}：從 ${selectedAge} 歲到 ${settings.lifeExpectancy} 歲，逐月估算持股配息與勞退、勞保、國保月領，再取平均；不加新投入或兼職，一次領給付不列入經常收入。`,
    `退休後有些月份收入不夠。把這些月份差的錢加起來，平均分攤到退休後 ${baselineCashflow.months} 個月，約每月 ${money.format(monthlyGap)}。`,
    ...(baselineFirstMonth ? [
      `剛退休第一個月：開銷 ${money.format(baselineFirstMonth.expenses)} − 原有收入 ${money.format(baselineFirstMonth.income)} = 還差 ${money.format(firstMonthGap)}。`,
      firstMonthHoldingsGap == null ? '' : `如果這筆首月缺口只靠配息補，以預估年殖利率 ${(plan.dividendYield * 100).toFixed(2)}% 換算，約需增加 ${money.format(firstMonthHoldingsGap)} 的持股。現金預備金已和預估帳戶餘額比較，只補不足部分。`
    ].filter(Boolean) : []),
    '下方「每月額外投入」是在退休前逐月累積持股，並補足現金預備金不足的部分；不能用退休後的平均缺口直接計算。'
  ].join('\n') : '退休期間不足一個月，目前無法計算平均現金流。';
  $('#retirementMonthlySummary').innerHTML = `<div class="retirement-monthly-heading"><span>${selectedAge} 至 ${settings.lifeExpectancy} 歲，每月平均</span>${formulaIcon(summaryFormula, '退休每月收支公式')}</div><div class="retirement-monthly-figures"><div><span>退休開銷</span><strong>${baselineCashflow ? money.format(baselineCashflow.expenses) : '無法試算'}</strong></div><div><span>退休後收入</span><strong>${baselineCashflow ? money.format(baselineCashflow.income) : '無法試算'}</strong></div><div class="retirement-monthly-gap"><span>每月還差</span><strong>${monthlyGap == null ? '無法試算' : money.format(monthlyGap)}</strong></div></div><p>${firstMonthGap == null ? '下方方案按退休後逐月所需資金，反推退休前每月要投入多少。' : `剛退休第一個月還差 ${money.format(firstMonthGap)}；方案一要在退休前增加持股配息，投入金額會另外逐月反推。`}</p>`;
  const planCashflow = (cashflow) => `<div class="plan-cashflow"><span>退休期間平均每月現金流</span>${cashflow
    ? `<div class="plan-cashflow-figures"><span>收入 <strong>${money.format(cashflow.income)}</strong></span><span>支出 <strong>${money.format(cashflow.expenses)}</strong></span></div><div class="plan-cashflow-net">結餘 <strong>${money.format(cashflow.balance)}</strong></div>`
    : '<div class="plan-cashflow-net">目前無法試算</div>'}</div>`;
  const averageCashflowFormula = (cashflow) => cashflow
    ? `${cashflow.age} 歲至 ${settings.lifeExpectancy} 歲，共 ${cashflow.months} 個月。\n平均每月收入 = 逐月配息、勞退、勞保、國保與兼職收入合計 ÷ ${cashflow.months} = ${money.format(cashflow.income)}。\n平均每月支出 = 各月退休開銷合計 ÷ ${cashflow.months} = ${money.format(cashflow.expenses)}。\n平均每月結餘 = ${money.format(cashflow.income)} − ${money.format(cashflow.expenses)} = ${money.format(cashflow.balance)}；正數逐月再投入持股。一次領給付不列入經常收入。`
    : '目前無法試算平均每月現金流。';
  const planCard = (formula, label, lines, note, cashflow, averageCashflow, wide = false) =>
    `<div class="plan-option"><article class="action-item">${formulaIcon(`${formula}\n\n${planCashflowFormula(cashflow)}\n\n${averageCashflowFormula(averageCashflow)}`, label, wide)}<div class="action-item-main">${lines.join('')}</div><small>${note}</small></article>${planCashflow(averageCashflow)}</div>`;
  $('#actionItems').innerHTML = [
    planCard(monthlyInvestmentFormula, '不兼職配息方案公式', [
      planLine('每月額外投入', monthlyExtraInvestment == null ? '無法試算' : money.format(monthlyExtraInvestment))
    ], `${selectedAge} 歲首月配息約 ${displayPlanMoney(plan.noWorkRetirementDividend)}／月，增加 ${displayPlanMoney(extraNoWorkDividend)}／月；不出售持股。`, plan.noWorkRetirementCashflow, plan.noWorkAverageCashflow, true),
    planCard(partTimeInvestmentFormula, '配息兼職方案公式', partTimeMonthlyInvestment == null ? [
      planLine('每月額外投入', '無法試算')
    ] : [
      planLine('每月額外投入', money.format(partTimeMonthlyInvestment)),
      planLine('搭配每月兼職收入', displayPlanMoney(partTimeMonthlyIncome))
    ], `約每天 ${partTimeHoursPerDay.toFixed(1)} 小時；${selectedAge} 歲首月配息約 ${displayPlanMoney(plan.partTimeRetirementDividend)}／月。以時薪 ${money.format(plan.partTimeHourlyRate)}、每月 ${plan.partTimeDaysPerMonth} 天試算。`, plan.partTimeRetirementCashflow, plan.partTimeAverageCashflow, true),
    planCard(expenseTargetFormula, '降低開銷與新增投入公式', canCalculateExpenseTarget ? [
      planLine('每月降低開銷', money.format(actualExpenseCut)),
      planLine('並投入', money.format(monthlyExtraInvestment))
    ] : [planLine('降低開銷與投入', plan.cashflowObservationMonths === 0 ? '需先建立收支紀錄' : '目前無法試算')],
    canCalculateExpenseTarget ? `開銷降至 ${money.format(monthlyExpenseTarget)}（減少 ${money.format(actualExpenseCut)}）${additionalInvestmentAfterCut > 0 ? `，另加投入 ${money.format(additionalInvestmentAfterCut)}` : ''}；按預估年殖利率 ${(plan.dividendYield * 100).toFixed(2)}%，${selectedAge} 歲首月多 ${displayPlanMoney(extraNoWorkDividend)} 配息。` : '依目前每月支出與結餘反推。', canCalculateExpenseTarget ? plan.noWorkRetirementCashflow : null, canCalculateExpenseTarget ? plan.noWorkAverageCashflow : null, true),
    planCard(retirementTimingFormula, '建議退休年齡公式', [
      planLine('建議', plan.suggestedRetirementAge == null ? '目前無可行年齡' : `${plan.suggestedRetirementAge} 歲再退休`)
    ], '維持目前投入、不兼職且不出售持股時，最早可行的退休年齡。', plan.suggestedRetirementCashflow, plan.suggestedAverageCashflow)
  ].join('');
  const overviewUpdatedAt = Math.max(...[
    state.assetsUpdatedAt, state.cashflowsUpdatedAt, state.settingsUpdatedAt, state.mortgage?.updatedAt
  ].map((value) => Date.parse(value || '') || 0));
  $('#updatedAt').textContent = overviewUpdatedAt ? `更新於 ${new Date(overviewUpdatedAt).toLocaleString('zh-TW')}` : '尚未建立資料';
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
  updatePensionTotalFormula();
  $('#openTenureDialog').textContent = `（累積提繳年資：${Number(pension.tenureYears ?? 20)} 年 ${Number(pension.tenureMonths ?? 8)} 個月）`;
  $('#assetsUpdatedAt').textContent = state.assetsUpdatedAt ? `更新於 ${new Date(state.assetsUpdatedAt).toLocaleString('zh-TW')}` : '尚未建立資料';
}

function updatePensionTotalFormula() {
  const form = $('#assetForm');
  const contribution = parseNumber(form.elements.employerContribution.value);
  const returns = parseNumber(form.elements.pensionReturns.value);
  setFormula('.pension-total .formula-info', formulaBlock([
    ['', contribution, '雇主提繳累積金額'],
    ['+', returns, '投資收益']
  ], contribution + returns, '勞退專戶總額'));
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
  const remainingMortgageFormula = formulaBlock([
    ['', Number(latestAnnual?.closingPrincipal ?? mortgage.remainingPrincipal ?? 0), latestAnnual ? `${latestAnnual.year} 年期末本金` : '房貸資料目前本金']
  ], Number(mortgage.remainingPrincipal || 0), '目前剩餘房貸', '未來每月餘額＝上月本金 ×（1＋月利率）－當月還款，最低以 0 計。');
  const monthlyMortgageFormula = formulaBlock([
    ['', Number(mortgage.monthlyPayment || 0), '房貸資料設定月付'],
    ['', Number(mortgage.monthlyPrincipalPaid || 0), '參考：每月已還本金'],
    ['', Number(mortgage.monthlyInterestPaid || 0), '參考：每月已付利息']
  ], Number(mortgage.monthlyPayment || 0), '試算使用月付金', '本金與利息為紀錄參考；未來攤還以設定月付金計算。');
  const mortgageTimeFormula = formulaBlock([
    ['', Number(mortgage.remainingPrincipal || 0), '目前剩餘房貸'],
    ['', Number(mortgage.monthlyPayment || 0), '每月還款'],
    ['', `${Number(mortgage.interestRate || 0)}%`, '房貸年利率']
  ], payoff, '預估剩餘時間', '依月利率與月付金逐月攤還，至本金歸零為止。');
  const ltvFormula = formulaBlock([
    ['', Number(mortgage.remainingPrincipal || 0), '目前剩餘房貸'],
    ['/', Number(mortgage.propertyValue || 0), '房屋估值']
  ], `${ltv.toFixed(1)}%`, '目前貸款成數', '房屋估值為 0 時顯示 0%。');
  $('#mortgageMetrics').innerHTML = [
    metric('剩餘房貸', money.format(mortgage.remainingPrincipal), `原始貸款本金 ${money.format(mortgage.originalPrincipal)}`, '', remainingMortgageFormula),
    metric('每月還款', money.format(mortgage.monthlyPayment || 0), latestAnnual ? `${latestAnnual.year} 已還本金 ${money.format(latestAnnual.principalPaid)}・利息 ${money.format(latestAnnual.interestPaid)}` : '尚無年度紀錄', '', monthlyMortgageFormula),
    metric('房貸剩餘時間', payoff, mortgage.startMonth ? `自 ${mortgage.startMonth} 起～${mortgage.termYears || 0} 年` : '尚無貸款起始年月', '', mortgageTimeFormula),
    metric('目前貸款成數', `${ltv.toFixed(1)}%`, mortgage.propertyValue > 0 ? `估值 ${money.format(mortgage.propertyValue)}（${mortgage.valuationUnitPriceWan || 0} 萬/坪）` : '尚無房屋估值', '<button id="refreshValuationButton" class="button secondary compact" type="button">更新估值</button>', ltvFormula)
  ].join('');
  $('#mortgageUpdatedAt').textContent = mortgage.updatedAt ? `更新於 ${new Date(mortgage.updatedAt).toLocaleString('zh-TW')}` : '尚未建立資料';
  const totalInterestPaid = annualSummaries.reduce((total, payment) => total + Number(payment.interestPaid || 0), 0);
  const totalPrincipalPaid = annualSummaries.reduce((total, payment) => total + Number(payment.principalPaid || 0), 0);
  $('#totalMortgageInterest').textContent = money.format(totalInterestPaid);
  $('#totalMortgagePrincipal').textContent = money.format(totalPrincipalPaid);
  setFormula('#mortgageHistoryDialog .dialog-heading .formula-info', [
    formulaBlock(annualSummaries.map((summary, index) => [index === 0 ? '' : '+', Number(summary.interestPaid || 0), `${summary.year} 年利息`]), totalInterestPaid, '已支付利息合計'),
    formulaBlock(annualSummaries.map((summary, index) => [index === 0 ? '' : '+', Number(summary.principalPaid || 0), `${summary.year} 年本金`]), totalPrincipalPaid, '已支付本金合計')
  ].join('\n'));
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
  $('#cashflowYearValue').textContent = selectedYear ? `${selectedYear} 年` : '全部年份';
  $('#cashflowYearMenu').replaceChildren(...['', ...years].map((year) => {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'year-picker-option';
    option.role = 'menuitemradio';
    option.dataset.year = year;
    option.setAttribute('aria-checked', String(year === selectedYear));
    option.textContent = year ? `${year} 年` : '全部年份';
    return option;
  }));
  const visibleRecords = selectedYear ? records.filter((item) => item.month.startsWith(`${selectedYear}-`)) : records;
  const body = $('#cashflowTable tbody');
  body.replaceChildren(...visibleRecords.map((item) => {
    const row = document.createElement('tr');
    const expenses = expenseBreakdown(item);
    const net = (Number(item.totalIncome ?? item.income) || 0) - expenses.total;
    row.innerHTML = `<td>${item.month}</td><td class="number">${money.format(item.netSalary || 0)}</td><td class="number tax-record-value">${amountWithNote(item, 'bonus', 'bonusNote')}</td><td class="number">${money.format(cashflowValue(item, 'cathayDividends'))}</td><td class="number">${money.format(cashflowValue(item, 'yuantaDividends'))}</td><td class="number">${money.format(expenses.fixed)}</td><td class="number">${money.format(expenses.taxes)}</td><td class="number">${money.format(expenses.living)}</td><td class="number">${money.format(expenses.insurance)}</td><td class="number">${money.format(expenses.child)}</td><td class="number">${money.format(expenses.total)}</td><td class="number">${money.format(net)}</td><td><div class="row-actions"><button data-edit-cashflow="${item.month}">修改</button></div></td>`;
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
  const averages = Object.fromEntries(['netSalary', 'bonus', 'cathayDividends', 'yuantaDividends', 'totalIncome'].map((field) => [field, average(field)]));
  const averageExpenses = records.reduce((sum, record) => {
    const expenses = expenseBreakdown(record);
    Object.keys(sum).forEach((key) => { sum[key] += expenses[key] / records.length; });
    return sum;
  }, { fixed: 0, taxes: 0, living: 0, insurance: 0, child: 0, total: 0 });
  const averageNet = averages.totalIncome - averageExpenses.total;
  const period = records.length === 1 ? records[0].month : `${records.at(-1).month} ～ ${records[0].month}`;
  const monthCountFormula = formulaBlock([
    ['', period, '收支紀錄期間']
  ], `${records.length} 個月`, '統計月份');
  const averageIncomeFormula = formulaBlock([
    ['', averages.totalIncome * records.length, '收入合計'],
    ['/', `${records.length} 個月`, '紀錄月份數']
  ], averages.totalIncome, '平均月收入', '收入包含薪資、獎金與配息。');
  const averageExpenseFormula = formulaBlock([
    ['', averageExpenses.fixed, '平均固定支出'],
    ['+', averageExpenses.taxes, '平均稅負'],
    ['+', averageExpenses.living, '平均生活開銷（扣除小孩）'],
    ['+', averageExpenses.insurance, '平均個人保險'],
    ['+', averageExpenses.child, '平均小孩支出']
  ], averageExpenses.total, '平均月支出');
  const averageNetFormula = formulaBlock([
    ['', averages.totalIncome, '平均月收入'],
    ['-', averageExpenses.total, '平均月支出']
  ], averageNet, '平均月結餘');
  $('#cashflowAverageMetrics').innerHTML = [
    metric('統計月份', `${records.length} 個月`, period, '', monthCountFormula),
    metric('平均收入', money.format(averages.totalIncome), '', '', averageIncomeFormula),
    metric('平均支出', money.format(averageExpenses.total), '', '', averageExpenseFormula),
    metric('平均月結餘', money.format(averageNet), averageNet >= 0 ? '平均可投入或保留的資金' : '平均每月支出超過收入', '', averageNetFormula)
  ].join('');
  const breakdown = (label, value) => `<div class="breakdown-row"><span>${label}</span><strong>${money.format(value || 0)}</strong></div>`;
  $('#averageIncomeBreakdown').innerHTML = [
    breakdown('薪資', averages.netSalary), breakdown('獎金', averages.bonus),
    breakdown('國泰配息', averages.cathayDividends), breakdown('元大配息', averages.yuantaDividends)
  ].join('');
  $('#averageExpenseBreakdown').innerHTML = [
    breakdown('固定支出', averageExpenses.fixed), breakdown('稅負', averageExpenses.taxes),
    breakdown('生活開銷（扣除小孩）', averageExpenses.living), breakdown('個人保險', averageExpenses.insurance),
    breakdown('小孩支出', averageExpenses.child)
  ].join('');
}

const cashflowAmountFields = ['baseSalary', 'mealAllowance', 'taxFreeOvertime', 'laborInsurance', 'healthInsurance', 'incomeTax', 'welfareFund', 'leaveDeduction', 'bonus', 'cathayDividends', 'yuantaDividends', 'mortgage', 'utilities', 'internet', 'managementFee', 'cathayCardExpenses', 'fubonCardExpenses', 'otherCardExpenses', 'accountExpenses', 'personalInsuranceExpenses', 'petExpenses', 'petInsuranceExpenses', 'propertyLandTax', 'comprehensiveIncomeTax', 'otherTaxes'];
const cashflowNoteFields = ['bonusNote', 'otherTaxesNote'];

function updateExpenseTotals() {
  const form = $('#cashflowForm');
  const value = (field) => parseNumber(form.elements[field].value);
  const fixed = ['mortgage', 'utilities', 'internet', 'managementFee'].reduce((sum, field) => sum + value(field), 0);
  const taxes = ['propertyLandTax', 'comprehensiveIncomeTax', 'otherTaxes'].reduce((sum, field) => sum + value(field), 0);
  const child = value('petExpenses') + value('petInsuranceExpenses');
  const grossLiving = ['cathayCardExpenses', 'fubonCardExpenses', 'otherCardExpenses', 'accountExpenses'].reduce((sum, field) => sum + value(field), Number(form.dataset.legacyCash || 0));
  const insurance = value('personalInsuranceExpenses');
  const valid = [fixed, taxes, child, grossLiving, insurance].every(Number.isFinite) && grossLiving >= child;
  $('#livingExpenseTotal').textContent = valid ? money.format(grossLiving - child) : '—';
  $('#childExpenseTotal').textContent = Number.isFinite(child) ? money.format(child) : '—';
  $('#cashflowExpenseTotal').textContent = valid ? money.format(fixed + taxes + grossLiving - child + insurance + child) : '—';
  setFormula('#livingExpenseTotal + .formula-info', formulaBlock([
    ['', value('cathayCardExpenses'), '國泰信用卡'],
    ['+', value('fubonCardExpenses'), '富邦信用卡'],
    ['+', value('otherCardExpenses'), '其他信用卡'],
    ['+', value('accountExpenses'), '帳戶支出'],
    ...(Number(form.dataset.legacyCash || 0) ? [['+', Number(form.dataset.legacyCash), '舊紀錄現金支出']] : []),
    ['-', value('petExpenses'), '小孩花費'],
    ['-', value('petInsuranceExpenses'), '小孩保險']
  ], valid ? grossLiving - child : Number.NaN, '生活開銷（扣除小孩）', '信用卡與帳戶金額照實輸入，小孩支出只在總支出中計入一次。'));
  setFormula('#childExpenseTotal + .formula-info', formulaBlock([
    ['', value('petExpenses'), '小孩花費'],
    ['+', value('petInsuranceExpenses'), '小孩保險']
  ], child, '小孩支出合計'));
  setFormula('#cashflowExpenseTotal + .formula-info', formulaBlock([
    ['', fixed, '固定支出'],
    ['+', taxes, '稅負'],
    ['+', valid ? grossLiving - child : Number.NaN, '生活開銷（扣除小孩）'],
    ['+', insurance, '個人保險'],
    ['+', child, '小孩支出']
  ], valid ? fixed + taxes + grossLiving + insurance : Number.NaN, '每月總支出'));
}

function updateMonthlySalaryTotal() {
  const form = $('#cashflowForm');
  const additions = ['baseSalary', 'mealAllowance', 'taxFreeOvertime'].map((field) => parseNumber(form.elements[field].value));
  const deductions = ['laborInsurance', 'healthInsurance', 'incomeTax', 'welfareFund', 'leaveDeduction'].map((field) => parseNumber(form.elements[field].value));
  const values = [...additions, ...deductions];
  const total = additions.reduce((sum, value) => sum + value, 0) - deductions.reduce((sum, value) => sum + value, 0);
  $('#monthlySalaryTotal').textContent = values.every(Number.isFinite) ? money.format(total) : '—';
  setFormula('#monthlySalaryTotal + .formula-info', formulaBlock([
    ['', additions[0], '基本薪資'],
    ['+', additions[1], '伙食津貼'],
    ['+', additions[2], '免稅加班費'],
    ['-', deductions[4], '請假扣款'],
    ['-', deductions[0], '勞保'],
    ['-', deductions[1], '健保'],
    ['-', deductions[2], '所得稅'],
    ['-', deductions[3], '福利金']
  ], values.every(Number.isFinite) ? total : Number.NaN, '當月薪資'));
}

function configureCashflowForm(month = currentYearMonth()) {
  const form = $('#cashflowForm');
  const record = state.cashflows.find((item) => item.month === month);
  form.elements.month.value = month;
  form.dataset.legacyCash = String(Number(record?.cashExpenses) || 0);
  const legacyCash = Number(form.dataset.legacyCash);
  $('#legacyCashNote').hidden = legacyCash === 0;
  $('#legacyCashNote').textContent = legacyCash ? `此月份的舊現金支出 ${money.format(legacyCash)} 已保留在生活開銷中。` : '';
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
  updateExpenseTotals();
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
  const legacyCash = Number(form.dataset.legacyCash || 0);
  const childExpenses = values.petExpenses + values.petInsuranceExpenses;
  const grossLiving = values.cathayCardExpenses + values.fubonCardExpenses + values.otherCardExpenses + values.accountExpenses + legacyCash;
  if (childExpenses > grossLiving) {
    setMessage($('#cashflowMessage'), '小孩支出不能超過信用卡與帳戶支出的合計。', true); return;
  }
  const livingExpenses = grossLiving - childExpenses;
  const taxes = values.propertyLandTax + values.comprehensiveIncomeTax + values.otherTaxes;
  const totalExpense = fixedExpenses + taxes + livingExpenses + values.personalInsuranceExpenses + childExpenses;
  const existingRecord = state.cashflows.find((item) => item.month === form.elements.month.value);
  const record = { ...(existingRecord || {}), month: form.elements.month.value, ...values, ...notes, cashExpenses: legacyCash, expenseVersion: 2, netSalary, dividends, totalIncome, fixedExpenses, livingExpenses, totalExpense, net: totalIncome - totalExpense };
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
    saveState(state); render(); setMessage($('#assetMessage'), '已更新 Json-data/assets.json');
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
  const totalExpense = expenseBreakdown(record).total;
  $('#deleteCashflowExpense').textContent = money.format(totalExpense);
  $('#deleteCashflowNet').textContent = money.format((Number(record.totalIncome ?? record.income) || 0) - totalExpense);
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
$('#openOverviewSettingsDialog').addEventListener('click', () => $('#overviewSettingsDialog').showModal());
$('[data-cashflow-tab="income"]').closest('.section-tabs').addEventListener('click', (event) => {
  const button = event.target.closest('[data-cashflow-tab]');
  if (button) setCashflowTab(button.dataset.cashflowTab);
});
$('#assetForm').addEventListener('submit', (event) => { event.preventDefault(); saveAssetSummary(event.currentTarget); });
$('#accountBalancesForm').addEventListener('submit', (event) => { event.preventDefault(); saveAccountBalances(event.currentTarget); });
$('#cashflowForm').addEventListener('submit', (event) => { event.preventDefault(); saveCashflow(event.currentTarget); });
$('#cashflowForm').elements.month.addEventListener('change', (event) => configureCashflowForm(event.currentTarget.value));
$('#cashflowExpensePanel').addEventListener('input', updateExpenseTotals);
$('#deleteCashflowRecord').addEventListener('click', () => requestDeleteCashflow($('#cashflowForm').elements.month.value));
$('#confirmDeleteCashflow').addEventListener('click', () => deleteCashflow($('#deleteCashflowDialog').dataset.month));
$('#openIncomeDialog').addEventListener('click', () => openCashflowEntry('income'));
$('#openExpenseDialog').addEventListener('click', () => openCashflowEntry('expense'));
$('#openMortgageHistoryDialog').addEventListener('click', () => $('#mortgageHistoryDialog').showModal());
$('#openCashflowRecordsDialog').addEventListener('click', () => $('#cashflowRecordsDialog').showModal());
$('#cashflowYearFilter').addEventListener('change', renderCashflows);
const yearButton = $('#cashflowYearButton');
const yearMenu = $('#cashflowYearMenu');
function closeYearMenu(restoreFocus = false) {
  yearMenu.hidden = true;
  yearButton.setAttribute('aria-expanded', 'false');
  if (restoreFocus) yearButton.focus();
}
yearButton.addEventListener('click', () => {
  const opening = yearMenu.hidden;
  yearMenu.hidden = !opening;
  yearButton.setAttribute('aria-expanded', String(opening));
  if (opening) yearMenu.querySelector('[aria-checked="true"]')?.focus();
});
yearMenu.addEventListener('click', (event) => {
  const option = event.target.closest('[data-year]');
  if (!option) return;
  $('#cashflowYearFilter').value = option.dataset.year;
  closeYearMenu(true);
  renderCashflows();
});
yearMenu.addEventListener('keydown', (event) => {
  const options = [...yearMenu.querySelectorAll('[data-year]')];
  const index = options.indexOf(document.activeElement);
  if (event.key === 'Escape') {
    event.preventDefault();
    closeYearMenu(true);
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    options[(index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length].focus();
  }
});
document.addEventListener('pointerdown', (event) => {
  if (!event.target.closest('.year-picker')) closeYearMenu();
});
$('#cashflowRecordsDialog').addEventListener('close', () => closeYearMenu());
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
    setMessage($('#mortgageMessage'), '已更新 Json-data/mortgage.json');
  } catch (error) { setMessage($('#mortgageMessage'), error.message, true); }
  finally { setBusy(button, false); }
});

$('#mortgageMetrics').addEventListener('click', async (event) => {
  const button = event.target.closest('#refreshValuationButton');
  if (!button) return;
  setBusy(button, true); setMessage($('#mortgageMessage'), '正在更新社區行情…');
  try {
    const valuation = await fetchPropertyValuation(state.mortgage);
    const next = { ...state.mortgage, ...valuation, updatedAt: new Date().toISOString() };
    await writeMortgage(next);
    state.mortgage = next; saveState(state); render();
    setMessage($('#mortgageMessage'), `房屋估值已更新為 ${money.format(valuation.propertyValue)}。`);
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
    updatePensionTotalFormula();
  });
});
document.addEventListener('click', (event) => {
  const editCashflow = event.target.closest('[data-edit-cashflow]');
  if (editCashflow) {
    $('#cashflowRecordsDialog').close();
    openCashflowEntry('income', editCashflow.dataset.editCashflow, true);
  }
});

const formulaTooltip = $('#formulaTooltip');
let activeFormulaButton = null;
function closeFormulaTooltip() {
  if (formulaTooltip.matches(':popover-open')) formulaTooltip.hidePopover();
  if (activeFormulaButton) activeFormulaButton.setAttribute('aria-expanded', 'false');
  activeFormulaButton = null;
}
document.addEventListener('click', (event) => {
  const button = event.target.closest('.formula-info');
  if (!button) return;
  if (activeFormulaButton === button) { closeFormulaTooltip(); return; }
  closeFormulaTooltip();
  activeFormulaButton = button;
  const tooltipHost = button.closest('dialog') || document.body;
  if (formulaTooltip.parentElement !== tooltipHost) tooltipHost.append(formulaTooltip);
  formulaTooltip.textContent = button.dataset.formula;
  formulaTooltip.classList.toggle('formula-tooltip-wide', button.dataset.formulaWide === 'true');
  button.setAttribute('aria-expanded', 'true');
  formulaTooltip.showPopover();
  const bounds = button.getBoundingClientRect();
  const tooltipWidth = formulaTooltip.getBoundingClientRect().width;
  const tooltipHeight = formulaTooltip.getBoundingClientRect().height;
  const left = Math.max(12, Math.min(bounds.right - tooltipWidth, window.innerWidth - tooltipWidth - 12));
  const below = bounds.bottom + 8;
  const top = below + tooltipHeight <= window.innerHeight - 12 ? below : Math.max(12, bounds.top - tooltipHeight - 8);
  formulaTooltip.style.left = `${left}px`;
  formulaTooltip.style.top = `${top}px`;
});
document.addEventListener('pointerdown', (event) => {
  if (!event.target.closest('.formula-info') && !event.target.closest('#formulaTooltip')) closeFormulaTooltip();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeFormulaTooltip();
});
window.addEventListener('resize', closeFormulaTooltip);
document.addEventListener('scroll', (event) => {
  if (event.target !== formulaTooltip && !formulaTooltip.contains(event.target)) closeFormulaTooltip();
}, true);
$$('dialog').forEach((dialog) => dialog.addEventListener('close', closeFormulaTooltip));

$('#appVersion').textContent = CONFIG.appVersion;
const storedGithubToken = loadGithubToken();
if (storedGithubToken) {
  $('#githubLoginToken').value = storedGithubToken;
  setMessage($('#githubLoginMessage'), '正在驗證已儲存的 Token…');
  unlockWithGithubToken(storedGithubToken).catch((error) => showGithubLogin(error.message, true));
} else {
  showGithubLogin();
}
