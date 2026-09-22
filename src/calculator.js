function realMonthlyRate(nominalPercent, inflationPercent) {
  const annual = (1 + nominalPercent / 100) / (1 + inflationPercent / 100) - 1;
  return Math.pow(1 + annual, 1 / 12) - 1;
}

function annuityPresentValue(payment, rate, months) {
  if (months <= 0) return 0;
  if (Math.abs(rate) < 1e-10) return payment * months;
  return payment * (1 - Math.pow(1 + rate, -months)) / rate;
}

function requiredPayment(target, principal, rate, months) {
  if (months <= 0) return Math.max(0, target - principal);
  const futurePrincipal = principal * Math.pow(1 + rate, months);
  const gap = Math.max(0, target - futurePrincipal);
  if (Math.abs(rate) < 1e-10) return gap / months;
  return gap * rate / (Math.pow(1 + rate, months) - 1);
}

export function calculatePlan(state) {
  const settings = state.settings;
  const cashBalance = Number(state.assetSummary?.totalBalance || 0);
  const holdingsValue = Number(state.assetSummary?.holdingsValue || 0);
  const laborPension = Number(state.assetSummary?.laborPension?.total || 0);
  const totalAssets = cashBalance + holdingsValue + laborPension;
  const assets = totalAssets - Number(state.mortgage?.remainingPrincipal || 0);
  const investableAssets = Math.max(0, assets);
  const monthsToRetire = Math.max(0, Math.round((settings.retirementAge - settings.currentAge) * 12));
  const retirementMonths = Math.max(0, Math.round((settings.lifeExpectancy - settings.retirementAge) * 12));
  const preRate = realMonthlyRate(settings.preReturn, settings.inflation);
  const postRate = realMonthlyRate(settings.postReturn, settings.inflation);
  const target = annuityPresentValue(settings.retirementMonthlySpend, postRate, retirementMonths);
  const requiredMonthly = requiredPayment(target, investableAssets, preRate, monthsToRetire);
  const averageNet = state.cashflows.length
    ? state.cashflows.reduce((sum, item) => sum + Number(item.totalIncome || item.income || 0) - Number(item.totalExpense || item.expense || 0), 0) / state.cashflows.length : 0;
  const projected = investableAssets * Math.pow(1 + preRate, monthsToRetire)
    + (Math.abs(preRate) < 1e-10 ? averageNet * monthsToRetire : averageNet * (Math.pow(1 + preRate, monthsToRetire) - 1) / preRate);
  return {
    assets,
    target,
    requiredMonthly,
    averageNet,
    projected,
    gap: averageNet - requiredMonthly,
    progress: target > 0 ? Math.max(0, Math.min(100, investableAssets / target * 100)) : 100,
    yearsToRetire: Math.max(0, settings.retirementAge - settings.currentAge)
  };
}
