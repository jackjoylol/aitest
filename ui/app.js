// app.js — Hearthkeeper dashboard (vanilla JS, no build step).

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function timeAgo(iso) {
  if (!iso) return "";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const state = { data: null, busy: false };

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error?.message ?? body.error ?? `HTTP ${res.status}`);
  return body;
}

// ── tabs ────────────────────────────────────────────────────────────

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    $(`#tab-${tab.dataset.tab}`).classList.add("active");
  });
});

// ── header / state ──────────────────────────────────────────────────

function renderHeader() {
  const d = state.data;
  const chip = $("#mind-chip");
  if (d.mode === "mock") {
    chip.textContent = "🧪 MOCK — offline simulator";
    chip.className = "chip mock";
  } else if (d.mind) {
    chip.textContent = `🟢 ${d.mind.name}`;
    chip.className = "chip ok";
  } else if (d.mindError) {
    chip.textContent = "🔴 Mind offline";
    chip.className = "chip err";
    $("#banner").classList.remove("hidden");
    $("#banner").textContent = `Mind not connected: ${d.mindError.message}`;
  } else {
    chip.textContent = "…";
  }
  const cog = $("#cognition-chip");
  if (d.cognitionBalance !== null && d.cognitionBalance !== undefined) {
    cog.textContent = `⚡ ${d.cognitionBalance.toLocaleString()} cognition`;
    cog.classList.remove("hidden");
  } else cog.classList.add("hidden");
  const onb = $("#onboard-chip");
  onb.textContent = d.onboarded ? "🧠 norms taught" : "🧠 teaching norms…";
  onb.classList.remove("hidden");
  $("#mode-label").textContent = d.mode === "mock" ? "offline mock mode" : "live Minds agent";
  $("#tab-queue-count").textContent = d.counts.pending || "";
  $("#tab-queue-count").style.display = d.counts.pending ? "" : "none";
  $("#btn-review").disabled = d.busy.review || state.busy;
  $("#btn-review").textContent = d.busy.review ? "Mind is reviewing…" : "Review queue →";
}

// ── queue ───────────────────────────────────────────────────────────

function renderQueue() {
  const list = $("#queue-list");
  const q = state.data.queue;
  if (!q.length) {
    list.innerHTML = `<div class="empty">Queue is empty. Add posts below or POST to /api/webhook to simulate a community feed.</div>`;
    return;
  }
  list.innerHTML = q.map((p) => `
    <div class="card">
      <div class="top">
        <strong>${esc(p.user_name)}</strong>
        <span class="badge pending">pending</span>
        <span class="meta">#${esc(p.channel)} · ${timeAgo(p.posted_at)}</span>
      </div>
      <div class="text">${esc(p.text)}</div>
    </div>`).join("");
}

// ── decisions ───────────────────────────────────────────────────────

function renderDecisions() {
  const list = $("#decision-list");
  const rows = state.data.decisions;
  if (!rows.length) {
    list.innerHTML = `<div class="empty">No rulings yet. Review the queue and the Mind will decide every post.</div>`;
    return;
  }
  list.innerHTML = rows.map((d) => {
    const source = d.source === "creator-override" ? "👤 creator" : d.source === "system" ? "⚙️ system" : "🧠 Mind";
    return `
    <div class="card" data-post="${esc(d.post_id)}">
      <div class="top">
        <strong>${esc(d.user_name)}</strong>
        <span class="badge ${esc(d.action)}">${esc(d.action)}</span>
        <span class="sev">${esc(d.severity)} · ${esc(d.category)}</span>
        <span class="meta">${source} · ${timeAgo(d.created_at)}</span>
        <span class="override">
          <select class="ov-to">
            ${["allow", "flag", "remove"].filter((a) => a !== d.action).map((a) => `<option value="${a}">→ ${a}</option>`).join("")}
          </select>
          <button class="btn" data-ov="${esc(d.post_id)}">Override</button>
        </span>
      </div>
      <div class="text">${esc(d.text)}</div>
      <div class="meta" style="margin-top:6px">${esc(d.reason)}</div>
    </div>`;
  }).join("");

  list.querySelectorAll("[data-ov]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const card = btn.closest(".card");
      const to = card.querySelector(".ov-to").value;
      const note = prompt("Note for the Mind (optional):") ?? "";
      btn.disabled = true;
      try {
        await api(`/api/decisions/${encodeURIComponent(btn.dataset.ov)}/override`, {
          method: "POST", body: JSON.stringify({ to, note }),
        });
      } catch (err) { alert(`Override failed: ${err.message}`); }
      btn.disabled = false;
      refresh();
    });
  });
}

// ── members ─────────────────────────────────────────────────────────

function renderMembers() {
  const list = $("#member-list");
  const users = state.data.users;
  if (!users.length) {
    list.innerHTML = `<div class="empty">No members yet.</div>`;
    return;
  }
  list.innerHTML = users.map((u) => `
    <div class="card">
      <div class="top">
        <strong>${esc(u.name)}</strong>
        <span class="badge ${esc(u.status)}">${esc(u.status)}</span>
        <span class="meta">${u.violations} violation(s) · seen ${timeAgo(u.last_seen)}</span>
      </div>
      ${u.notes ? `<div class="meta">${esc(u.notes)}</div>` : ""}
    </div>`).join("");
}

