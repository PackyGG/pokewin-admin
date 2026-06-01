// Re-export the shared component. The actual implementation lives in
// src/components/battle-password-reveal.tsx so other admin surfaces
// (transaction-detail modal, /transactions/[id]) can reuse it without
// importing across the (admin)/battles route boundary.
export { BattlePasswordReveal } from "@/components/battle-password-reveal";
