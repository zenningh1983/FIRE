const amount = (record, key) => Number(record[key]) || 0;

export function expenseBreakdown(record) {
  const fixed = record.fixedExpenses == null
    ? ['mortgage', 'utilities', 'internet', 'managementFee'].reduce((sum, key) => sum + amount(record, key), 0)
    : amount(record, 'fixedExpenses');
  const taxes = ['propertyLandTax', 'comprehensiveIncomeTax', 'otherTaxes'].reduce((sum, key) => sum + amount(record, key), 0);
  const insurance = record.personalInsuranceExpenses == null ? amount(record, 'insuranceExpenses') : amount(record, 'personalInsuranceExpenses');
  const child = (record.petExpenses == null ? amount(record, 'educationExpenses') : amount(record, 'petExpenses'))
    + amount(record, 'petInsuranceExpenses');
  const grossLiving = record.livingExpenses == null
    ? ['cathayCardExpenses', 'fubonCardExpenses', 'otherCardExpenses', 'cashExpenses', 'accountExpenses'].reduce((sum, key) => sum + amount(record, key), 0)
    : amount(record, 'livingExpenses');
  const living = record.expenseVersion === 2 ? grossLiving : Math.max(0, grossLiving - child);
  return { fixed, taxes, living, insurance, child, total: fixed + taxes + living + insurance + child };
}
