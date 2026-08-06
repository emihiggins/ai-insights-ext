/**
 * Rolls the recommendation findings into a savings view: how many tokens and
 * dollars are estimated recoverable, broken down by mistake category, plus the
 * most common mistakes by count. Pure logic — no vscode.
 */
import type { Finding } from "./rules/index";

export interface CategorySavings {
  category: string;
  /** Number of findings in this category. */
  count: number;
  wastedTokens: number;
  wastedUSD: number;
}

export interface SavingsReport {
  totalWastedTokens: number;
  totalWastedUSD: number;
  /** Fraction of estimated total spend that is estimated recoverable waste. */
  wasteFractionOfCost: number;
  /** Categories sorted by recoverable dollars, descending. */
  byCost: CategorySavings[];
  /** Categories sorted by finding count, descending ("most common mistakes"). */
  mostCommon: CategorySavings[];
}

export function computeSavings(findings: Finding[], totalCostUSD: number): SavingsReport {
  const byCategory = new Map<string, CategorySavings>();
  let totalWastedTokens = 0;
  let totalWastedUSD = 0;

  for (const f of findings) {
    let entry = byCategory.get(f.category);
    if (!entry) {
      entry = { category: f.category, count: 0, wastedTokens: 0, wastedUSD: 0 };
      byCategory.set(f.category, entry);
    }
    entry.count += 1;
    const tokens = f.wastedTokens ?? 0;
    const usd = f.wastedUSD ?? 0;
    entry.wastedTokens += tokens;
    entry.wastedUSD += usd;
    totalWastedTokens += tokens;
    totalWastedUSD += usd;
  }

  const entries = [...byCategory.values()];
  const byCost = [...entries].sort((a, b) => b.wastedUSD - a.wastedUSD || b.wastedTokens - a.wastedTokens);
  const mostCommon = [...entries].sort((a, b) => b.count - a.count || b.wastedUSD - a.wastedUSD);

  return {
    totalWastedTokens,
    totalWastedUSD,
    wasteFractionOfCost: totalCostUSD > 0 ? totalWastedUSD / totalCostUSD : 0,
    byCost,
    mostCommon,
  };
}
