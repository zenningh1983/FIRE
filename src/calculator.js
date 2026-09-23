function realMonthlyRate(nominalPercent, inflationPercent) {
  const annual = (1 + nominalPercent / 100) / (1 + inflationPercent / 100) - 1;
  return Math.pow(1 + annual, 1 / 12) - 1;
}

function futureValue(principal, payment, rate, months) {
  const principalValue = principal * Math.pow(1 + rate, months);
  if (months <= 0) return principalValue;
  if (Math.abs(rate) < 1e-10) return principalValue + payment * months;
  return principalValue + payment * (Math.pow(1 + rate, months) - 1) / rate;
}

function annuityPayment(principal, rate, months) {
  if (principal <= 0 || months <= 0) return 0;
  if (Math.abs(rate) < 1e-10) return principal / months;
  return principal * rate / (1 - Math.pow(1 + rate, -months));
}

function findMinimum(feasible) {
  if (feasible(0)) return 0;
  let low = 0;
  let high = 1000;
  while (high < 1_000_000_000 && !feasible(high)) high *= 2;
  for (let iteration = 0; iteration < 60; iteration += 1) {
    const middle = (low + high) / 2;
    if (feasible(middle)) high = middle;
    else low = middle;
  }
  return high;
}

const ESTIMATED_PART_TIME_MONTHLY_INCOME = 25000;
const CAR_LOAN_MONTHS = 60;
const CAR_LOAN_ANNUAL_RATE = 0.12;
const LABOR_PENSION_MONTHLY_PAYMENT_MONTHS = 24 * 12;
const LABOR_PENSION_ANNUITY_ANNUAL_RATE = 0.015;

function carLoanMonthlyPayment(principal) {
  const amount = Math.max(0, Number(principal || 0));
  if (!amount) return 0;
  const monthlyRate = CAR_LOAN_ANNUAL_RATE / 12;
  return amount * monthlyRate / (1 - Math.pow(1 + monthlyRate, -CAR_LOAN_MONTHS));
}

function ageInMonthsAtPresent(birthMonth) {
  if (!/^\d{4}-\d{2}$/.test(birthMonth || '')) return Number.POSITIVE_INFINITY;
  const [birthYear, birthMonthNumber] = birthMonth.split('-').map(Number);
  const now = new Date();
  return (now.getFullYear() - birthYear) * 12 + now.getMonth() - birthMonthNumber + 1;
}

function childSupportForMonth(settings, currentMonthlyExpense, monthsFromPresent) {
  const supportUntilMonths = Number(settings.childSupportUntilAge || 20) * 12;
  const birthMonths = [settings.child1BirthMonth, settings.child2BirthMonth].filter((value) => /^\d{4}-\d{2}$/.test(value || ''));
  const expensePerChild = birthMonths.length ? currentMonthlyExpense / birthMonths.length : 0;
  return birthMonths.reduce((total, birthMonth) => {
    const ageInMonths = ageInMonthsAtPresent(birthMonth) + monthsFromPresent;
    return total + (ageInMonths < supportUntilMonths ? expensePerChild : 0);
  }, 0);
}

function releasedChildSupportForMonth(settings, currentMonthlyExpense, monthsFromPresent) {
  const supportUntilMonths = Number(settings.childSupportUntilAge || 20) * 12;
  const birthMonths = [settings.child1BirthMonth, settings.child2BirthMonth].filter((value) => /^\d{4}-\d{2}$/.test(value || ''));
  const expensePerChild = birthMonths.length ? currentMonthlyExpense / birthMonths.length : 0;
  return birthMonths.reduce((total, birthMonth) => {
    const currentAgeInMonths = ageInMonthsAtPresent(birthMonth);
    const expenseHasEnded = currentAgeInMonths < supportUntilMonths
      && currentAgeInMonths + monthsFromPresent >= supportUntilMonths;
    return total + (expenseHasEnded ? expensePerChild : 0);
  }, 0);
}

function youngAdultSupportForMonth(settings, monthsFromPresent) {
  const supportStartMonths = 20 * 12;
  const supportEndMonths = 25 * 12;
  const birthMonths = [settings.child1BirthMonth, settings.child2BirthMonth].filter((value) => /^\d{4}-\d{2}$/.test(value || ''));
  const supportPerChild = birthMonths.length ? Number(settings.childrenMonthlySupportAfterRetirement || 0) / birthMonths.length : 0;
  return birthMonths.reduce((total, birthMonth) => {
    const ageInMonths = ageInMonthsAtPresent(birthMonth) + monthsFromPresent;
    return total + (ageInMonths >= supportStartMonths && ageInMonths < supportEndMonths ? supportPerChild : 0);
  }, 0);
}

