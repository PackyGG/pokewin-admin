export const EXPENSE_CATEGORIES = [
  { value: "salaries", label: "Salaries" },
  { value: "creator_payments", label: "Creator Payments" },
  { value: "software", label: "Software" },
  { value: "subscriptions", label: "Subscriptions" },
  { value: "marketing", label: "Marketing" },
  { value: "legal", label: "Legal" },
  { value: "hosting", label: "Hosting" },
  { value: "other", label: "Other" },
] as const;

export const PAYMENT_METHODS = [
  { value: "bank_transfer", label: "Bank Transfer" },
  { value: "crypto", label: "Crypto" },
  { value: "credit_card", label: "Credit Card" },
  { value: "paypal", label: "PayPal" },
  { value: "cash", label: "Cash" },
  { value: "other", label: "Other" },
] as const;

export const CATEGORY_COLORS: Record<string, string> = {
  salaries: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300",
  creator_payments: "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300",
  software: "bg-cyan-100 text-cyan-800 dark:bg-cyan-900 dark:text-cyan-300",
  subscriptions: "bg-indigo-100 text-indigo-800 dark:bg-indigo-900 dark:text-indigo-300",
  marketing: "bg-pink-100 text-pink-800 dark:bg-pink-900 dark:text-pink-300",
  legal: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-300",
  hosting: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-300",
  other: "bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-300",
};

export const CATEGORY_CHART_COLORS: Record<string, string> = {
  salaries: "hsl(220, 70%, 55%)",
  creator_payments: "hsl(270, 60%, 55%)",
  software: "hsl(190, 70%, 45%)",
  subscriptions: "hsl(240, 60%, 55%)",
  marketing: "hsl(330, 65%, 55%)",
  legal: "hsl(40, 80%, 50%)",
  hosting: "hsl(140, 60%, 45%)",
  other: "hsl(0, 0%, 55%)",
};
