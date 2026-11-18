const ICONS = {
  chatgpt: "icons/chatgpt.svg",
  gemini: "icons/gemini.svg",
  grok: "icons/grok.svg",
  grokbot: "icons/grokbot.svg"
};
const LABELS = {
  ok: "działa",
  slow: "spowolnienie",
  partial: "częściowa awaria",
  major: "poważna awaria",
  planned: "zaplanowane prace",
  unknown: "brak danych"
};

let currentData = null;
let activeServiceId = null;
let refreshTimer = null;

function $(sel, root) { return (root || document).querySelector(sel); }
function $all(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }
function statusWord(s) { return LABELS[s] || LABELS.unknown; }

function formatTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  return formatTimeFromDate(d);
}

function formatTimeFromDate(d) {
  const time = new Intl.DateTimeFormat("pl-PL", {
    timeZone: "Europe/Warsaw", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).format(d);
  const dayFmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Warsaw", year: "numeric", month: "2-digit", day: "2-digit"
  });
  if (dayFmt.format(d) === dayFmt.format(new Date())) return time;
  const day = new Intl.DateTimeFormat("pl-PL", {
    timeZone: "Europe/Warsaw", day: "2-digit", month: "2-digit"
  }).format(d);
  return day + " " + time;
}

function setIcon(el, id) {
  const img = el.querySelector("img");
  if (img && ICONS[id]) {
    img.src = ICONS[id];
    img.alt = "";
  }
}

function applyServiceTile(article, svc) {
  const wrap = article.querySelector(".tile-wrap");
  wrap.className = "tile-wrap " + (svc.status || "unknown");
  setIcon(article, svc.id);
  const st = article.querySelector(".service-status");
  st.className = "service-status " + (svc.status || "unknown");
  st.textContent = statusWord(svc.status);
  article.dataset.id = svc.id;
}

function renderHome(data) {
  currentData = data;
  const byId = {};
  (data.services || []).forEach(function (s) { byId[s.id] = s; });
  $all(".service").forEach(function (article) {
    const id = article.getAttribute("data-id");
    if (byId[id]) applyServiceTile(article, byId[id]);
  });
  const checked = data.checkedAt ? formatTime(data.checkedAt) : "";
  $all(".last-check").forEach(function (el) {
    el.textContent = checked ? ("Ostatnie sprawdzenie: " + checked) : "Ostatnie sprawdzenie: —";
  });
  $("#error-banner").hidden = true;
}

function maybeLangNote(parent, translated) {
  if (translated === false) {
    const note = document.createElement("span");
    note.className = "lang-note";
    note.textContent = "oryginalny tekst po angielsku";
    parent.appendChild(note);
  }
}

function renderDetails(svc) {
  activeServiceId = svc.id;
  $("#details-name").textContent = "Szczegóły";
  $("#hero-name").textContent = svc.name;
  const wrap = $("#hero-tile");
  wrap.className = "tile-wrap " + (svc.status || "unknown");
  setIcon(wrap, svc.id);
  const hs = $("#hero-status");
  hs.className = "hero-status " + (svc.status || "unknown");
  hs.textContent = capitalize(statusWord(svc.status));

  const compBox = $("#components-list");
  compBox.innerHTML = "";
  const comps = svc.components || [];
  if (!comps.length) {
    compBox.innerHTML = '<p class="note">Brak listy komponentów.</p>';
  } else {
    comps.forEach(function (c) {
      const row = document.createElement("div");
      row.className = "comp-row";
      const dot = document.createElement("span");
      dot.className = "dot " + safeClass(c.status);
      const name = document.createElement("span");
      name.className = "comp-name";
      name.textContent = c.name;
      const state = document.createElement("span");
      state.className = "comp-state " + safeClass(c.status);
      state.textContent = statusWord(c.status);
      row.appendChild(dot);
      row.appendChild(name);
      row.appendChild(state);
      compBox.appendChild(row);
    });
  }

  const notes = $("#service-notes");
  notes.innerHTML = "";
  (svc.notes || []).forEach(function (n) {
    const p = document.createElement("p");
    p.className = "note";
    p.textContent = n;
    notes.appendChild(p);
  });

  const incBox = $("#incidents-list");
  incBox.innerHTML = "";
  const incs = svc.incidents || [];
  if (!incs.length) {
    incBox.innerHTML = '<p class="empty-inc">Brak trwających incydentów.</p>';
  } else {
    incs.forEach(function (inc) {
      const el = document.createElement("div");
      el.className = "incident";
      const title = document.createElement("div");
      title.className = "incident-title";
      title.textContent = inc.title || "Incydent";
      maybeLangNote(title, inc.translated);
      const tag = document.createElement("div");
      tag.className = "incident-tag " + safeClass(inc.statusKey || "partial");
      tag.textContent = capitalize(statusWord(inc.statusKey || "partial"));
      el.appendChild(title);
      el.appendChild(tag);
      (inc.updates || []).forEach(function (u) {
        const up = document.createElement("div");
        up.className = "update";
        const tm = document.createElement("div");
        tm.className = "update-time";
        tm.textContent = formatTime(u.at);
        const tx = document.createElement("div");
        tx.className = "update-text";
        tx.textContent = u.text || "";
        maybeLangNote(tx, u.translated);
        up.appendChild(tm);
        up.appendChild(tx);
        el.appendChild(up);
      });
      incBox.appendChild(el);
    });
  }

  const link = $("#official-link");
  link.href = svc.officialUrl || "#";
  const checked = currentData && currentData.checkedAt ? formatTime(currentData.checkedAt) : "";
  $("#details-check").textContent = checked ? ("Ostatnie sprawdzenie: " + checked) : "Ostatnie sprawdzenie: —";
  showView("details");
}