function projectLiquidToRetirement(principal, monthlySaving, rate, months, settings, currentChildExpense) {
  let balance = principal;
  for (let month = 0; month < months; month += 1) {
    balance *= 1 + rate;
    balance += monthlySaving
      + releasedChildSupportForMonth(settings, currentChildExpense, month)
      - youngAdultSupportForMonth(settings, month);
  }
  return balance;
}

function retirementIsFunded({ settings, postRate, monthsToRetirement, currentChildExpense, liquidAtStart, pensionAtStart, semiRetirementIncome }) {
  const retirementMonths = Math.max(0, Math.round((settings.lifeExpectancy - settings.retirementAge) * 12));
  const semiRetirementMonths = Math.max(0, Math.round((settings.semiRetirementEndAge - settings.retirementAge) * 12));
  const pensionAccessMonth = Math.round((settings.laborPensionAccessAge - settings.retirementAge) * 12);
  const benefitStartMonth = Math.round((settings.laborInsuranceBenefitAge - settings.retirementAge) * 12);
  const reserveFloor = Number(settings.parentMedicalReserve || 0)
    + Number(settings.personalMedicalReserve || 0)
    + Number(settings.childrenMilestoneReserve || 0)
    + Number(settings.emergencyCashReserve || 0);
  let liquid = liquidAtStart;
  let pension = pensionAtStart;
  let pensionUnlocked = pensionAccessMonth <= 0;
  let laborPensionMonthlyIncome = 0;
  let laborPensionPaymentsRemaining = 0;
  const unlockPension = (month) => {
    if (settings.laborPensionPayoutMode === 'monthly') {
      const annuityMonthlyRate = Math.pow(1 + LABOR_PENSION_ANNUITY_ANNUAL_RATE, 1 / 12) - 1;
      laborPensionMonthlyIncome = annuityPayment(pension, annuityMonthlyRate, LABOR_PENSION_MONTHLY_PAYMENT_MONTHS);
      laborPensionPaymentsRemaining = Math.min(LABOR_PENSION_MONTHLY_PAYMENT_MONTHS, Math.max(0, retirementMonths - month));
    } else {
      liquid += pension;
    }
    pension = 0;
  };
  if (pensionUnlocked) unlockPension(0);
  let laborInsuranceLumpPaid = false;

  for (let month = 0; month < retirementMonths; month += 1) {
    if (!pensionUnlocked && month >= pensionAccessMonth) {
      pensionUnlocked = true;
      unlockPension(month);
    }
    liquid += Math.max(0, liquid - reserveFloor) * postRate;
    if (!pensionUnlocked) pension *= 1 + postRate;
    const isSemiRetired = month < semiRetirementMonths;
    let laborInsuranceIncome = 0;
    if (month >= benefitStartMonth) {
      if (settings.laborInsurancePayoutMode === 'lump') {
        if (!laborInsuranceLumpPaid) {
          laborInsuranceIncome = Number(settings.laborInsuranceLumpSumBenefit || 0);
          laborInsuranceLumpPaid = true;
        }
      } else {
        laborInsuranceIncome = Number(settings.laborInsuranceMonthlyBenefit || 0);
      }
    }
    const income = (isSemiRetired ? semiRetirementIncome : 0)
      + (laborPensionPaymentsRemaining > 0 ? laborPensionMonthlyIncome : 0)
      + laborInsuranceIncome;
    if (laborPensionPaymentsRemaining > 0) laborPensionPaymentsRemaining -= 1;
    const expenses = Number(settings.retirementMonthlySpend || 0)
      + Number(settings.annualTravelTrips || 0) * 150000 / 12
      + (isSemiRetired ? Number(settings.unionInsuranceMonthly || 0) : 0)
      + childSupportForMonth(settings, currentChildExpense, monthsToRetirement + month)
      + youngAdultSupportForMonth(settings, monthsToRetirement + month)
      + (month < CAR_LOAN_MONTHS ? carLoanMonthlyPayment(settings.carBudget) : 0);
    liquid += income - expenses;
    if (liquid < reserveFloor - 0.01) return false;
  }
  return liquid >= reserveFloor - 0.01;
}

