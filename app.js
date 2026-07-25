"use strict";

/* ============================================================
   PART 1 — CORE BUSINESS LOGIC
   Ported directly from commission-tracker-core.ts.
   These functions are storage-agnostic: they take plain deal
   objects and return numbers/new objects. Swap localStorage for
   Supabase later without touching anything in this section.
   ============================================================ */

const STAGE_ORDER = [
  "prospecting",
  "offer_accepted",
  "option_exercised",
  "completed",
  "paid",
];

const STAGE_LABELS = {
  prospecting: "Prospecting",
  offer_accepted: "Offer accepted",
  option_exercised: "Option exercised",
  completed: "Completed",
  paid: "Paid",
};

function round2(value) {
  return Math.round(value * 100) / 100;
}

// Same two-step order as the backend: split the co-broke pool first,
// then apply your agency split only to your own share of that pool.
function calculateCommission(deal) {
  const totalCommission = deal.dealValue * (deal.commissionPercent / 100);

  const yourPoolSharePercent = deal.coBrokePartner
    ? 100 - deal.coBrokePartner.splitPercent
    : 100;

  const yourGrossShare = totalCommission * (yourPoolSharePercent / 100);
  const coBrokePartnerShare = totalCommission - yourGrossShare;

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

// Forward-only stage transitions, same guard as the backend version.
function moveToStage(deal, newStage, date) {
  date = date || new Date().toISOString();
  const currentIndex = STAGE_ORDER.indexOf(deal.stage);
  const newIndex = STAGE_ORDER.indexOf(newStage);

  if (newIndex < currentIndex) {
    throw new Error(`Cannot move backward from "${deal.stage}" to "${newStage}".`);
  }

  const updated = Object.assign({}, deal, {
    stage: newStage,
    stageHistory: deal.stageHistory.concat([{ stage: newStage, date }]),
  });

  if (newStage === "option_exercised" && !updated.expectedPayoutDate) {
    const payout = new Date(date);
    payout.setDate(payout.getDate() + 56); // 8-week default, editable later
    updated.expectedPayoutDate = payout.toISOString();
  }

  return updated;
}

function summarizePipeline(deals, today) {
  today = today || new Date();
  let totalInPipeline = 0;
  let totalOverdue = 0;

  deals.forEach((deal) => {
    if (deal.stage === "paid") return;
    const { yourNetShare } = calculateCommission(deal);
    totalInPipeline += yourNetShare;

    const isOverdue = deal.expectedPayoutDate && new Date(deal.expectedPayoutDate) < today;
    if (isOverdue) totalOverdue += yourNetShare;
  });

  return { totalInPipeline: round2(totalInPipeline), totalOverdue: round2(totalOverdue) };
}

function generateMonthlyReport(deals) {
  const paidDeals = deals.filter((d) => d.stage === "paid");
  const byMonth = new Map();

  paidDeals.forEach((deal) => {
    const paidEntry = [...deal.stageHistory].reverse().find((h) => h.stage === "paid");
    if (!paidEntry) return;
    const month = paidEntry.date.slice(0, 7);
    const { yourNetShare } = calculateCommission(deal);
    const existing = byMonth.get(month) || { earned: 0, dealCount: 0 };
    byMonth.set(month, { earned: round2(existing.earned + yourNetShare), dealCount: existing.dealCount + 1 });
  });

  return Array.from(byMonth.entries())
    .map(([month, data]) => ({ month, ...data }))
    .sort((a, b) => a.month.localeCompare(b.month));
}

function fmtMoney(n) {
  return "S$" + Number(n).toLocaleString("en-SG", { maximumFractionDigits: 0 });
}

/* ============================================================
   PART 2 — STORAGE LAYER (localStorage today, Supabase-ready)
   Every read/write goes through these three functions. To move
   to Supabase later, you only need to rewrite the bodies of
   loadDeals/saveDeals — nothing in Part 1 or Part 3 changes.
   ============================================================ */

const STORAGE_KEY = "dealtracker_deals_v1";

function loadDeals() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.error("Failed to load deals", e);
    return [];
  }
}

function saveDeals(deals) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(deals));
}

function uid() {
  return "d_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/* ============================================================
   PART 3 — UI WIRING
   ============================================================ */

let deals = loadDeals();

// ---- Tab navigation ----
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById("screen-" + tab.dataset.screen).classList.add("active");
    if (tab.dataset.screen === "calendar") renderCalendar();
    if (tab.dataset.screen === "reports") renderReports();
  });
});

