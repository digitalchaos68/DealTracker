// ============================================================================
// CORE TYPES
// ============================================================================
// Everything else in the app hangs off these two shapes. Keep them the
// single source of truth — if you add a field, add it here first.

export type DealStage =
  | "prospecting"
  | "offer_accepted"
  | "option_exercised"
  | "completed"
  | "paid";

export interface CoBrokePartner {
  name: string;
  ceaRegNumber: string;
  splitPercent: number; // 0-100, this partner's share of the co-broke pool
}

export interface Deal {
  id: string;
  propertyAddress: string;
  dealValue: number;        // transaction price, e.g. property sale price
  commissionPercent: number; // total commission rate agreed, e.g. 1 (%) or 2 (%)
  agentSplitPercent: number; // your cut of the commission pool, before agency cut
  agencySplitPercent: number; // your agency's cut (e.g. 80/20 with agency)
  coBrokePartner?: CoBrokePartner; // undefined if this is a solo deal
  stage: DealStage;
  stageHistory: { stage: DealStage; date: string }[];
  expectedPayoutDate?: string; // ISO date, set when stage moves to option_exercised
  createdAt: string;
}

// ============================================================================
// 1. COMMISSION SPLIT CALCULATION
// ============================================================================
// This is the money-critical function. Order of operations matters:
//   1. Total commission = dealValue x commissionPercent
//   2. If there's a co-broke partner, split the total commission pool first
//   3. Then apply YOUR agent/agency split only to YOUR share of that pool
//
// Keeping these as separate steps (rather than one combined formula) means
// you can unit test each step independently, and it mirrors how agents
// actually think about the deal ("co-broke splits it, then my agency takes
// its cut of my half").

export interface CommissionBreakdown {
  totalCommission: number;
  yourGrossShare: number;    // your share of the pool, before agency cut
  yourNetShare: number;      // what actually lands in your pocket
  agencyShare: number;       // what your agency keeps
  coBrokePartnerShare: number; // 0 if no co-broke partner
}

export function calculateCommission(deal: Deal): CommissionBreakdown {
  const totalCommission = deal.dealValue * (deal.commissionPercent / 100);

  // Step 1: split between you and co-broke partner (if any).
  // No partner = you keep 100% of the pool before agency cut.
  const yourPoolSharePercent = deal.coBrokePartner
    ? 100 - deal.coBrokePartner.splitPercent
    : 100;

  const yourGrossShare = totalCommission * (yourPoolSharePercent / 100);
  const coBrokePartnerShare = totalCommission - yourGrossShare;

  // Step 2: apply your agency split to YOUR gross share only.
  // Co-broke partner's share is theirs to split with their own agency —
  // not your concern, so it's excluded from this calculation.
  const yourNetShare = yourGrossShare * (deal.agentSplitPercent / 100);
  const agencyShare = yourGrossShare - yourNetShare;

  return {
    totalCommission: round2(totalCommission),
    yourGrossShare: round2(yourGrossShare),
    yourNetShare: round2(yourNetShare),
    agencyShare: round2(agencyShare),
    coBrokePartnerShare: round2(coBrokePartnerShare),
  };
}

// Always round money to 2dp at the point of display/storage, never mid-calculation.
// Rounding early causes cent-level drift when numbers get re-summed later.
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// ============================================================================
// 2. STAGE TRANSITIONS
// ============================================================================
// A deal moves through a fixed, ordered pipeline. We enforce forward-only
// movement (no skipping backward accidentally) but allow jumping forward
// multiple stages (e.g. a deal can go straight from prospecting to paid if
// it was logged late). We block moving BACKWARD because that usually means
// a data-entry mistake, and silently allowing it hides bugs.

const STAGE_ORDER: DealStage[] = [
  "prospecting",
  "offer_accepted",
  "option_exercised",
  "completed",
  "paid",
];

