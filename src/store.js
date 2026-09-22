import { CONFIG } from './config.js';

const defaults = {
  settings: { currentAge: 30, retirementAge: 65, lifeExpectancy: 90, retirementMonthlySpend: 0, preReturn: 5, postReturn: 3, inflation: 2 },
  settingsUpdatedAt: '',
  assetsUpdatedAt: '',
  cashflowsUpdatedAt: '',
  assetSummary: { totalBalance: 0, holdingsValue: 0, laborPension: { tenureYears: 0, tenureMonths: 0, employerContribution: 0, returns: 0, total: 0 } },
  mortgage: { updatedAt: '', bank: '', startMonth: '', termYears: 0, originalPrincipal: 0, historyStartMonth: '', historyOpeningPrincipal: 0, annualInsurancePremium: 0, lastMonthRemainingPrincipal: 0, remainingPrincipal: 0, interestRate: 0, monthlyPayment: 0, monthlyPrincipalPaid: 0, monthlyInterestPaid: 0, insurancePaid: 0, propertyValue: 0, valuationArea: 0, valuationUnitPriceWan: 0, valuationSourceUrl: '', valuationCommunity: '', valuationUpdatedAt: '', recordMonth: '', note: '', annualSummaries: [], payments: [] },
  cashflowDefaults: { baseSalary: 0, mealAllowance: 0, taxFreeOvertime: 0, laborInsurance: 0, healthInsurance: 0, incomeTax: 0, welfareFund: 0, internet: 0, managementFee: 0 },
  assets: [],
  cashflows: []
};

const copy = (value) => JSON.parse(JSON.stringify(value));

async function fetchDataFile(filename) {
  const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  const url = isLocal
    ? `./data/${filename}`
    : `https://api.github.com/repos/${CONFIG.githubOwner}/${CONFIG.githubDataRepo}/contents/${filename}?ref=${encodeURIComponent(CONFIG.githubBranch)}`;
  const headers = isLocal ? {} : {
    Accept: 'application/vnd.github.raw+json',
    Authorization: `Bearer ${loadGithubToken()}`,
    'X-GitHub-Api-Version': '2022-11-28'
  };
  const response = await fetch(url, { cache: 'no-store', headers });
  if (!response.ok) throw new Error(`無法讀取私人資料 ${filename}（HTTP ${response.status}）。`);
  return response.json();
}

export async function loadState() {
  let local = null;
  try {
    const value = JSON.parse(localStorage.getItem(CONFIG.storageKey));
    if (value && value.settings && Array.isArray(value.assets) && Array.isArray(value.cashflows)) local = value;
  } catch (_) {}
  let snapshot = null;
  let mortgageSnapshot = null;
  let assetsSnapshot = null;
  let cashflowsSnapshot = null;
  let defaultsSnapshot = null;
  [snapshot, mortgageSnapshot, assetsSnapshot, cashflowsSnapshot, defaultsSnapshot] = await Promise.all([
    fetchDataFile('retirement-settings.json'), fetchDataFile('mortgage.json'), fetchDataFile('assets.json'),
    fetchDataFile('cashflows.json'), fetchDataFile('defaults.json')
  ]);
  const state = local || copy(defaults);
  state.assets = (state.assets || []).map((item) => ({ ...item, totalBalance: Number(item.totalBalance ?? item.amount ?? 0), holdingsValue: Number(item.holdingsValue || 0) }));
  state.mortgage = { ...defaults.mortgage, ...(state.mortgage || {}) };
  state.cashflowDefaults = { ...defaults.cashflowDefaults, ...(state.cashflowDefaults || {}), ...(defaultsSnapshot?.cashflow || {}) };
  if (!Array.isArray(state.mortgage.payments)) state.mortgage.payments = [];
  if (snapshot?.settings) {
    const remoteTime = Date.parse(snapshot.updatedAt || '') || 0;
    const localTime = Date.parse(state.settingsUpdatedAt || '') || 0;
    if (!local || remoteTime > localTime) {
      state.settings = { ...defaults.settings, ...snapshot.settings };
      state.settingsUpdatedAt = snapshot.updatedAt || '';
    }
  }
  if (mortgageSnapshot) {
    const remoteTime = Date.parse(mortgageSnapshot.updatedAt || '') || 0;
    const localTime = Date.parse(state.mortgage.updatedAt || '') || 0;
    if (!local || remoteTime > localTime) state.mortgage = { ...defaults.mortgage, ...mortgageSnapshot };
  }
  if (assetsSnapshot) {
    const remoteTime = Date.parse(assetsSnapshot.updatedAt || '') || 0;
    const localTime = Date.parse(state.assetsUpdatedAt || '') || 0;
    if (!local || remoteTime > localTime || (!state.assetSummary?.totalBalance && remoteTime === localTime)) {
      if (Number.isFinite(Number(assetsSnapshot.totalBalance))) {
        state.assetSummary = {
          totalBalance: Number(assetsSnapshot.totalBalance),
          holdingsValue: Number(assetsSnapshot.holdingsValue || 0),
          laborPension: { ...defaults.assetSummary.laborPension, ...(assetsSnapshot.laborPension || {}) }
        };
      } else if (Array.isArray(assetsSnapshot.accounts)) {
        state.assetSummary = {
          totalBalance: assetsSnapshot.accounts.reduce((sum, item) => sum + Number(item.totalBalance ?? item.amount ?? 0), 0),
          holdingsValue: assetsSnapshot.accounts.reduce((sum, item) => sum + Number(item.holdingsValue || 0), 0)
        };
      }
      state.assetsUpdatedAt = assetsSnapshot.updatedAt || '';
    }
  }
  if (cashflowsSnapshot && Array.isArray(cashflowsSnapshot.records)) {
    const remoteTime = Date.parse(cashflowsSnapshot.updatedAt || '') || 0;
    const localTime = Date.parse(state.cashflowsUpdatedAt || '') || 0;
    if (!local || remoteTime >= localTime) {
      state.cashflows = cashflowsSnapshot.records;
      state.cashflowsUpdatedAt = cashflowsSnapshot.updatedAt || '';
    }
  }
  return state;
}

export function saveState(state) {
  localStorage.setItem(CONFIG.storageKey, JSON.stringify(state));
}

export function loadGithubToken() {
  return localStorage.getItem(CONFIG.githubTokenKey) || '';
}

export function saveGithubToken(token) {
  localStorage.setItem(CONFIG.githubTokenKey, token);
}

export function clearGithubToken() {
  localStorage.removeItem(CONFIG.githubTokenKey);
}