// ---- Modal open/close ----
const dealModal = document.getElementById("dealModal");
const detailModal = document.getElementById("detailModal");
const dealForm = document.getElementById("dealForm");

document.getElementById("addDealBtn").addEventListener("click", () => openDealModal());
document.querySelectorAll("[data-close-modal]").forEach((btn) =>
  btn.addEventListener("click", () => {
    dealModal.classList.add("hidden");
    detailModal.classList.add("hidden");
  })
);

document.getElementById("f_hasCobroke").addEventListener("change", (e) => {
  document.getElementById("cobrokeFields").classList.toggle("hidden", !e.target.checked);
  updateLivePreview();
});

["f_dealValue", "f_commissionPct", "f_agentSplitPct", "f_partnerSplitPct"].forEach((id) => {
  document.getElementById(id).addEventListener("input", updateLivePreview);
});

function openDealModal() {
  dealForm.reset();
  document.getElementById("cobrokeFields").classList.add("hidden");
  document.getElementById("modalTitle").textContent = "New deal";
  updateLivePreview();
  dealModal.classList.remove("hidden");
}

function buildDealFromForm() {
  const hasCobroke = document.getElementById("f_hasCobroke").checked;
  return {
    dealValue: Number(document.getElementById("f_dealValue").value) || 0,
    commissionPercent: Number(document.getElementById("f_commissionPct").value) || 0,
    agentSplitPercent: Number(document.getElementById("f_agentSplitPct").value) || 0,
    coBrokePartner: hasCobroke
      ? {
          name: document.getElementById("f_partnerName").value,
          splitPercent: Number(document.getElementById("f_partnerSplitPct").value) || 0,
        }
      : undefined,
  };
}

function updateLivePreview() {
  const partial = buildDealFromForm();
  const { totalCommission, yourNetShare } = calculateCommission(partial);
  document.getElementById("pv_total").textContent = fmtMoney(totalCommission);
  document.getElementById("pv_net").textContent = fmtMoney(yourNetShare);
}

dealForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const address = document.getElementById("f_address").value.trim();
  if (!address) return;

  const stage = document.getElementById("f_stage").value;
  const now = new Date().toISOString();

  const newDeal = Object.assign(buildDealFromForm(), {
    id: uid(),
    propertyAddress: address,
    stage: "prospecting",
    stageHistory: [{ stage: "prospecting", date: now }],
    createdAt: now,
  });

  // Fast-forward through stages so history and payout-date logic stay
  // consistent, in case the agent is logging a deal that's already
  // further along the pipeline.
  const finalDeal = STAGE_ORDER.indexOf(stage) > 0 ? moveToStage(newDeal, stage, now) : newDeal;

  deals.push(finalDeal);
  saveDeals(deals);
  dealModal.classList.add("hidden");
  renderPipeline();
});

// ---- Pipeline rendering ----
function renderPipeline() {
  const list = document.getElementById("pipelineList");
  const empty = document.getElementById("pipelineEmpty");
  list.innerHTML = "";

  if (deals.length === 0) {
    empty.classList.remove("hidden");
  } else {
    empty.classList.add("hidden");
    // Most recently touched deals first.
    const sorted = [...deals].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    sorted.forEach((deal) => list.appendChild(renderDealCard(deal)));
  }

  const summary = summarizePipeline(deals);
  document.getElementById("sumPipeline").textContent = fmtMoney(summary.totalInPipeline);
  document.getElementById("sumOverdue").textContent = fmtMoney(summary.totalOverdue);
}

function renderDealCard(deal) {
  const { yourNetShare } = calculateCommission(deal);
  const isOverdue = deal.expectedPayoutDate && new Date(deal.expectedPayoutDate) < new Date() && deal.stage !== "paid";

  const card = document.createElement("div");
  card.className = "deal-card" + (isOverdue ? " is-overdue" : "");
  card.innerHTML = `
    <div class="deal-card-top">
      <span class="deal-address">${escapeHtml(deal.propertyAddress)}</span>
      <span class="stage-pill stage-${deal.stage}">${STAGE_LABELS[deal.stage]}</span>
    </div>
    <div class="deal-card-bottom">
      <span class="deal-net mono">${fmtMoney(yourNetShare)}</span>
      <span class="deal-meta">${isOverdue ? '<span class="overdue-flag">Overdue · </span>' : ""}${deal.coBrokePartner ? "Co-broke with " + escapeHtml(deal.coBrokePartner.name) : "Solo deal"}</span>
    </div>
  `;
  card.addEventListener("click", () => openDetailModal(deal.id));
  return card;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str || "";
  return div.innerHTML;
}