// ── reports ─────────────────────────────────────────────────────────

function renderReports() {
  const list = $("#report-list");
  const reports = state.data.reports;
  if (!reports.length) {
    list.innerHTML = `<div class="empty">No reports yet. The daily digest (autonomous, scheduled) will land here — or click "Daily digest".</div>`;
    return;
  }
  list.innerHTML = `<div class="report-grid">` + reports.map((r) => {
    let body = "";
    try { body = JSON.parse(r.body); } catch { body = { summary: r.body }; }
    const inner = r.kind === "digest"
      ? `<div class="score">${body.healthScore ?? "?"}<span style="font-size:14px;color:var(--muted)">/100</span></div>
         <div class="summary">${esc(body.summary ?? "")}</div>
         ${(body.concerns ?? []).length ? `<ul>${body.concerns.map((c) => `<li>⚠️ ${esc(c)}</li>`).join("")}</ul>` : ""}
         ${(body.recommendations ?? []).length ? `<ul>${body.recommendations.map((c) => `<li>💡 ${esc(c)}</li>`).join("")}</ul>` : ""}`
      : `<div class="summary"><pre style="white-space:pre-wrap;font:inherit">${esc(JSON.stringify(body, null, 1))}</pre></div>`;
    return `<div class="report"><div class="top" style="display:flex;justify-content:space-between;align-items:center">
      <strong>${esc(r.title)}</strong><span class="meta">${timeAgo(r.created_at)}</span></div>${inner}</div>`;
  }).join("") + `</div>`;
}

// ── mind chat ───────────────────────────────────────────────────────

async function refreshChat() {
  try {
    const { rows } = await api("/api/history?limit=60");
    const log = $("#chat-log");
    const stick = log.scrollTop + log.clientHeight >= log.scrollHeight - 40;
    log.innerHTML = rows.map((r) => {
      const who = r.senderType === 1 ? "human" : "mind";
      return `<div class="msg ${who}"><div class="who">${who === "human" ? "You / app" : "Mind"}</div>${esc(r.messageText)}</div>`;
    }).join("") || `<div class="empty">No conversation yet.</div>`;
    if (stick) log.scrollTop = log.scrollHeight;
  } catch { /* chat is best-effort */ }
}

// ── refresh loop ────────────────────────────────────────────────────

async function refresh() {
  try {
    state.data = await api("/api/state");
    renderHeader();
    renderQueue();
    renderDecisions();
    renderMembers();
    renderReports();
  } catch (err) {
    $("#banner").classList.remove("hidden");
    $("#banner").textContent = `Dashboard error: ${err.message}`;
  }
}

setInterval(refresh, 4000);
setInterval(refreshChat, 6000);

// ── actions ─────────────────────────────────────────────────────────

$("#post-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const post = {
    userName: $("#pf-user").value.trim(),
    channel: $("#pf-channel").value.trim() || "general",
    text: $("#pf-text").value.trim(),
  };
  if (!post.userName || !post.text) return;
  try {
    await api("/api/posts", { method: "POST", body: JSON.stringify(post) });
    $("#pf-text").value = "";
    await refresh();
  } catch (err) { alert(`Failed to queue post: ${err.message}`); }
});

$("#btn-review").addEventListener("click", async () => {
  state.busy = true;
  renderHeader();
  try {
    const result = await api("/api/review", { method: "POST" });
    if (result.skipped) {
      alert("A review is already in progress — the Mind is working.");
      return;
    }
    alert(result.error
      ? `Reviewed ${result.reviewed} post(s) — Mind reply was unparseable, sent to human review.\n${result.error}`
      : `Reviewed ${result.reviewed} post(s). Verdicts from the Mind:\n` +
        (result.verdicts ?? []).map((v) => `  • ${v.action.padEnd(6)} ${v.category.padEnd(10)} ${v.reason}`).join("\n"));
  } catch (err) { alert(`Review failed: ${err.message}`); }
  state.busy = false;
  refresh();
});

$("#btn-digest").addEventListener("click", async () => {
  try { await api("/api/digest", { method: "POST" }); alert("Digest generated."); refresh(); }
  catch (err) { alert(`Digest failed: ${err.message}`); }
});

$("#btn-escalate").addEventListener("click", async () => {
  try {
    const r = await api("/api/escalate", { method: "POST" });
    alert(r.escalated ? `Escalated ${r.escalated} member(s):\n` + r.members.map((m) => `  • ${m.userId} → ${m.action}`).join("\n") : r.message ?? "No repeat offenders.");
    refresh();
  } catch (err) { alert(`Escalation failed: ${err.message}`); }
});

$("#btn-onboard").addEventListener("click", async () => {
  try { await api("/api/onboard", { method: "POST", body: JSON.stringify({ force: true }) }); alert("Norms re-taught."); refresh(); }
  catch (err) { alert(`Onboarding failed: ${err.message}`); }
});

$("#chat-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("#chat-input");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  try {
    const { reply } = await api("/api/chat", { method: "POST", body: JSON.stringify({ text }) });
    refreshChat();
    if (!reply) alert("No reply from the Mind.");
  } catch (err) { alert(`Chat failed: ${err.message}`); }
});

// ── boot ────────────────────────────────────────────────────────────

refresh();
refreshChat();
