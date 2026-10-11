import { expenseBreakdown } from './cashflow.js';

function realMonthlyRate(nominalPercent, inflationPercent) {
  const annual = (nominalPercent - inflationPercent) / 100;
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
  if (Math.abs(rate) < 1e-10) return Math.round(principal / months);
  return Math.round(principal * rate / ((1 + rate) * (1 - Math.pow(1 + rate, -months))));
}

function findMinimum(feasible) {
  if (feasible(0)) return 0;
  let low = 0;
  let high = 1000;
  while (high < 1_000_000_000 && !feasible(high)) high *= 2;
  if (!feasible(high)) return Number.POSITIVE_INFINITY;
  for (let iteration = 0; iteration < 60; iteration += 1) {
    const middle = (low + high) / 2;
    if (feasible(middle)) high = middle;
    else low = middle;
  }
  return high;
}

const ESTIMATED_PART_TIME_MONTHLY_INCOME = 0;
const PART_TIME_HOURLY_RATE = 196;
const PART_TIME_DAYS_PER_MONTH = 22;
const PART_TIME_HOURS_PER_DAY = 4;
const PART_TIME_MONTHLY_CAP = PART_TIME_HOURLY_RATE * PART_TIME_DAYS_PER_MONTH * PART_TIME_HOURS_PER_DAY;
const CAR_LOAN_MONTHS = 60;
const CAR_LOAN_ANNUAL_RATE = 0.12;
// 勞保局月退休金試算表的 2026 年平均餘命（60 至 85 歲）：https://www.bli.gov.tw/0104047.html
const LABOR_PENSION_REMAINING_YEARS_2026 = [23, 23, 22, 21, 20, 19, 19, 18, 17, 16, 16, 15, 14, 13, 13, 12, 11, 11, 10, 9, 9, 8, 8, 7, 6, 6];
const LABOR_PENSION_ANNUITY_ANNUAL_RATE = 0.011473;
const HEALTH_INSURANCE_MONTHLY_2026 = 826;
const NATIONAL_PENSION_MONTHLY_2026 = 1329;
const NATIONAL_PENSION_INSURED_AMOUNT_2026 = 21103;

function carLoanMonthlyPayment(principal) {
  const amount = Math.max(0, Number(principal || 0));
  if (!amount) return 0;
  const monthlyRate = CAR_LOAN_ANNUAL_RATE / 12;
  return amount * monthlyRate / (1 - Math.pow(1 + monthlyRate, -CAR_LOAN_MONTHS));
}