// ---- Deal detail ----
function openDetailModal(dealId) {
  const deal = deals.find((d) => d.id === dealId);
  if (!deal) return;
  const c = calculateCommission(deal);

  const body = document.getElementById("detailBody");
  body.innerHTML = `
    <div class="detail-row"><span>${escapeHtml(deal.propertyAddress)}</span><span class="stage-pill stage-${deal.stage}">${STAGE_LABELS[deal.stage]}</span></div>
    <div class="detail-section-title">Commission breakdown</div>
    <div class="detail-row"><span>Total commission</span><span class="mono">${fmtMoney(c.totalCommission)}</span></div>
    ${deal.coBrokePartner ? `<div class="detail-row"><span>Co-broke partner (${escapeHtml(deal.coBrokePartner.name)})</span><span class="mono">${fmtMoney(c.coBrokePartnerShare)}</span></div>` : ""}
    <div class="detail-row"><span>Your gross share</span><span class="mono">${fmtMoney(c.yourGrossShare)}</span></div>
    <div class="detail-row"><span>Agency share</span><span class="mono">${fmtMoney(c.agencyShare)}</span></div>
    <div class="detail-row"><span><strong>Your net share</strong></span><span class="mono"><strong>${fmtMoney(c.yourNetShare)}</strong></span></div>
    ${deal.expectedPayoutDate ? `<div class="detail-row"><span>Expected payout</span><span class="mono">${new Date(deal.expectedPayoutDate).toLocaleDateString("en-SG")}</span></div>` : ""}
    <div class="detail-section-title">Move stage</div>
    <div class="stage-actions">
      ${STAGE_ORDER.map((s) => `<button data-stage="${s}" class="${s === deal.stage ? "current" : ""}">${STAGE_LABELS[s]}</button>`).join("")}
    </div>
  `;

  body.querySelectorAll("[data-stage]").forEach((btn) => {
    btn.addEventListener("click", () => {
      try {
        const updated = moveToStage(deal, btn.dataset.stage);
        deals = deals.map((d) => (d.id === deal.id ? updated : d));
        saveDeals(deals);
        detailModal.classList.add("hidden");
        renderPipeline();
      } catch (err) {
        alert(err.message);
      }
    });
  });

  detailModal.classList.remove("hidden");
}

// ---- Calendar ----
function renderCalendar() {
  const list = document.getElementById("calendarList");
  const upcoming = deals
    .filter((d) => d.expectedPayoutDate && d.stage !== "paid")
    .sort((a, b) => a.expectedPayoutDate.localeCompare(b.expectedPayoutDate));

  if (upcoming.length === 0) {
    list.innerHTML = '<div class="empty-state"><p class="empty-body">No upcoming payouts yet. Payout dates appear once a deal reaches "Option exercised".</p></div>';
    return;
  }

  list.innerHTML = upcoming
    .map((deal) => {
      const { yourNetShare } = calculateCommission(deal);
      const date = new Date(deal.expectedPayoutDate);
      return `<div class="calendar-item">
        <span class="calendar-date">${date.toLocaleDateString("en-SG", { day: "2-digit", month: "short" })}</span>
        <span class="calendar-address">${escapeHtml(deal.propertyAddress)}</span>
        <span class="calendar-amount mono">${fmtMoney(yourNetShare)}</span>
      </div>`;
    })
    .join("");
}

// ---- Reports ----
function renderReports() {
  const report = generateMonthlyReport(deals);
  const list = document.getElementById("reportsList");

  if (report.length === 0) {
    list.innerHTML = '<div class="empty-state"><p class="empty-body">No paid deals yet. Once you mark a deal "Paid," it shows up here.</p></div>';
    return;
  }

  list.innerHTML = report
    .map(
      (r) => `<div class="report-row">
        <span class="report-month">${r.month}</span>
        <span>
          <span class="report-amount">${fmtMoney(r.earned)}</span>
          <span class="report-count"> · ${r.dealCount} deal${r.dealCount > 1 ? "s" : ""}</span>
        </span>
      </div>`
    )
    .join("");
}

document.getElementById("exportCsvBtn").addEventListener("click", () => {
  const report = generateMonthlyReport(deals);
  const rows = [["Month", "Earned (S$)", "Deal count"]].concat(
    report.map((r) => [r.month, r.earned, r.dealCount])
  );
  const csv = rows.map((r) => r.join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "commission-report.csv";
  a.click();
  URL.revokeObjectURL(url);
});

// ---- Init ----
renderPipeline();

// ---- Register service worker ----
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch((e) => console.error("SW registration failed", e));
  });
}