export function calculatePlan(state) {
  const recordedCashflows = state.cashflows || [];
  const averageCashflowValue = (field) => recordedCashflows.length
    ? recordedCashflows.reduce((sum, item) => sum + Number(item[field] || 0), 0) / recordedCashflows.length : 0;
  const currentAge = Number(state.settings.currentAge || 0);
  const pensionTenureYears = Number(state.assetSummary?.laborPension?.tenureYears || 0)
    + Number(state.assetSummary?.laborPension?.tenureMonths || 0) / 12;
  const insuredYearsAt65 = pensionTenureYears + Math.max(0, 65 - currentAge);
  const estimatedInsuredSalary = Math.min(45_800, averageCashflowValue('baseSalary'));
  const laborInsuranceMonthlyBenefit = estimatedInsuredSalary > 0 && insuredYearsAt65 > 0 ? Math.max(
    estimatedInsuredSalary * insuredYearsAt65 * 0.00775 + 3000,
    estimatedInsuredSalary * insuredYearsAt65 * 0.0155
  ) : 0;
  const laborInsuranceBenefitMonths = Math.min(45, Math.min(15, insuredYearsAt65) + Math.max(0, insuredYearsAt65 - 15) * 2);
  const laborInsuranceLumpSumBenefit = estimatedInsuredSalary * laborInsuranceBenefitMonths;
  const unionInsuranceMonthly = (averageCashflowValue('laborInsurance') + averageCashflowValue('healthInsurance')) * 2;
  const currentChildExpense = recordedCashflows.length ? recordedCashflows.reduce((sum, item) => {
    const childExpenses = Number(item.petExpenses ?? item.educationExpenses ?? 0) || 0;
    const childInsurance = Number(item.petInsuranceExpenses || 0);
    return sum + childExpenses + childInsurance;
  }, 0) / recordedCashflows.length : 0;
  const settings = {
    ...state.settings,
    semiRetirementEndAge: Math.max(Number(state.settings.retirementAge || 0), 65),
    laborPensionAccessAge: 60,
    laborInsuranceBenefitAge: 65,
    laborInsuranceMonthlyBenefit,
    laborInsuranceLumpSumBenefit,
    unionInsuranceMonthly,
    childSupportUntilAge: 20
  };
  const cashBalance = Number(state.assetSummary?.totalBalance || 0);
  const holdingsValue = Number(state.assetSummary?.holdingsValue || 0);
  const laborPension = Number(state.assetSummary?.laborPension?.total || 0);
  const mortgage = Number(state.mortgage?.remainingPrincipal || 0);
  const assets = cashBalance + holdingsValue + laborPension - mortgage;
  const emergencyCashReserve = Number(settings.emergencyCashReserve || 0);
  const currentEmergencyCash = Math.min(emergencyCashReserve, Math.max(0, cashBalance));
  const investableLiquidAssets = Math.max(0, cashBalance - currentEmergencyCash + holdingsValue - mortgage);
  const monthsToRetire = Math.max(0, Math.round((settings.retirementAge - settings.currentAge) * 12));
  const preRate = realMonthlyRate(settings.preReturn, settings.inflation);
  const postRate = realMonthlyRate(settings.postReturn, settings.inflation);
  const averageNet = recordedCashflows.length
    ? recordedCashflows.reduce((sum, item) => sum + Number(item.totalIncome || item.income || 0) - Number(item.totalExpense || item.expense || 0), 0) / recordedCashflows.length : 0;
  const reasonableMonthlyInvestment = Math.floor(Math.max(0, averageNet) * 0.9 / 1000) * 1000;
  const projectLiquid = (monthlyInvestment, months, planSettings = settings) => (
    projectLiquidToRetirement(investableLiquidAssets, monthlyInvestment, preRate, months, planSettings, currentChildExpense)
      + currentEmergencyCash
  );
  const pensionAtRetirement = futureValue(laborPension, 0, preRate, monthsToRetire);
  const projectedLiquid = projectLiquid(reasonableMonthlyInvestment, monthsToRetire);
  const projected = projectedLiquid + pensionAtRetirement;
  const pensionAccessOffset = Math.max(0, Math.round((settings.laborPensionAccessAge - settings.retirementAge) * 12));
  const pensionAtAccess = pensionAtRetirement * Math.pow(1 + postRate, pensionAccessOffset);
  const laborPensionAnnuityMonthlyRate = Math.pow(1 + LABOR_PENSION_ANNUITY_ANNUAL_RATE, 1 / 12) - 1;
  const estimatedLaborPensionMonthlyBenefit = annuityPayment(pensionAtAccess, laborPensionAnnuityMonthlyRate, LABOR_PENSION_MONTHLY_PAYMENT_MONTHS);
  const reserveFloor = emergencyCashReserve + Number(settings.parentMedicalReserve || 0)
    + Number(settings.personalMedicalReserve || 0) + Number(settings.childrenMilestoneReserve || 0);
  const projectedInvestmentIncome = Math.max(0, projectedLiquid - reserveFloor) * postRate;
  const funded = (liquidAtStart, semiRetirementIncome = 0) => retirementIsFunded({
    settings,
    postRate,
    monthsToRetirement: monthsToRetire,
    currentChildExpense,
    liquidAtStart,
    pensionAtStart: pensionAtRetirement,
    semiRetirementIncome
  });
  const requiredLiquidTarget = findMinimum((liquidAtStart) => retirementIsFunded({
    settings,
    postRate,
    monthsToRetirement: monthsToRetire,
    currentChildExpense,
    liquidAtStart,
    pensionAtStart: pensionAtRetirement,
    semiRetirementIncome: 0
  }));
  const target = requiredLiquidTarget + pensionAtRetirement;
  const requiredMonthly = monthsToRetire > 0
    ? findMinimum((monthlySaving) => funded(
      projectLiquid(monthlySaving, monthsToRetire),
      ESTIMATED_PART_TIME_MONTHLY_INCOME
    )) : 0;
  const semiRetirementMonths = Math.max(0, Math.round((settings.semiRetirementEndAge - settings.retirementAge) * 12));
  const requiredSemiIncome = semiRetirementMonths > 0
    ? findMinimum((monthlyIncome) => funded(projectedLiquid, monthlyIncome)) : 0;
  const configuredPlanFeasible = funded(projectedLiquid, ESTIMATED_PART_TIME_MONTHLY_INCOME);
  const affordableAtMonthlySpend = (monthlySpend) => retirementIsFunded({
    settings: { ...settings, retirementMonthlySpend: monthlySpend },
    postRate,
    monthsToRetirement: monthsToRetire,
    currentChildExpense,
    liquidAtStart: projectedLiquid,
    pensionAtStart: pensionAtRetirement,
    semiRetirementIncome: ESTIMATED_PART_TIME_MONTHLY_INCOME
  });
  let requiredMonthlySpendingReduction = 0;
  if (!configuredPlanFeasible) {
    if (!affordableAtMonthlySpend(0)) requiredMonthlySpendingReduction = null;
    else {
      let affordableSpend = 0;
      let unaffordableSpend = Number(settings.retirementMonthlySpend || 0);
      for (let iteration = 0; iteration < 60; iteration += 1) {
        const middle = (affordableSpend + unaffordableSpend) / 2;
        if (affordableAtMonthlySpend(middle)) affordableSpend = middle;
        else unaffordableSpend = middle;
      }
      requiredMonthlySpendingReduction = Math.max(0, Number(settings.retirementMonthlySpend || 0) - affordableSpend);
    }
  }
  let suggestedRetirementAge = null;
  const firstCandidateAge = Math.max(Math.ceil(settings.retirementAge), Math.ceil(settings.currentAge) + 1);
  const lastCandidateAge = Math.floor(settings.lifeExpectancy) - 1;
  for (let age = firstCandidateAge; age <= lastCandidateAge; age += 1) {
    const candidateSettings = { ...settings, retirementAge: age, semiRetirementEndAge: Math.max(age, 65) };
    const candidateMonths = Math.max(0, Math.round((age - settings.currentAge) * 12));
    const candidatePension = futureValue(laborPension, 0, preRate, candidateMonths);
    const candidateLiquid = projectLiquid(reasonableMonthlyInvestment, candidateMonths, candidateSettings);
    const isFundedAtAge = retirementIsFunded({
      settings: candidateSettings,
      postRate,
      monthsToRetirement: candidateMonths,
      currentChildExpense,
      liquidAtStart: candidateLiquid,
      pensionAtStart: candidatePension,
      semiRetirementIncome: ESTIMATED_PART_TIME_MONTHLY_INCOME
    });
    if (isFundedAtAge) {
      suggestedRetirementAge = age;
      break;
    }
  }
  const scenarioAtAge = (age) => {
    const scenarioSettings = { ...settings, retirementAge: age, semiRetirementEndAge: Math.max(age, 65) };
    const scenarioMonths = Math.max(0, Math.round((age - settings.currentAge) * 12));
    const scenarioPension = futureValue(laborPension, 0, preRate, scenarioMonths);
    const scenarioLiquid = projectLiquid(reasonableMonthlyInvestment, scenarioMonths, scenarioSettings);
    const scenarioFunded = (liquidAtStart, semiIncome) => retirementIsFunded({
      settings: scenarioSettings,
      postRate,
      monthsToRetirement: scenarioMonths,
      currentChildExpense,
      liquidAtStart,
      pensionAtStart: scenarioPension,
      semiRetirementIncome: semiIncome
    });
    const scenarioRequiredInvestment = scenarioMonths > 0 ? findMinimum((monthlySaving) => scenarioFunded(
      projectLiquid(monthlySaving, scenarioMonths, scenarioSettings), ESTIMATED_PART_TIME_MONTHLY_INCOME
    )) : 0;
    const scenarioSemiMonths = Math.max(0, Math.round((scenarioSettings.semiRetirementEndAge - age) * 12));
    const scenarioRequiredSemiIncome = scenarioSemiMonths > 0
      ? findMinimum((monthlyIncome) => scenarioFunded(scenarioLiquid, monthlyIncome)) : 0;
    return {
      age,
      feasible: scenarioFunded(scenarioLiquid, ESTIMATED_PART_TIME_MONTHLY_INCOME),
      projectedAssets: scenarioLiquid + scenarioPension,
      reasonableMonthlyInvestment,
      requiredMonthlyInvestment: scenarioRequiredInvestment,
      requiredSemiIncome: scenarioRequiredSemiIncome,
      investmentIncome: Math.max(0, scenarioLiquid - reserveFloor) * postRate
    };
  };
  const configuredAge = Math.ceil(settings.retirementAge);
  const alternativeAges = [];
  if (suggestedRetirementAge != null && suggestedRetirementAge > configuredAge) {
    const middleAge = Math.ceil((configuredAge + suggestedRetirementAge) / 2);
    if (middleAge > configuredAge && middleAge < suggestedRetirementAge) alternativeAges.push(middleAge);
    alternativeAges.push(suggestedRetirementAge);
  } else {
    alternativeAges.push(configuredAge + 2, configuredAge + 5);
  }
  const retirementScenarios = [...new Set(alternativeAges)]
    .filter((age) => age > configuredAge && age <= lastCandidateAge)
    .slice(0, 2)
    .map(scenarioAtAge);
  return {
    assets,
    target,
    requiredMonthly,
    requiredSemiIncome,
    estimatedPartTimeIncome: ESTIMATED_PART_TIME_MONTHLY_INCOME,
    laborPensionPayoutMode: settings.laborPensionPayoutMode,
    laborPensionEstimatedLumpSum: pensionAtAccess,
    laborPensionEstimatedMonthlyBenefit: estimatedLaborPensionMonthlyBenefit,
    laborPensionMonthlyPaymentMonths: LABOR_PENSION_MONTHLY_PAYMENT_MONTHS,
    laborPensionAnnuityAnnualRate: LABOR_PENSION_ANNUITY_ANNUAL_RATE,
    laborInsurancePayoutMode: settings.laborInsurancePayoutMode,
    laborInsuranceMonthlyBenefit,
    laborInsuranceLumpSumBenefit,
    laborInsuranceBenefitMonths,
    estimatedInsuredSalary,
    carBudget: Number(settings.carBudget || 0),
    carLoanMonths: CAR_LOAN_MONTHS,
    carLoanAnnualRate: CAR_LOAN_ANNUAL_RATE,
    carLoanMonthlyPayment: carLoanMonthlyPayment(settings.carBudget),
    partTimeIncomeGap: Math.max(0, requiredSemiIncome - ESTIMATED_PART_TIME_MONTHLY_INCOME),
    projectedInvestmentIncome,
    currentChildExpense,
    averageNet,
    availableMonthlyInvestment: Math.max(0, averageNet),
    reasonableMonthlyInvestment,
    configuredPlanFeasible,
    requiredMonthlySpendingReduction,
    suggestedRetirementAge,
    retirementScenarios,
    projected,
    gap: reasonableMonthlyInvestment - requiredMonthly,
    progress: target > 0 ? Math.max(0, Math.min(100, Math.max(0, assets) / target * 100)) : 100,
    yearsToRetire: Math.max(0, settings.retirementAge - settings.currentAge),
    semiRetirementYears: Math.max(0, settings.semiRetirementEndAge - settings.retirementAge)
  };
}
