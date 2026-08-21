export const EXPENSE_CATEGORIES = [
  { value: "software", label: "Software" },
  { value: "subscriptions", label: "Subscriptions" },
  { value: "marketing", label: "Marketing" },
  { value: "creator_payments", label: "Creator payments" },
  { value: "contractors", label: "Contractors" },
  { value: "legal", label: "Legal & compliance" },
  { value: "hosting", label: "Infrastructure" },
  { value: "operations", label: "Operations" },
  { value: "travel", label: "Travel" },
  { value: "other", label: "Other" },
] as const;

export const PAYMENT_METHODS = [
  { value: "bank_transfer", label: "Bank transfer" },
  { value: "crypto", label: "Crypto" },
  { value: "credit_card", label: "Card" },
  { value: "paypal", label: "PayPal" },
  { value: "cash", label: "Cash" },
  { value: "other", label: "Other" },
] as const;

export function paymentMethodLabel(value: string): string {
  return (
    PAYMENT_METHODS.find((method) => method.value === value)?.label ?? value
  );
}

export function expenseCategoryLabel(value: string): string {
  return (
    EXPENSE_CATEGORIES.find((category) => category.value === value)?.label ??
    value
  );
}