function capitalize(s) {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function safeClass(s) {
  return String(s || "unknown").replace(/[^a-z0-9_-]/gi, "");
}

function showView(name) {
  $("#view-home").hidden = name !== "home";
  $("#view-details").hidden = name !== "details";
  closeLegend();
}

function openLegend() {
  $("#legend-overlay").hidden = false;
  $("#legend-sheet").hidden = false;
}
function closeLegend() {
  $("#legend-overlay").hidden = true;
  $("#legend-sheet").hidden = true;
}

function setRefreshing(on) {
  $all(".refresh-btn").forEach(function (btn) {
    btn.classList.toggle("spinning", !!on);
    btn.disabled = !!on;
  });
}

function apiUrl(force) {
  const base = (window.STATUS_AI_API || "").replace(/\/$/, "");
  return base + "/status" + (force ? "?fresh=1" : "");
}

function loadStatus(force) {
  setRefreshing(true);
  const url = apiUrl(force);
  if (!url || url.indexOf("http") !== 0) {
    setRefreshing(false);
    showError("Brak adresu serwera statusu.");
    return;
  }
  fetch(url, {
    cache: force ? "no-store" : "default",
    headers: force ? { "Cache-Control": "no-cache" } : {}
  })
    .then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    })
    .then(function (data) {
      window.__STATUS_DATA__ = data;
      renderHome(data);
      if (activeServiceId && !$("#view-details").hidden) {
        const svc = (data.services || []).find(function (s) { return s.id === activeServiceId; });
        if (svc) renderDetails(svc);
      }
      setRefreshing(false);
    })
    .catch(function (err) {
      setRefreshing(false);
      showError("Nie udało się odświeżyć statusu. Sprawdź połączenie i spróbuj ponownie.");
      if (window.console) console.error(err);
    });
}

function showError(msg) {
  const b = $("#error-banner");
  b.textContent = msg;
  b.hidden = false;
}

function onServiceClick(ev) {
  const id = ev.currentTarget.getAttribute("data-id");
  const svc = ((currentData && currentData.services) || []).find(function (s) { return s.id === id; });
  if (svc) renderDetails(svc);
}

function setupPullToRefresh() {
  const home = $("#view-home");
  let startY = 0;
  let pulling = false;
  home.addEventListener("touchstart", function (e) {
    if ($("#view-home").hidden) return;
    startY = e.touches[0].clientY;
    pulling = true;
  }, { passive: true });
  home.addEventListener("touchend", function (e) {
    if (!pulling) return;
    pulling = false;
    const dy = e.changedTouches[0].clientY - startY;
    if (dy > 70) loadStatus(true);
  }, { passive: true });
}

function boot() {
  $all(".service").forEach(function (el) {
    el.addEventListener("click", onServiceClick);
  });
  $("#legend-btn").addEventListener("click", openLegend);
  $("#legend-overlay").addEventListener("click", closeLegend);
  $("#legend-close").addEventListener("click", closeLegend);
  $("#back-btn").addEventListener("click", function () {
    activeServiceId = null;
    showView("home");
  });
  $all(".refresh-btn").forEach(function (btn) {
    btn.addEventListener("click", function () { loadStatus(true); });
  });
  setupPullToRefresh();
  loadStatus(false);
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(function () { loadStatus(false); }, 120000);
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(function () {});
  }
}

document.addEventListener("DOMContentLoaded", boot);