export function moveToStage(deal: Deal, newStage: DealStage, date: string = new Date().toISOString()): Deal {
  const currentIndex = STAGE_ORDER.indexOf(deal.stage);
  const newIndex = STAGE_ORDER.indexOf(newStage);

  if (newIndex < currentIndex) {
    throw new Error(
      `Cannot move deal backward from "${deal.stage}" to "${newStage}". ` +
      `If this was a mistake, edit stageHistory directly instead of using moveToStage.`
    );
  }

  const updatedDeal: Deal = {
    ...deal,
    stage: newStage,
    stageHistory: [...deal.stageHistory, { stage: newStage, date }],
  };

  // Business rule: once the option is exercised, payout is expected roughly
  // 8-10 weeks later (typical time to completion in SG private property deals).
  // We default to 8 weeks as a conservative estimate — this is a guess the
  // agent can always override manually, not a guarantee.
  if (newStage === "option_exercised" && !updatedDeal.expectedPayoutDate) {
    const payout = new Date(date);
    payout.setDate(payout.getDate() + 56); // 8 weeks
    updatedDeal.expectedPayoutDate = payout.toISOString();
  }

  return updatedDeal;
}

// ============================================================================
// 3. PIPELINE SUMMARY (for the top bar on the home screen)
// ============================================================================
// "Total commission in pipeline" and "total overdue" are the two numbers
// agents check compulsively. Keep this function pure and cheap — it runs
// on every render of the home screen.

export interface PipelineSummary {
  totalInPipeline: number;   // your net share across all unpaid deals
  totalOverdue: number;      // your net share across deals past expected payout
  dealCountByStage: Record<DealStage, number>;
}

export function summarizePipeline(deals: Deal[], today: Date = new Date()): PipelineSummary {
  const dealCountByStage: Record<DealStage, number> = {
    prospecting: 0,
    offer_accepted: 0,
    option_exercised: 0,
    completed: 0,
    paid: 0,
  };

  let totalInPipeline = 0;
  let totalOverdue = 0;

  for (const deal of deals) {
    dealCountByStage[deal.stage]++;

    if (deal.stage === "paid") continue; // already collected, excluded from pipeline totals

    const { yourNetShare } = calculateCommission(deal);
    totalInPipeline += yourNetShare;

    const isOverdue =
      deal.expectedPayoutDate !== undefined &&
      new Date(deal.expectedPayoutDate) < today;

    if (isOverdue) {
      totalOverdue += yourNetShare;
    }
  }

  return {
    totalInPipeline: round2(totalInPipeline),
    totalOverdue: round2(totalOverdue),
    dealCountByStage,
  };
}

// ============================================================================
// 4. CO-BROKE SPLIT CALCULATOR (standalone, for the split-editor screen)
// ============================================================================
// This is deliberately separate from calculateCommission above. The UI lets
// an agent drag one slider and see both sides update live, BEFORE they've
// necessarily saved it to a deal. Keeping it standalone means the split
// screen doesn't need a full Deal object to work — just two numbers.

export interface SplitResult {
  yourShare: number;
  partnerShare: number;
}

export function calculateSplit(totalCommission: number, yourPercent: number): SplitResult {
  if (yourPercent < 0 || yourPercent > 100) {
    throw new Error("yourPercent must be between 0 and 100");
  }
  const yourShare = totalCommission * (yourPercent / 100);
  return {
    yourShare: round2(yourShare),
    partnerShare: round2(totalCommission - yourShare),
  };
}

// ============================================================================
// 5. MONTHLY / YTD REPORT AGGREGATION
// ============================================================================
// Groups paid deals by the month they were marked "paid" (not the month
// they were created) — this matches how agents think about income for tax
// purposes: "what did I actually receive in March", not "what deals did I
// start in March".

export interface MonthlyReport {
  month: string; // "2026-03"
  earned: number;
  dealCount: number;
}

export function generateMonthlyReport(deals: Deal[]): MonthlyReport[] {
  const paidDeals = deals.filter((d) => d.stage === "paid");
  const byMonth = new Map<string, { earned: number; dealCount: number }>();

  for (const deal of paidDeals) {
    const paidEntry = deal.stageHistory.find((h) => h.stage === "paid");
    if (!paidEntry) continue; // defensive: shouldn't happen if moveToStage was used consistently

    const month = paidEntry.date.slice(0, 7); // "2026-03-15T..." -> "2026-03"
    const { yourNetShare } = calculateCommission(deal);

    const existing = byMonth.get(month) ?? { earned: 0, dealCount: 0 };
    byMonth.set(month, {
      earned: round2(existing.earned + yourNetShare),
      dealCount: existing.dealCount + 1,
    });
  }

  return Array.from(byMonth.entries())
    .map(([month, data]) => ({ month, ...data }))
    .sort((a, b) => a.month.localeCompare(b.month));
}
