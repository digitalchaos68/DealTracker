"use strict";

/* ============================================================
   SUPABASE CONFIG — fill these in from your project's
   Settings → API page, then this file works as-is.
   ============================================================ */
const SUPABASE_URL = "https://oobzdmzpcxkcbpowuoky.supabase.co"; // e.g. https://abcdefgh.supabase.co
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9vYnpkbXpwY3hrY2Jwb3d1b2t5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ5NjgzMzUsImV4cCI6MjEwMDU0NDMzNX0.PI8gDFBZ-vGZnOxyn1xjfysPtw2TLMt8NMQIsalsmSw";

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/* ============================================================
   PART 1 — CORE BUSINESS LOGIC
   Unchanged from before. These functions take plain deal objects
   and return numbers/new objects — they don't know or care that
   the data now comes from Supabase instead of localStorage.
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
   PART 2 — STORAGE LAYER (Supabase, with a localStorage cache
   for offline viewing)

   Design notes for future-you:
   - Every deal is scoped to auth.uid() via Row Level Security
     (see supabase-schema.sql) — the queries below don't need to
     filter by user_id manually, Postgres enforces it server-side.
   - We use Supabase's ANONYMOUS auth for now, so an agent gets a
     stable identity with zero login screen. When you add Google
     login later (Step 2), you call supabase.auth.linkIdentity()
     to UPGRADE the same anonymous account instead of creating a
     new one — their existing deals carry over automatically.
   - Writes require network. Reads fall back to the last successful
     fetch (cached in localStorage) if offline, so the app is at
     least viewable without a signal, matching the "works on a
     train" requirement from the original PWA.
   ============================================================ */

const CACHE_KEY = "dealtracker_cache_v1";

function setSyncStatus(text, mode) {
  const el = document.getElementById("syncStatus");
  if (!el) return;
  el.textContent = text;
  el.className = "sync-status" + (mode ? " " + mode : "");
}

// Ensures every visitor has a stable Supabase identity without a login
// screen. Anonymous auth persists its session in localStorage automatically
// (via supabase-js), so the same "account" is reused on return visits to
// the same browser.
async function ensureSession() {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (session) return session.user;

  const { data, error } = await supabaseClient.auth.signInAnonymously();
  if (error) {
    console.error("Anonymous sign-in failed", error);
    throw error;
  }

  // First time we see this user: create their row in `users` so the
  // deals.user_id foreign key has somewhere to point.
  await supabaseClient.from("users").upsert({ id: data.user.id, name: "New Agent" });

  return data.user;
}

// Converts a Supabase `deals` row (+ nested co_broke_partners and
// deal_stage_history from the join) into the plain-object shape the
// core logic functions (Part 1) expect.
function rowToDeal(row) {
  const partner = (row.co_broke_partners || [])[0];
  return {
    id: row.id,
    propertyAddress: row.property_address,
    dealValue: row.deal_value_cents / 100,
    commissionPercent: Number(row.commission_percent),
    agentSplitPercent: Number(row.agent_split_percent),
    stage: row.stage,
    expectedPayoutDate: row.expected_payout_date,
    createdAt: row.created_at,
    coBrokePartner: partner
      ? { name: partner.name, splitPercent: Number(partner.split_percent) }
      : undefined,
    stageHistory: (row.deal_stage_history || [])
      .map((h) => ({ stage: h.stage, date: h.changed_at }))
      .sort((a, b) => a.date.localeCompare(b.date)),
  };
}

async function loadDeals() {
  try {
    const { data, error } = await supabaseClient
      .from("deals")
      .select("*, co_broke_partners(*), deal_stage_history(*)")
      .order("created_at", { ascending: false });

    if (error) throw error;

    const mapped = data.map(rowToDeal);
    localStorage.setItem(CACHE_KEY, JSON.stringify(mapped));
    setSyncStatus("Synced", "");
    return mapped;
  } catch (e) {
    console.error("Load from Supabase failed, falling back to cache", e);
    setSyncStatus("Offline — showing last saved data", "offline");
    const cached = localStorage.getItem(CACHE_KEY);
    return cached ? JSON.parse(cached) : [];
  }
}