function laborPensionPaymentMonths(accessAge) {
  const ageIndex = Math.min(LABOR_PENSION_REMAINING_YEARS_2026.length - 1, Math.max(0, Math.floor(accessAge) - 60));
  return LABOR_PENSION_REMAINING_YEARS_2026[ageIndex] * 12;
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

function mortgageTerms(mortgage = {}) {
  return {
    rate: Math.max(0, Number(mortgage.interestRate || 0)) / 1200,
    payment: Math.max(0, Number(mortgage.monthlyPayment || 0) || Number(mortgage.monthlyPrincipalPaid || 0) + Number(mortgage.monthlyInterestPaid || 0))
  };
}

export function projectMortgageBalance(mortgage = {}, months = 0) {
  let balance = Math.max(0, Number(mortgage.remainingPrincipal || 0));
  const { rate, payment } = mortgageTerms(mortgage);
  for (let month = 0; month < months && balance > 0; month += 1) {
    balance = Math.max(0, balance * (1 + rate) - payment);
  }
  return balance;
}

function projectFinancialToRetirement(cashBalance, holdingsValue, monthlySaving, monthlyNet, recordedMortgagePayment, mortgage,
  annualGrowthRate, months, averageMonthlyDividends, trace = null, reserveTarget = 0) {
  let cash = cashBalance;
  const years = months / 12;
  const openingHoldingsGrowth = holdingsValue * (1 + annualGrowthRate * years);
  const dividendTotal = averageMonthlyDividends * months;
  const reinvestedDividendGrowth = averageMonthlyDividends * 12 * annualGrowthRate * years;
  let investmentGrowth = 0;
  let investmentTotal = 0;
  let mortgageCashAdjustment = 0;
  let mortgageBalance = Math.max(0, Number(mortgage?.remainingPrincipal || 0));
  const mortgageSchedule = mortgageTerms(mortgage);
  for (let month = 0; month < months; month += 1) {
    const mortgageDue = mortgageBalance > 0 ? Math.min(mortgageSchedule.payment, mortgageBalance * (1 + mortgageSchedule.rate)) : 0;
    mortgageBalance = Math.max(0, mortgageBalance * (1 + mortgageSchedule.rate) - mortgageDue);
    const mortgageAdjustment = recordedMortgagePayment - mortgageDue;
    const actualMonthlyNet = monthlyNet - averageMonthlyDividends;
    const invested = Math.min(monthlySaving, Math.max(0, cash + actualMonthlyNet + mortgageAdjustment - reserveTarget));
    cash += actualMonthlyNet + mortgageAdjustment - invested;
    mortgageCashAdjustment += mortgageAdjustment;
    investmentGrowth += invested * (1 + annualGrowthRate * (months - month - 1) / 12);
    investmentTotal += invested;
  }
  const holdings = openingHoldingsGrowth + dividendTotal + reinvestedDividendGrowth + investmentGrowth;
  if (trace) Object.assign(trace, {
    openingCash: cashBalance,
    nonDividendNetTotal: (monthlyNet - averageMonthlyDividends) * months,
    dividendTotal,
    reinvestedDividendGrowth,
    investmentTotal,
    mortgageCashAdjustment,
    openingHoldingsGrowth,
    investmentGrowth
  });
  return { cash, holdings, liquid: cash + holdings };
}

function retirementIsFunded({ settings, mortgage, postRate, monthsToRetirement, currentChildExpense, liquidAtStart, pensionAtStart, semiRetirementIncome, trace }) {
  const retirementMonths = Math.max(0, Math.round((settings.lifeExpectancy - settings.retirementAge) * 12));
  const semiRetirementMonths = Math.max(0, Math.round((settings.semiRetirementEndAge - settings.retirementAge) * 12));
  const pensionAccessMonth = Math.round((settings.laborPensionAccessAge - settings.retirementAge) * 12);
  const laborPensionMonthlyPaymentMonths = laborPensionPaymentMonths(Math.max(settings.retirementAge, settings.laborPensionAccessAge));
  const benefitStartMonth = Math.round((settings.laborInsuranceBenefitAge - settings.retirementAge) * 12);
  const reserveFloor = Number(settings.parentMedicalReserve || 0)
    + Number(settings.personalMedicalReserve || 0)
    + Number(settings.childrenMilestoneReserve || 0)
    + Number(settings.emergencyCashReserve || 0);
  const presentValues = trace ? {
    living: 0, travel: 0, healthInsurance: 0, nationalPensionPremium: 0, child: 0, youngAdultChild: 0, mortgage: 0, car: 0,
    partTimeIncome: 0, laborInsurance: 0, nationalPensionBenefit: 0, laborPension: 0
  } : null;
  const paymentCounts = trace ? Object.fromEntries(Object.keys(presentValues).map((key) => [key, 0])) : null;
  let presentValueNeed = 0;
  let highestNeed = Number.NEGATIVE_INFINITY;
  let liquid = liquidAtStart;
  let mortgageBalance = projectMortgageBalance(mortgage, monthsToRetirement);
  const mortgageSchedule = mortgageTerms(mortgage);
  let pension = pensionAtStart;
  let pensionUnlocked = pensionAccessMonth <= 0;
  let laborPensionMonthlyIncome = 0;
  let laborPensionPaymentsRemaining = 0;
  const unlockPension = (month) => {
    if (settings.laborPensionPayoutMode === 'monthly') {
      const annuityMonthlyRate = Math.pow(1 + LABOR_PENSION_ANNUITY_ANNUAL_RATE, 1 / 12) - 1;
      laborPensionMonthlyIncome = annuityPayment(pension, annuityMonthlyRate, laborPensionMonthlyPaymentMonths);
      laborPensionPaymentsRemaining = Math.min(laborPensionMonthlyPaymentMonths, Math.max(0, retirementMonths - month));
      if (trace) trace.laborPensionMonthlyPayment = laborPensionMonthlyIncome;
    } else {
      liquid += pension;
      if (trace) {
        const discount = Math.pow(1 + postRate, -month);
        presentValues.laborPension += pension * discount;
        if (pension) paymentCounts.laborPension += 1;
        presentValueNeed -= pension * discount;
      }
    }
    pension = 0;
  };
  if (pensionUnlocked) unlockPension(0);
  let laborInsuranceLumpPaid = false;

  for (let month = 0; month < retirementMonths; month += 1) {
    const mortgageDue = mortgageBalance > 0 ? Math.min(mortgageSchedule.payment, mortgageBalance * (1 + mortgageSchedule.rate)) : 0;
    mortgageBalance = Math.max(0, mortgageBalance * (1 + mortgageSchedule.rate) - mortgageDue);
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
    const partTimeIncome = isSemiRetired ? semiRetirementIncome : 0;
    const laborPensionIncome = laborPensionPaymentsRemaining > 0 ? laborPensionMonthlyIncome : 0;
    const nationalPensionIncome = month >= benefitStartMonth ? Number(settings.nationalPensionMonthlyBenefit || 0) : 0;
    const income = partTimeIncome
      + laborPensionIncome
      + laborInsuranceIncome
      + nationalPensionIncome;
    if (laborPensionPaymentsRemaining > 0) laborPensionPaymentsRemaining -= 1;
    const living = Number(settings.retirementMonthlySpend || 0);
    const travel = Number(settings.annualTravelTrips || 0) * 150000 / 12;
    const healthInsurance = Number(settings.healthInsuranceMonthly || 0);
    const nationalPensionPremium = month < benefitStartMonth ? Number(settings.nationalPensionMonthlyPremium || 0) : 0;
    const child = childSupportForMonth(settings, currentChildExpense, monthsToRetirement + month);
    const youngAdultChild = youngAdultSupportForMonth(settings, monthsToRetirement + month);
    const car = month < CAR_LOAN_MONTHS ? carLoanMonthlyPayment(settings.carBudget) : 0;
    const expenses = living + travel + healthInsurance + nationalPensionPremium + child + youngAdultChild + mortgageDue + car;
    if (trace) {
      const discount = Math.pow(1 + postRate, -(month + 1));
      const monthlyValues = { living, travel, healthInsurance, nationalPensionPremium, child, youngAdultChild, mortgage: mortgageDue, car,
        partTimeIncome, laborInsurance: laborInsuranceIncome, nationalPensionBenefit: nationalPensionIncome,
        laborPension: laborPensionIncome };
      Object.entries(monthlyValues).forEach(([key, value]) => {
        presentValues[key] += value * discount;
        if (value) paymentCounts[key] += 1;
      });
      presentValueNeed += (expenses - income) * discount;
      if (presentValueNeed > highestNeed) {
        highestNeed = presentValueNeed;
        trace.presentValues = { ...presentValues };
        trace.paymentCounts = { ...paymentCounts };
        trace.limitingMonth = month + 1;
      }
      trace.reserveFloor = reserveFloor;
      trace.retirementMonths = retirementMonths;
    }
    liquid += income - expenses;
    if (liquid < reserveFloor - 0.01) return false;
  }
  return liquid >= reserveFloor - 0.01;
}

// Retirement spending may use dividends and cash, but never proceeds from selling holdings.
function retirementWithoutSelling({ settings, mortgage, postRate, priceRate, dividendYield, monthsToRetirement,
  currentChildExpense, cashAtStart, holdingsAtStart, pensionAtStart, semiRetirementIncome = 0, trace = null,
  allowShortfall = false }) {
  const retirementMonths = Math.max(0, Math.round((settings.lifeExpectancy - settings.retirementAge) * 12));
  const semiRetirementMonths = Math.max(0, Math.round((settings.semiRetirementEndAge - settings.retirementAge) * 12));
  const pensionAccessMonth = Math.round((settings.laborPensionAccessAge - settings.retirementAge) * 12);
  const benefitStartMonth = Math.round((settings.laborInsuranceBenefitAge - settings.retirementAge) * 12);
  const reserveFloor = Number(settings.parentMedicalReserve || 0) + Number(settings.personalMedicalReserve || 0)
    + Number(settings.childrenMilestoneReserve || 0) + Number(settings.emergencyCashReserve || 0);
  if (cashAtStart < reserveFloor - 0.01 && !allowShortfall) return false;
  let cash = reserveFloor;
  let holdings = Math.max(0, holdingsAtStart) + Math.max(0, cashAtStart - reserveFloor);
  let mortgageBalance = projectMortgageBalance(mortgage, monthsToRetirement);
  const mortgageSchedule = mortgageTerms(mortgage);
  let pension = pensionAtStart;
  let pensionMonthly = 0;
  let pensionPaymentsRemaining = 0;
  let pensionUnlocked = false;
  let laborInsuranceLumpPaid = false;
  const unlockPension = (month) => {
    pensionUnlocked = true;
    if (settings.laborPensionPayoutMode === 'monthly') {
      const annuityRate = Math.pow(1 + LABOR_PENSION_ANNUITY_ANNUAL_RATE, 1 / 12) - 1;
      pensionPaymentsRemaining = laborPensionPaymentMonths(Math.max(settings.retirementAge, settings.laborPensionAccessAge));
      pensionMonthly = annuityPayment(pension, annuityRate, pensionPaymentsRemaining);
    } else cash += pension;
    pension = 0;
  };
  if (pensionAccessMonth <= 0) unlockPension(0);
  if (trace) Object.assign(trace, { reserveFloor, openingHoldings: holdings, firstMonthDividend: 0,
    totalDividends: 0, totalReinvested: 0, endingHoldings: holdings, limitingMonth: 0,
    totalRecurringIncome: 0, totalExpenses: 0, totalMonthlyShortfall: 0, retirementMonths });
  for (let month = 0; month < retirementMonths; month += 1) {
    if (!pensionUnlocked && month >= pensionAccessMonth) unlockPension(month);
    if (!pensionUnlocked) pension *= 1 + postRate;
    const holdingsBefore = holdings;
    holdings *= 1 + priceRate;
    const dividend = holdings * dividendYield / 12;
    const mortgageDue = mortgageBalance > 0 ? Math.min(mortgageSchedule.payment, mortgageBalance * (1 + mortgageSchedule.rate)) : 0;
    mortgageBalance = Math.max(0, mortgageBalance * (1 + mortgageSchedule.rate) - mortgageDue);
    let laborInsuranceIncome = 0;
    if (month >= benefitStartMonth) {
      if (settings.laborInsurancePayoutMode === 'lump') {
        if (!laborInsuranceLumpPaid) {
          laborInsuranceIncome = Number(settings.laborInsuranceLumpSumBenefit || 0);
          laborInsuranceLumpPaid = true;
        }
      } else laborInsuranceIncome = Number(settings.laborInsuranceMonthlyBenefit || 0);
    }
    const nationalPensionIncome = month >= benefitStartMonth ? Number(settings.nationalPensionMonthlyBenefit || 0) : 0;
    const laborPensionIncome = pensionPaymentsRemaining > 0 ? pensionMonthly : 0;
    if (pensionPaymentsRemaining > 0) pensionPaymentsRemaining -= 1;
    const partTimeIncome = month < semiRetirementMonths ? semiRetirementIncome : 0;
    const expenses = Number(settings.retirementMonthlySpend || 0)
      + Number(settings.annualTravelTrips || 0) * 150000 / 12
      + Number(settings.healthInsuranceMonthly || 0)
      + (month < benefitStartMonth ? Number(settings.nationalPensionMonthlyPremium || 0) : 0)
      + childSupportForMonth(settings, currentChildExpense, monthsToRetirement + month)
      + youngAdultSupportForMonth(settings, monthsToRetirement + month)
      + (month < CAR_LOAN_MONTHS ? carLoanMonthlyPayment(settings.carBudget) : 0)
      + mortgageDue;
    if (trace && month === 0) {
      const recurringLaborInsurance = settings.laborInsurancePayoutMode === 'monthly' ? laborInsuranceIncome : 0;
      const income = dividend + laborPensionIncome + recurringLaborInsurance + nationalPensionIncome + partTimeIncome;
      trace.firstMonthCashflow = {
        age: settings.retirementAge, dividend, laborPensionIncome,
        laborInsuranceIncome: recurringLaborInsurance, nationalPensionIncome, partTimeIncome,
        income, expenses, balance: income - expenses
      };
    }
    if (trace) {
      const recurringIncome = dividend + laborPensionIncome
        + (settings.laborInsurancePayoutMode === 'monthly' ? laborInsuranceIncome : 0)
        + nationalPensionIncome + partTimeIncome;
      trace.totalRecurringIncome += recurringIncome;
      trace.totalExpenses += expenses;
      trace.totalMonthlyShortfall += Math.max(0, expenses - recurringIncome);
    }
    cash += dividend + laborPensionIncome + laborInsuranceIncome + nationalPensionIncome + partTimeIncome - expenses;
    if (cash < reserveFloor - 0.01) {
      if (trace) trace.limitingMonth = month + 1;
      if (!allowShortfall) return false;
      cash = reserveFloor;
    }
    const reinvested = allowShortfall ? 0 : Math.max(0, cash - reserveFloor);
    holdings += reinvested;
    cash -= reinvested;
    if (trace) {
      if (month === 0) trace.firstMonthDividend = dividend;
      trace.totalDividends += dividend;
      trace.totalReinvested += reinvested;
      trace.endingHoldings = holdings;
    }
    // Keep the portfolio's purchasing power while the excess cash compounds.
    if (holdings < holdingsBefore - 0.01 && !allowShortfall) {
      if (trace) trace.limitingMonth = month + 1;
      return false;
    }
  }
  return true;
}

export function calculatePlan(state) {
  const recordedCashflows = state.cashflows || [];
  const averageCashflowValue = (field) => recordedCashflows.length
    ? recordedCashflows.reduce((sum, item) => sum + Number(item[field] || 0), 0) / recordedCashflows.length : 0;
  const currentAge = Number(state.settings.currentAge || 0);
  const pensionTenureYears = Number(state.assetSummary?.laborPension?.tenureYears || 0)
    + Number(state.assetSummary?.laborPension?.tenureMonths || 0) / 12;
  const estimatedInsuredSalary = Math.min(45_800, averageCashflowValue('baseSalary'));
  const insuranceBenefitsAtAge = (retirementAge) => {
    const insuredYears = pensionTenureYears + Math.max(0, retirementAge - currentAge);
    const laborInsuranceMonthlyBenefit = estimatedInsuredSalary > 0 && insuredYears > 0 ? Math.max(
      estimatedInsuredSalary * insuredYears * 0.00775 + 3000,
      estimatedInsuredSalary * insuredYears * 0.0155
    ) : 0;
    const laborInsuranceBenefitMonths = Math.min(45, Math.min(15, insuredYears) + Math.max(0, insuredYears - 15) * 2);
    const laborInsuranceLumpSumBenefit = estimatedInsuredSalary * laborInsuranceBenefitMonths;
    const nationalPensionYears = Math.max(0, 65 - Math.max(currentAge, retirementAge));
    const nationalPensionB = NATIONAL_PENSION_INSURED_AMOUNT_2026 * nationalPensionYears * 0.013;
    const nationalPensionA = NATIONAL_PENSION_INSURED_AMOUNT_2026 * nationalPensionYears * 0.0065 + 4049;
    const nationalPensionFormulaMode = laborInsuranceMonthlyBenefit > 0 || nationalPensionB >= nationalPensionA ? 'B' : 'A';
    return {
      insuredYears,
      laborInsuranceMonthlyBenefit,
      laborInsuranceBenefitMonths,
      laborInsuranceLumpSumBenefit,
      nationalPensionYears,
      nationalPensionFormulaMode,
      nationalPensionMonthlyBenefit: nationalPensionYears > 0
        ? Math.round(nationalPensionFormulaMode === 'B' ? nationalPensionB : nationalPensionA) : 0
    };
  };
  const insuranceBenefits = insuranceBenefitsAtAge(Number(state.settings.retirementAge || 0));
  const { insuredYears, laborInsuranceMonthlyBenefit, laborInsuranceBenefitMonths,
    laborInsuranceLumpSumBenefit, nationalPensionYears, nationalPensionFormulaMode,
    nationalPensionMonthlyBenefit } = insuranceBenefits;
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
    nationalPensionMonthlyBenefit,
    nationalPensionMonthlyPremium: NATIONAL_PENSION_MONTHLY_2026,
    healthInsuranceMonthly: HEALTH_INSURANCE_MONTHLY_2026,
    childSupportUntilAge: 20
  };
  const cashBalance = Number(state.assetSummary?.totalBalance || 0);
  const holdingsValue = Number(state.assetSummary?.holdingsValue || 0);
  const laborPension = Number(state.assetSummary?.laborPension?.total || 0);
  const mortgage = Number(state.mortgage?.remainingPrincipal || 0);
  const assets = cashBalance + holdingsValue + laborPension - mortgage;
  const emergencyCashReserve = Number(settings.emergencyCashReserve || 0);
  const monthsToRetire = Math.max(0, Math.round((settings.retirementAge - settings.currentAge) * 12));
  const averageMonthlyDividends = recordedCashflows.length ? recordedCashflows.reduce((sum, item) => {
    const dividend = item.cathayDividends == null && item.yuantaDividends == null
      ? Number(item.dividends || 0) : Number(item.cathayDividends || 0) + Number(item.yuantaDividends || 0);
    return sum + dividend;
  }, 0) / recordedCashflows.length : 0;
  const estimatedAnnualDividends = Math.max(0, averageMonthlyDividends * 12);
  const preRate = realMonthlyRate(settings.preReturn, settings.inflation);
  const preAnnualGrowthRate = (settings.preReturn - settings.inflation) / 100;
  const postRate = realMonthlyRate(settings.postReturn, settings.inflation);
  const postPriceRate = postRate;
  const averageMonthlyExpense = recordedCashflows.length
    ? recordedCashflows.reduce((sum, item) => sum + expenseBreakdown(item).total, 0) / recordedCashflows.length : 0;
  const averageNet = recordedCashflows.length
    ? recordedCashflows.reduce((sum, item) => sum + Number(item.totalIncome || item.income || 0), 0) / recordedCashflows.length
      - averageMonthlyExpense : 0;
  const recordedMortgagePayment = averageCashflowValue('mortgage');
  const reasonableMonthlyInvestment = 0;
  const pensionAtRetirement = futureValue(laborPension, 0, preRate, monthsToRetire);
  const mortgageAtRetirement = projectMortgageBalance(state.mortgage, monthsToRetire);
  const projectedFinancialBreakdown = {};
  const projectedFinancial = projectFinancialToRetirement(cashBalance, holdingsValue, reasonableMonthlyInvestment, averageNet,
    recordedMortgagePayment, state.mortgage, preAnnualGrowthRate, monthsToRetire, averageMonthlyDividends,
    projectedFinancialBreakdown);
  const dividendYieldFor = (financial) => financial.holdings > 0
    ? estimatedAnnualDividends / financial.holdings : 0;
  const dividendYield = dividendYieldFor(projectedFinancial);
  const projectedLiquid = projectedFinancial.liquid;
  const projected = projectedLiquid + pensionAtRetirement - mortgageAtRetirement;
  const pensionAccessOffset = Math.max(0, Math.round((settings.laborPensionAccessAge - settings.retirementAge) * 12));
  const pensionAtAccess = pensionAtRetirement * Math.pow(1 + postRate, pensionAccessOffset);
  const laborPensionAnnuityMonthlyRate = Math.pow(1 + LABOR_PENSION_ANNUITY_ANNUAL_RATE, 1 / 12) - 1;
  const laborPensionMonthlyPaymentMonths = laborPensionPaymentMonths(Math.max(settings.retirementAge, settings.laborPensionAccessAge));
  const estimatedLaborPensionMonthlyBenefit = annuityPayment(pensionAtAccess, laborPensionAnnuityMonthlyRate, laborPensionMonthlyPaymentMonths);
  const reserveFloor = emergencyCashReserve + Number(settings.parentMedicalReserve || 0)
    + Number(settings.personalMedicalReserve || 0) + Number(settings.childrenMilestoneReserve || 0);
  const estimatedRetirementMonthlyDividend = Math.max(0,
    projectedFinancial.holdings + Math.max(0, projectedFinancial.cash - reserveFloor))
    * (1 + postPriceRate) * dividendYield / 12;
  const funded = (financialAtStart, semiRetirementIncome = 0, planSettings = settings, months = monthsToRetire,
    pensionAtStart = pensionAtRetirement, retirementDividendYield = dividendYield) => retirementWithoutSelling({
    settings: planSettings,
    mortgage: state.mortgage,
    postRate,
    priceRate: postPriceRate,
    dividendYield: retirementDividendYield,
    monthsToRetirement: months,
    currentChildExpense,
    cashAtStart: financialAtStart.cash,
    holdingsAtStart: financialAtStart.holdings,
    pensionAtStart,
    semiRetirementIncome
  });
  const requiredHoldings = findMinimum((holdingsAtStart) => retirementWithoutSelling({
    settings,
    mortgage: state.mortgage,
    postRate,
    priceRate: postPriceRate,
    dividendYield,
    monthsToRetirement: monthsToRetire,
    currentChildExpense,
    cashAtStart: reserveFloor,
    holdingsAtStart,
    pensionAtStart: pensionAtRetirement,
    semiRetirementIncome: 0
  }));
  const requiredPortfolio = reserveFloor + requiredHoldings;
  const requiredLiquidTarget = requiredHoldings;
  const targetCashflowBreakdown = {};
  retirementIsFunded({
    settings,
    mortgage: state.mortgage,
    postRate,
    monthsToRetirement: monthsToRetire,
    currentChildExpense,
    liquidAtStart: 1_000_000_000_000,
    pensionAtStart: pensionAtRetirement,
    semiRetirementIncome: 0,
    trace: targetCashflowBreakdown
  });
  const target = requiredPortfolio;
  const requiredMonthly = monthsToRetire > 0
    ? findMinimum((monthlySaving) => funded(
      projectFinancialToRetirement(cashBalance, holdingsValue, monthlySaving, averageNet + monthlySaving,
        recordedMortgagePayment, state.mortgage, preAnnualGrowthRate, monthsToRetire, averageMonthlyDividends,
        null, reserveFloor),
      ESTIMATED_PART_TIME_MONTHLY_INCOME
    )) : (funded(projectedFinancial, 0) ? 0 : Number.POSITIVE_INFINITY);
  const semiRetirementMonths = Math.max(0, Math.round((settings.semiRetirementEndAge - settings.retirementAge) * 12));
  const cappedPartTimeIncome = semiRetirementMonths > 0 ? PART_TIME_MONTHLY_CAP : 0;
  const requiredMonthlyWithPartTime = monthsToRetire > 0
    ? findMinimum((monthlySaving) => funded(
      projectFinancialToRetirement(cashBalance, holdingsValue, monthlySaving, averageNet + monthlySaving,
        recordedMortgagePayment, state.mortgage, preAnnualGrowthRate, monthsToRetire, averageMonthlyDividends,
        null, reserveFloor), cappedPartTimeIncome
    )) : (funded(projectedFinancial, cappedPartTimeIncome) ? 0 : Number.POSITIVE_INFINITY);
  const retirementProjectionWithSaving = (amount) => Number.isFinite(amount)
    ? projectFinancialToRetirement(cashBalance, holdingsValue, Math.ceil(Math.max(0, amount)),
      averageNet + Math.ceil(Math.max(0, amount)), recordedMortgagePayment, state.mortgage,
      preAnnualGrowthRate, monthsToRetire, averageMonthlyDividends, null, reserveFloor)
    : null;
  const noWorkProjection = retirementProjectionWithSaving(requiredMonthly);
  const partTimeProjection = retirementProjectionWithSaving(requiredMonthlyWithPartTime);
  const requiredPartTimeIncomeWithInvestment = partTimeProjection && semiRetirementMonths > 0
    ? Math.min(cappedPartTimeIncome, findMinimum((monthlyIncome) => funded(partTimeProjection, monthlyIncome))) : 0;
  const retirementDividendFor = (financial) => financial
    ? (financial.holdings + Math.max(0, financial.cash - reserveFloor)) * (1 + postPriceRate) * dividendYield / 12
    : null;
  const firstMonthCashflowFor = (financial, planSettings = settings, months = monthsToRetire,
    pensionAtStart = pensionAtRetirement, retirementDividendYield = dividendYield,
    semiRetirementIncome = 0, allowShortfall = false) => {
    if (!financial) return null;
    const trace = {};
    retirementWithoutSelling({
      settings: planSettings, mortgage: state.mortgage, postRate, priceRate: postPriceRate,
      dividendYield: retirementDividendYield, monthsToRetirement: months, currentChildExpense,
      cashAtStart: financial.cash, holdingsAtStart: financial.holdings, pensionAtStart,
      semiRetirementIncome, trace, allowShortfall
    });
    return trace.firstMonthCashflow || null;
  };
  const averageMonthlyCashflowFor = (financial, planSettings = settings, months = monthsToRetire,
    pensionAtStart = pensionAtRetirement, retirementDividendYield = dividendYield,
    semiRetirementIncome = 0, allowShortfall = false) => {
    if (!financial) return null;
    const trace = {};
    retirementWithoutSelling({
      settings: planSettings, mortgage: state.mortgage, postRate, priceRate: postPriceRate,
      dividendYield: retirementDividendYield, monthsToRetirement: months, currentChildExpense,
      cashAtStart: financial.cash, holdingsAtStart: financial.holdings, pensionAtStart,
      semiRetirementIncome, trace, allowShortfall
    });
    if (!trace.retirementMonths) return null;
    const income = trace.totalRecurringIncome / trace.retirementMonths;
    const expenses = trace.totalExpenses / trace.retirementMonths;
    return { age: planSettings.retirementAge, months: trace.retirementMonths,
      income, expenses, balance: income - expenses,
      shortfall: trace.totalMonthlyShortfall / trace.retirementMonths };
  };
  let suggestedRetirementAge = null;
  let suggestedRetirementCashflow = null;
  let suggestedAverageCashflow = null;
  const firstCandidateAge = Math.ceil(settings.currentAge) + 1;
  const lastCandidateAge = Math.floor(settings.lifeExpectancy) - 1;
  for (let age = firstCandidateAge; age <= lastCandidateAge; age += 1) {
    const candidateSettings = { ...settings, ...insuranceBenefitsAtAge(age), retirementAge: age,
      semiRetirementEndAge: Math.max(age, 65) };
    const candidateMonths = Math.max(0, Math.round((age - settings.currentAge) * 12));
    const candidatePension = futureValue(laborPension, 0, preRate, candidateMonths);
    const candidateFinancial = projectFinancialToRetirement(cashBalance, holdingsValue, 0, averageNet,
      recordedMortgagePayment, state.mortgage, preAnnualGrowthRate, candidateMonths, averageMonthlyDividends);
    const isFundedAtAge = funded(candidateFinancial, ESTIMATED_PART_TIME_MONTHLY_INCOME,
      candidateSettings, candidateMonths, candidatePension, dividendYieldFor(candidateFinancial));
    if (isFundedAtAge) {
      suggestedRetirementAge = age;
      suggestedRetirementCashflow = firstMonthCashflowFor(candidateFinancial, candidateSettings,
        candidateMonths, candidatePension, dividendYieldFor(candidateFinancial));
      suggestedAverageCashflow = averageMonthlyCashflowFor(candidateFinancial, candidateSettings,
        candidateMonths, candidatePension, dividendYieldFor(candidateFinancial));
      break;
    }
  }
  return {
    assets,
    target,
    requiredLiquidTarget,
    requiredHoldings,
    requiredPortfolio,
    dividendYield,
    averageMonthlyDividends,
    dividendObservationMonths: recordedCashflows.length,
    estimatedRetirementMonthlyDividend,
    postPriceRate,
    targetCashflowBreakdown,
    preRate,
    postRate,
    mortgageAtRetirement,
    mortgageMonthlyPayment: mortgageTerms(state.mortgage).payment,
    projectedCash: projectedFinancial.cash,
    projectedHoldings: projectedFinancial.holdings,
    projectedFinancialBreakdown,
    projectedPension: pensionAtRetirement,
    requiredMonthly,
    requiredMonthlyWithPartTime,
    requiredPartTimeIncomeWithInvestment,
    partTimeHourlyRate: PART_TIME_HOURLY_RATE,
    partTimeDaysPerMonth: PART_TIME_DAYS_PER_MONTH,
    partTimeHoursPerDay: PART_TIME_HOURS_PER_DAY,
    partTimeMonthlyCap: cappedPartTimeIncome,
    noWorkRetirementDividend: retirementDividendFor(noWorkProjection),
    partTimeRetirementDividend: retirementDividendFor(partTimeProjection),
    noWorkRetirementCashflow: firstMonthCashflowFor(noWorkProjection),
    baselineFirstMonthCashflow: firstMonthCashflowFor(projectedFinancial, settings, monthsToRetire,
      pensionAtRetirement, dividendYield, 0, true),
    baselineAverageCashflow: averageMonthlyCashflowFor(projectedFinancial, settings, monthsToRetire,
      pensionAtRetirement, dividendYield, 0, true),
    noWorkAverageCashflow: averageMonthlyCashflowFor(noWorkProjection),
    partTimeRetirementCashflow: firstMonthCashflowFor(partTimeProjection, settings, monthsToRetire,
      pensionAtRetirement, dividendYield, requiredPartTimeIncomeWithInvestment),
    partTimeAverageCashflow: averageMonthlyCashflowFor(partTimeProjection, settings, monthsToRetire,
      pensionAtRetirement, dividendYield, requiredPartTimeIncomeWithInvestment),
    suggestedRetirementCashflow,
    suggestedAverageCashflow,
    noWorkProjectedHoldings: noWorkProjection?.holdings ?? null,
    partTimeProjectedHoldings: partTimeProjection?.holdings ?? null,
    laborPensionPayoutMode: settings.laborPensionPayoutMode,
    laborPensionEstimatedLumpSum: pensionAtAccess,
    laborPensionEstimatedMonthlyBenefit: estimatedLaborPensionMonthlyBenefit,
    laborPensionMonthlyPaymentMonths,
    laborPensionAnnuityAnnualRate: LABOR_PENSION_ANNUITY_ANNUAL_RATE,
    laborInsurancePayoutMode: settings.laborInsurancePayoutMode,
    laborInsuranceMonthlyBenefit,
    laborInsuranceLumpSumBenefit,
    insuredYears,
    nationalPensionYears,
    nationalPensionFormulaMode,
    nationalPensionMonthlyBenefit,
    nationalPensionMonthlyPremium: Number(settings.retirementAge) < 65 ? NATIONAL_PENSION_MONTHLY_2026 : 0,
    nationalPensionInsuredAmount: NATIONAL_PENSION_INSURED_AMOUNT_2026,
    healthInsuranceMonthly: HEALTH_INSURANCE_MONTHLY_2026,
    laborInsuranceBenefitMonths,
    estimatedInsuredSalary,
    carBudget: Number(settings.carBudget || 0),
    carLoanMonths: CAR_LOAN_MONTHS,
    carLoanAnnualRate: CAR_LOAN_ANNUAL_RATE,
    carLoanMonthlyPayment: carLoanMonthlyPayment(settings.carBudget),
    currentChildExpense,
    averageNet,
    averageMonthlyExpense,
    cashflowObservationMonths: recordedCashflows.length,
    availableMonthlyInvestment: Math.max(0, averageNet),
    reasonableMonthlyInvestment,
    suggestedRetirementAge,
    projected,
    yearsToRetire: Math.max(0, settings.retirementAge - settings.currentAge),
    semiRetirementYears: Math.max(0, settings.semiRetirementEndAge - settings.retirementAge)
  };
}