// Inserts a brand-new deal: the deals row, its co-broke partner row (if
// any), and one deal_stage_history row per stage it was fast-forwarded
// through. Three tables, one logical action — if any insert fails we
// don't silently leave partial data, we surface the error to the caller.
async function createDealInSupabase(deal, userId) {
  const { data: dealRow, error: dealErr } = await supabaseClient
    .from("deals")
    .insert({
      user_id: userId,
      property_address: deal.propertyAddress,
      deal_value_cents: Math.round(deal.dealValue * 100),
      commission_percent: deal.commissionPercent,
      agent_split_percent: deal.agentSplitPercent,
      agency_split_percent: 100 - deal.agentSplitPercent,
      stage: deal.stage,
      expected_payout_date: deal.expectedPayoutDate ? deal.expectedPayoutDate.slice(0, 10) : null,
    })
    .select()
    .single();

  if (dealErr) throw dealErr;

  if (deal.coBrokePartner) {
    const { error: partnerErr } = await supabaseClient.from("co_broke_partners").insert({
      deal_id: dealRow.id,
      name: deal.coBrokePartner.name,
      split_percent: deal.coBrokePartner.splitPercent,
    });
    if (partnerErr) throw partnerErr;
  }

  const historyRows = deal.stageHistory.map((h) => ({
    deal_id: dealRow.id,
    stage: h.stage,
    changed_at: h.date,
  }));
  const { error: historyErr } = await supabaseClient.from("deal_stage_history").insert(historyRows);
  if (historyErr) throw historyErr;

  return dealRow.id;
}

// Persists a stage move: updates the deals row (stage + payout date) and
// appends exactly one new deal_stage_history row. We only insert the LAST
// entry of stageHistory here — moveToStage() already appended it locally,
// so re-inserting the whole array would duplicate every prior stage.
async function updateStageInSupabase(deal) {
  const { error: updateErr } = await supabaseClient
    .from("deals")
    .update({
      stage: deal.stage,
      expected_payout_date: deal.expectedPayoutDate ? deal.expectedPayoutDate.slice(0, 10) : null,
    })
    .eq("id", deal.id);
  if (updateErr) throw updateErr;

  const latest = deal.stageHistory[deal.stageHistory.length - 1];
  const { error: historyErr } = await supabaseClient.from("deal_stage_history").insert({
    deal_id: deal.id,
    stage: latest.stage,
    changed_at: latest.date,
  });
  if (historyErr) throw historyErr;
}

/* ============================================================
   PART 3 — UI WIRING
   ============================================================ */

let deals = [];
let currentUserId = null;

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

dealForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const address = document.getElementById("f_address").value.trim();
  if (!address) return;

  const stage = document.getElementById("f_stage").value;
  const now = new Date().toISOString();

  const newDeal = Object.assign(buildDealFromForm(), {
    id: null, // assigned by Supabase after insert
    propertyAddress: address,
    stage: "prospecting",
    stageHistory: [{ stage: "prospecting", date: now }],
    createdAt: now,
  });

  const finalDeal = STAGE_ORDER.indexOf(stage) > 0 ? moveToStage(newDeal, stage, now) : newDeal;

  const submitBtn = dealForm.querySelector("button[type=submit]");
  submitBtn.disabled = true;
  submitBtn.textContent = "Saving…";

  try {
    const newId = await createDealInSupabase(finalDeal, currentUserId);
    finalDeal.id = newId;
    deals.unshift(finalDeal);
    localStorage.setItem(CACHE_KEY, JSON.stringify(deals));
    dealModal.classList.add("hidden");
    renderPipeline();
  } catch (err) {
    console.error(err);
    alert("Couldn't save this deal — check your connection and try again.");
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Save deal";
  }
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
    btn.addEventListener("click", async () => {
      try {
        const updated = moveToStage(deal, btn.dataset.stage);
        btn.disabled = true;
        await updateStageInSupabase(updated);
        deals = deals.map((d) => (d.id === deal.id ? updated : d));
        localStorage.setItem(CACHE_KEY, JSON.stringify(deals));
        detailModal.classList.add("hidden");
        renderPipeline();
      } catch (err) {
        console.error(err);
        alert(err.message || "Couldn't update this deal — check your connection.");
        btn.disabled = false;
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
async function init() {
  setSyncStatus("Connecting…", "");
  try {
    const user = await ensureSession();
    currentUserId = user.id;
  } catch (e) {
    setSyncStatus("Couldn't connect — check Supabase config", "error");
    const cached = localStorage.getItem(CACHE_KEY);
    deals = cached ? JSON.parse(cached) : [];
    renderPipeline();
    return;
  }

  deals = await loadDeals();
  renderPipeline();
}

init();

// ---- Register service worker ----
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch((e) => console.error("SW registration failed", e));
  });
}
