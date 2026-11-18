/**
 * Status AI — Cloudflare Worker.
 * GET /status — status czterech usług.
 * Cron co 10 minut — porównanie z poprzednim stanem i powiadomienie ntfy przy zmianie.
 */

const NTFY_TOPIC = "status-ai-magda-7bopyo19lm";
const CACHE_SECONDS = 120;
const TIMEZONE = "Europe/Warsaw";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const URLS = {
  openaiSummary: "https://status.openai.com/api/v2/summary.json",
  openaiIncidents: "https://status.openai.com/api/v2/incidents.json",
  xaiStatus: "https://status.x.ai/api/status",
  xaiIncidents: "https://status.x.ai/api/incidents",
  xaiRss: "https://status.x.ai/feed.xml",
  googleIncidents: "https://www.google.com/appsstatus/dashboard/incidents.json",
  googleProducts: "https://www.google.com/appsstatus/dashboard/products.json"
};

const OFFICIAL_URLS = {
  chatgpt: "https://status.openai.com",
  gemini: "https://www.google.com/appsstatus/dashboard",
  grok: "https://status.x.ai",
  grokbot: "https://status.x.ai"
};

const GEMINI_PRODUCT_ID = "npdyhgECDJ6tB66MxXyo";

const SEVERITY = {
  ok: 0,
  planned: 1,
  slow: 2,
  partial: 3,
  major: 4,
  unknown: -1
};

const GROK_COMPONENT_LABELS = {
  "grok.com": "grok.com",
  "grok (ios)": "iOS",
  ios: "iOS",
  "grok (android)": "Android",
  android: "Android",
  "grok in x": "Grok w X",
  imagine: "Imagine",
  voice: "Voice"
};

const CACHE_KEY = new Request("https://status-ai.cache/status");

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/health") {
      return json({ ok: true, name: "status-ai" });
    }
    if (url.pathname !== "/status") {
      return json({ ok: false, error: "not found" }, 404);
    }
    const force =
      url.searchParams.has("fresh") ||
      request.headers.get("Cache-Control") === "no-cache";
    return getStatus(env, ctx, force);
  },

  async scheduled(event, env, ctx) {
    await checkAndNotify(env, ctx);
  }
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Cache-Control",
    "Access-Control-Max-Age": "86400"
  };
}

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": extra.cacheControl || "no-store",
      ...corsHeaders()
    }
  });
}

async function getStatus(env, ctx, force) {
  const cache = caches.default;
  if (!force) {
    const hit = await cache.match(CACHE_KEY);
    if (hit) {
      const headers = new Headers(hit.headers);
      for (const [k, v] of Object.entries(corsHeaders())) headers.set(k, v);
      return new Response(hit.body, { status: hit.status, headers });
    }
  }
  const payload = await fetchAllStatuses(env);
  const res = json(payload, 200, { cacheControl: "public, max-age=" + CACHE_SECONDS });
  ctx.waitUntil(cache.put(CACHE_KEY, res.clone()));
  return res;
}

async function checkAndNotify(env, ctx) {
  const payload = await fetchAllStatuses(env);
  const raw = await env.STATUS_AI_STATE.get("last_states");
  let previous = {};
  if (raw) {
    try {
      previous = JSON.parse(raw);
    } catch {
      previous = {};
    }
  }
  const next = {};
  const services = payload.services || [];
  const hadPrevious = Object.keys(previous).length > 0;
  for (const svc of services) {
    next[svc.id] = svc.status;
    const prev = previous[svc.id];
    if (!hadPrevious || !prev || prev === svc.status) continue;
    const worse = isWorse(svc.status, prev);
    const recovered = prev !== "ok" && prev !== "unknown" && svc.status === "ok";
    const msg = buildNotifyMessage(svc, prev);
    await sendNtfy({
      title: "Status AI — " + svc.name,
      message: msg,
      priority: notifyPriority(svc.status, worse, recovered),
      click: svc.officialUrl || "",
      tags: recovered ? "white_check_mark" : svc.status === "major" ? "rotating_light" : "warning"
    });
  }
  await env.STATUS_AI_STATE.put("last_states", JSON.stringify(next));
  const res = json(payload, 200, { cacheControl: "public, max-age=" + CACHE_SECONDS });
  ctx.waitUntil(caches.default.put(CACHE_KEY, res.clone()));
}

async function fetchAllStatuses(env) {
  const urls = [
    URLS.openaiSummary,
    URLS.openaiIncidents,
    URLS.xaiStatus,
    URLS.xaiIncidents,
    URLS.googleIncidents,
    URLS.googleProducts
  ];
  const responses = await Promise.all(urls.map((u) => httpGet(u)));
  const openaiSummary = await readJson(responses[0]);
  const openaiIncidents = await readJson(responses[1]);
  const xaiStatus = await readJson(responses[2]);
  const xaiIncidents = await readJson(responses[3]);
  let xaiRssText = null;
  if (!xaiIncidents.ok) {
    const rss = await httpGet(URLS.xaiRss, "application/xml, text/xml, */*");
    if (rss && rss.ok) {
      try {
        xaiRssText = await rss.text();
      } catch {
        xaiRssText = null;
      }
    }
  }
  const googleIncidents = await readJson(responses[4]);
  const googleProducts = await readJson(responses[5]);

  const chatgpt = parseOpenAI(openaiSummary, openaiIncidents);
  const xai = parseXai(xaiStatus, xaiIncidents, xaiRssText);
  const gemini = parseGemini(googleIncidents, googleProducts);
  const services = [chatgpt, gemini, xai.grok, xai.grokbot];

  const translation = await translatePayload(env, services);
  return {
    checkedAt: new Date().toISOString(),
    services,
    translation
  };
}

async function httpGet(url, accept) {
  try {
    return await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: accept || "application/json, application/xml, text/xml, */*"
      }
    });
  } catch {
    return null;
  }
}

async function readJson(response) {
  if (!response) return { ok: false, error: "brak odpowiedzi", data: null };
  try {
    if (!response.ok) return { ok: false, error: "HTTP " + response.status, data: null };
    const data = await response.json();
    return { ok: true, error: null, data };
  } catch (e) {
    return { ok: false, error: String(e), data: null };
  }
}

function emptyService(id, name, officialUrl) {
  return {
    id,
    name,
    status: "unknown",
    officialUrl,
    components: [],
    incidents: [],
    notes: []
  };
}

function parseOpenAI(summaryRes, incidentsRes) {
  const svc = emptyService("chatgpt", "ChatGPT", OFFICIAL_URLS.chatgpt);
  if (!summaryRes.ok && !incidentsRes.ok) {
    svc.notes.push("Nie udało się pobrać statusu OpenAI.");
    return svc;
  }
  const summary = (summaryRes.ok && summaryRes.data) || {};
  const components = summary.components || [];
  svc.components = components.map((c) => ({
    name: c.name || "Komponent",
    status: mapStatuspageComponent(c.status)
  }));
  const indicator = summary.status && summary.status.indicator;
  let worst = mapStatuspageIndicator(indicator);
  for (const c of svc.components) worst = worseStatus(worst, c.status);

  const incData = (incidentsRes.ok && incidentsRes.data) || {};
  const list = incData.incidents || summary.incidents || [];
  const maints = summary.scheduled_maintenances || [];
  svc.incidents = [];
  for (const inc of list) {
    if (isResolvedStatuspage(inc.status)) continue;
    const impactStatus = mapStatuspageImpact(inc.impact);
    worst = worseStatus(worst, impactStatus);
    svc.incidents.push(normalizeStatuspageIncident(inc));
  }
  for (const m of maints) {
    const st = String(m.status || "").toLowerCase();
    if (st !== "in_progress" && st !== "investigating") continue;
    worst = worseStatus(worst, "planned");
    svc.incidents.push({
      title: m.name || "Zaplanowane prace",
      statusKey: "planned",
      translated: false,
      updates: (m.incident_updates || m.updates || []).map((u) => ({
        at: u.display_at || u.created_at || u.updated_at || "",
        text: u.body || u.text || "",
        translated: false
      }))
    });
  }
  if (svc.components.length) {
    svc.status = worst === "unknown" ? "ok" : worst;
  } else if (svc.incidents.length) {
    svc.status = worst || "ok";
  } else {
    svc.status = summaryRes.ok ? "ok" : "unknown";
  }
  return svc;
}

function normalizeStatuspageIncident(inc) {
  const updates = (inc.incident_updates || inc.updates || []).map((u) => ({
    at: u.display_at || u.created_at || u.updated_at || "",
    text: u.body || u.text || "",
    translated: false
  }));
  return {
    title: inc.name || inc.title || "Incydent",
    statusKey: mapStatuspageIncidentStatus(inc.status, inc.impact),
    translated: false,
    updates
  };
}

function isResolvedStatuspage(status) {
  const s = String(status || "").toLowerCase();
  return s === "resolved" || s === "postmortem" || s === "completed" || s === "cancelled";
}

function mapStatuspageComponent(status) {
  switch (String(status || "").toLowerCase()) {
    case "operational":
      return "ok";
    case "degraded_performance":
      return "slow";
    case "partial_outage":
      return "partial";
    case "major_outage":
      return "major";
    case "under_maintenance":
      return "planned";
    default:
      return "unknown";
  }
}

function mapStatuspageIndicator(indicator) {
  switch (String(indicator || "").toLowerCase()) {
    case "none":
      return "ok";
    case "minor":
      return "slow";
    case "major":
      return "partial";
    case "critical":
      return "major";
    case "maintenance":
      return "planned";
    default:
      return "unknown";
  }
}

function mapStatuspageImpact(impact) {
  switch (String(impact || "").toLowerCase()) {
    case "none":
      return "slow";
    case "minor":
      return "slow";
    case "major":
      return "partial";
    case "critical":
      return "major";
    case "maintenance":
      return "planned";
    default:
      return "slow";
  }
}

function mapStatuspageIncidentStatus(status, impact) {
  if (String(status || "").toLowerCase() === "maintenance") return "planned";
  return mapStatuspageImpact(impact);
}

function parseXai(statusRes, incidentsRes, rssText) {
  const grok = emptyService("grok", "Grok", OFFICIAL_URLS.grok);
  const grokbot = emptyService("grokbot", "Grok Bot", OFFICIAL_URLS.grokbot);
  if (!statusRes.ok && !incidentsRes.ok && !rssText) {
    grok.notes.push("Nie udało się pobrać statusu xAI.");
    grokbot.notes.push("Nie udało się pobrać statusu xAI.");
    return { grok, grokbot };
  }
  const data = (statusRes.ok && statusRes.data) || {};
  const products = data.products || [];
  fillXaiProduct(grok, findProduct(products, "grok", "Grok"));
  fillXaiProduct(grokbot, findProduct(products, "grok-bot", "Grok Bot"));

  let incidents = [];
  if (incidentsRes.ok && incidentsRes.data) {
    incidents = extractXaiIncidents(incidentsRes.data);
  } else if (rssText) {
    incidents = parseXaiRss(rssText);
  }
  attachXaiIncidents(grok, incidents, "grok");
  attachXaiIncidents(grokbot, incidents, "grokbot");
  if (!statusRes.ok && !grok.incidents.length && grok.status === "unknown") {
    grok.notes.push("Nie udało się pobrać bieżącego statusu komponentów.");
  }
  if (!statusRes.ok && !grokbot.incidents.length && grokbot.status === "unknown") {
    grokbot.notes.push("Nie udało się pobrać bieżącego statusu komponentów.");
  }
  return { grok, grokbot };
}

function findProduct(products, id, name) {
  const idl = String(id).toLowerCase();
  const namel = String(name).toLowerCase();
  for (const p of products) {
    if (String(p.id || "").toLowerCase() === idl) return p;
  }
  for (const p of products) {
    if (String(p.name || "").toLowerCase() === namel) return p;
  }
  return null;
}

function fillXaiProduct(svc, product) {
  if (!product) return;
  const comps = product.components || [];
  svc.components = comps.map((c) => ({
    name: labelXaiComponent(c.name || c.id || "Komponent"),
    status: mapXaiStatus(c.status)
  }));
  let worst = mapXaiStatus(product.status);
  for (const c of svc.components) worst = worseStatus(worst, c.status);
  svc.status = worst === "unknown" && svc.components.length ? "ok" : worst;
}

function labelXaiComponent(name) {
  const key = String(name || "").toLowerCase().trim();
  if (GROK_COMPONENT_LABELS[key]) return GROK_COMPONENT_LABELS[key];
  for (const k in GROK_COMPONENT_LABELS) {
    if (key.indexOf(k) !== -1) return GROK_COMPONENT_LABELS[k];
  }
  return name;
}

function mapXaiStatus(status) {
  const s = String(status || "")
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (!s) return "unknown";
  if (["available", "operational", "ok", "up", "normal", "healthy"].indexOf(s) !== -1) return "ok";
  if (["degraded", "degraded_performance", "slow", "delayed"].indexOf(s) !== -1) return "slow";
  if (["disruption", "partial", "partial_outage", "degraded_outage"].indexOf(s) !== -1) return "partial";
  if (["outage", "major_outage", "unavailable", "down", "major", "critical"].indexOf(s) !== -1) return "major";
  if (["maintenance", "under_maintenance", "planned", "in_progress"].indexOf(s) !== -1) return "planned";
  if (["info", "information"].indexOf(s) !== -1) return "slow";
  return "unknown";
}

function extractXaiIncidents(data) {
  const list = data.incidents || data || [];
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const inc of list) {
    const status = String(inc.status || inc.state || "").toLowerCase();
    if (isResolvedStatuspage(status) || status === "resolved") continue;
    const resolvedAt = inc.resolved_at || inc.resolved || inc.ended_at || inc.end;
    if (resolvedAt) continue;
    out.push({
      title: inc.title || inc.name || inc.summary || "Incydent",
      statusKey: mapXaiStatus(inc.severity || inc.impact || inc.status),
      product: inc.product || inc.product_id || inc.productId || "",
      component: inc.component || inc.component_id || inc.componentId || "",
      updates: normalizeXaiUpdates(inc),
      translated: false
    });
  }
  return out;
}

function normalizeXaiUpdates(inc) {
  const raw = inc.updates || inc.incident_updates || inc.history || [];
  if (!Array.isArray(raw)) return [];
  return raw.map((u) => ({
    at: u.at || u.display_at || u.created_at || u.updated_at || u.time || u.when || "",
    text: u.body || u.text || u.message || u.description || "",
    translated: false
  }));
}

function attachXaiIncidents(svc, incidents, kind) {
  for (const inc of incidents) {
    if (!incidentBelongsTo(inc, kind)) continue;
    svc.incidents.push({
      title: inc.title,
      statusKey: inc.statusKey,
      translated: false,
      updates: inc.updates || []
    });
    svc.status = worseStatus(svc.status === "unknown" ? "ok" : svc.status, inc.statusKey);
  }
}

function incidentBelongsTo(inc, kind) {
  const blob = [inc.product, inc.component, inc.title, inc.link].join(" ").toLowerCase();
  if (kind === "grokbot") {
    return blob.indexOf("grok bot") !== -1 || blob.indexOf("grok-bot") !== -1 || blob.indexOf("grokbot") !== -1;
  }
  if (blob.indexOf("grok bot") !== -1 || blob.indexOf("grok-bot") !== -1) return false;
  if (blob.indexOf("cursor") !== -1) return false;
  if (/grok|imagine|voice|grok\.com|grok in x/.test(blob)) return true;
  return false;
}

function parseXaiRss(xml) {
  const out = [];
  if (!xml) return out;
  const items = String(xml).split(/<item>/i);
  for (let i = 1; i < items.length; i++) {
    const chunk = items[i].split(/<\/item>/i)[0];
    const title = decodeXml(rssTag(chunk, "title"));
    const link = decodeXml(rssTag(chunk, "link"));
    const pubDate = rssTag(chunk, "pubDate");
    const desc = rssTag(chunk, "description");
    const categories = rssTags(chunk, "category").map((c) => String(c).toLowerCase());
    const descText = decodeXml(desc);
    const statusMatch = descText.match(/Status:\s*([A-Za-z_]+)/i);
    const severityMatch = descText.match(/Severity:\s*([A-Za-z_]+)/i);
    const statusWord = (statusMatch && statusMatch[1]) || "";
    if (categories.indexOf("resolved") !== -1 || String(statusWord).toLowerCase() === "resolved") continue;
    const updates = parseRssUpdates(descText);
    if (!updates.length && pubDate) updates.push({ at: pubDate, text: title, translated: false });
    out.push({
      title,
      statusKey: mapXaiStatus((severityMatch && severityMatch[1]) || categories[0] || "disruption"),
      product: title,
      component: title,
      link,
      updates,
      translated: false
    });
  }
  return out;
}

function rssTag(chunk, tag) {
  const re = new RegExp("<" + tag + "[^>]*>([\\s\\S]*?)</" + tag + ">", "i");
  const m = chunk.match(re);
  return m ? m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, "$1").trim() : "";
}

function rssTags(chunk, tag) {
  const re = new RegExp("<" + tag + "[^>]*>([\\s\\S]*?)</" + tag + ">", "gi");
  const out = [];
  let m;
  while ((m = re.exec(chunk))) {
    out.push(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, "$1").trim());
  }
  return out;
}

function decodeXml(s) {
  return String(s || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseRssUpdates(descText) {
  const updates = [];
  const re =
    /(?:^|\s)((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{1,2} \w+ \d{4} \d{2}:\d{2}:\d{2} GMT)\s+([A-Za-z ]+)\s+([\s\S]*?)(?=(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{1,2} \w+ \d{4} \d{2}:\d{2}:\d{2} GMT|$)/g;
  let m;
  while ((m = re.exec(descText))) {
    const text = (m[3] || "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    updates.push({ at: m[1], text, translated: false });
  }
  return updates;
}

function parseGemini(incidentsRes, productsRes) {
  const svc = emptyService("gemini", "Gemini", OFFICIAL_URLS.gemini);
  svc.notes.push(
    "Google podaje mniej szczegółów niż inne strony statusu — nie ma pełnej listy komponentów."
  );
  if (!incidentsRes.ok) {
    svc.notes.push("Nie udało się pobrać pulitu statusu Google Workspace.");
    return svc;
  }
  let geminiId = GEMINI_PRODUCT_ID;
  const productsWrapper = (productsRes.ok && productsRes.data) || {};
  const products = productsWrapper.products || (Array.isArray(productsWrapper) ? productsWrapper : []);
  for (const p of products) {
    if (String(p.title || p.name || "") === "Gemini") {
      geminiId = p.id || geminiId;
      break;
    }
  }
  const list = Array.isArray(incidentsRes.data)
    ? incidentsRes.data
    : incidentsRes.data.incidents || [];
  const ongoing = [];
  for (const inc of list) {
    if (!incidentAffectsGemini(inc, geminiId)) continue;
    if (hasEnded(inc.end)) continue;
    ongoing.push(inc);
  }
  if (!ongoing.length) {
    svc.status = "ok";
    svc.components = [{ name: "Gemini", status: "ok" }];
    return svc;
  }
  let worst = "ok";
  for (const inc of ongoing) {
    const st = mapGoogleImpact(inc.status_impact, inc.severity);
    worst = worseStatus(worst, st);
    svc.incidents.push(normalizeGoogleIncident(inc));
  }
  svc.status = worst;
  svc.components = [{ name: "Gemini", status: worst }];
  return svc;
}

function incidentAffectsGemini(inc, geminiId) {
  if (String(inc.service_key || "") === geminiId) return true;
  if (String(inc.service_name || "") === "Gemini") return true;
  const ap = inc.affected_products || [];
  for (const p of ap) {
    if (!p) continue;
    if (typeof p === "string" && p === "Gemini") return true;
    if (p.id === geminiId || p.title === "Gemini" || p.name === "Gemini") return true;
  }
  return false;
}

function hasEnded(end) {
  if (end === null || end === undefined || end === "") return false;
  return true;
}

function mapGoogleImpact(impact, severity) {
  const imp = String(impact || "").toUpperCase();
  if (imp === "SERVICE_OUTAGE") return "major";
  if (imp === "SERVICE_DISRUPTION") return "partial";
  if (imp === "SERVICE_INFORMATION") return "slow";
  const sev = String(severity || "").toLowerCase();
  if (sev === "high" || sev === "critical") return "major";
  if (sev === "medium") return "partial";
  if (sev === "low") return "slow";
  return "slow";
}

function normalizeGoogleIncident(inc) {
  const title = extractGoogleTitle(inc.external_desc) || inc.service_name || "Incydent Gemini";
  const updates = (inc.updates || []).map((u) => ({
    at: u.when || u.created || u.modified || "",
    text: cleanMarkdown(u.text || ""),
    translated: false
  }));
  return { title, statusKey: mapGoogleImpact(inc.status_impact, inc.severity), translated: false, updates };
}

function extractGoogleTitle(desc) {
  const text = String(desc || "");
  const m =
    text.match(/\*\*Title\*\*\s*[:\n]*\s*([^\n*]+)/i) ||
    text.match(/\*\*Summary:\*\*\s*[:\n]*\s*([^\n*]+)/i) ||
    text.match(/\*\*Summary\*\*\s*[:\n]*\s*([^\n*]+)/i);
  if (m) return m[1].trim();
  const first = text
    .replace(/\*\*/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)[0];
  return first || "";
}

function cleanMarkdown(text) {
  return String(text || "")
    .replace(/\*\*/g, "")
    .replace(/^#+\s+/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function translatePayload(env, services) {
  const meta = { available: false, model: null, error: null };
  let available = await env.STATUS_AI_STATE.get("translate_ok");
  if (available === "0") {
    meta.error = "disabled";
    return meta;
  }
  if (available !== "1") {
    const probe = await translateToPl(env, "All systems operational.");
    if (probe.ok) {
      await env.STATUS_AI_STATE.put("translate_ok", "1");
      available = "1";
      meta.probe = probe.text;
    } else {
      await env.STATUS_AI_STATE.put("translate_ok", "0", { expirationTtl: 3600 });
      meta.available = false;
      meta.error = probe.error || "unavailable";
      return meta;
    }
  }
  meta.available = true;
  meta.model = "@cf/meta/m2m100-1.2b";
  for (const svc of services) {
    for (const inc of svc.incidents || []) {
      const t = await translateToPl(env, inc.title);
      if (t.ok) {
        inc.title = t.text;
        inc.translated = true;
      }
      for (const u of inc.updates || []) {
        const ut = await translateToPl(env, u.text);
        if (ut.ok) {
          u.text = ut.text;
          u.translated = true;
        }
      }
    }
  }
  return meta;
}

async function translateToPl(env, text) {
  const src = String(text || "").trim();
  if (!src) return { ok: true, text: src };
  if (!env.AI) return { ok: false, text: src, error: "no AI binding" };
  const key = "tr:" + (await sha12(src));
  try {
    const hit = await env.STATUS_AI_STATE.get(key);
    if (hit) return { ok: true, text: hit };
  } catch {
    /* ignore */
  }
  const attempts = [
    { source_lang: "english", target_lang: "polish" },
    { source_lang: "en", target_lang: "pl" }
  ];
  let lastErr = "no result";
  for (const langs of attempts) {
    try {
      const res = await env.AI.run("@cf/meta/m2m100-1.2b", {
        text: src,
        source_lang: langs.source_lang,
        target_lang: langs.target_lang
      });
      const out =
        (res && (res.translated_text || res.translation || (res.result && res.result.translated_text))) ||
        (typeof res === "string" ? res : null);
      if (out && String(out).trim()) {
        const textOut = String(out).trim();
        try {
          await env.STATUS_AI_STATE.put(key, textOut);
        } catch {
          /* ignore */
        }
        return { ok: true, text: textOut };
      }
      lastErr = "empty";
    } catch (err) {
      lastErr = String(err && err.message ? err.message : err);
    }
  }
  return { ok: false, text: src, error: lastErr };
}

async function sha12(text) {
  const data = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(buf);
  let hex = "";
  for (let i = 0; i < 8; i++) hex += bytes[i].toString(16).padStart(2, "0");
  return hex;
}

async function sendNtfy(opts) {
  const url = "https://ntfy.sh/" + encodeURIComponent(NTFY_TOPIC);
  const headers = {
    "User-Agent": USER_AGENT,
    Title: opts.title || "Status AI",
    Priority: String(opts.priority || 3)
  };
  if (opts.tags) headers.Tags = opts.tags;
  if (opts.click) headers.Click = opts.click;
  const res = await fetch(url, { method: "POST", headers, body: opts.message || "" });
  return res.status;
}

function buildNotifyMessage(svc, prev) {
  const now = statusLabel(svc.status);
  const was = statusLabel(prev);
  if (svc.status === "ok") {
    return svc.name + ": znowu działa (wcześniej: " + was + ").";
  }
  let msg = svc.name + ": " + was + " → " + now + ".";
  if (svc.incidents && svc.incidents[0] && svc.incidents[0].title) {
    msg += " " + svc.incidents[0].title;
  }
  return msg;
}

function statusLabel(key) {
  switch (key) {
    case "ok":
      return "działa";
    case "slow":
      return "spowolnienie";
    case "partial":
      return "częściowa awaria";
    case "major":
      return "poważna awaria";
    case "planned":
      return "zaplanowane prace";
    default:
      return "brak danych";
  }
}

function notifyPriority(status, worse, recovered) {
  if (status === "major") return 5;
  if (status === "partial") return 4;
  if (recovered) return 3;
  if (worse) return 4;
  return 3;
}

function isWorse(now, prev) {
  const a = SEVERITY[now] == null ? -1 : SEVERITY[now];
  const b = SEVERITY[prev] == null ? -1 : SEVERITY[prev];
  if (a < 0) return false;
  return a > b;
}

function worseStatus(a, b) {
  const sa = SEVERITY[a];
  const sb = SEVERITY[b];
  const va = sa == null || sa < 0 ? -2 : sa;
  const vb = sb == null || sb < 0 ? -2 : sb;
  if (va < 0 && vb < 0) return "unknown";
  if (va < 0) return b;
  if (vb < 0) return a;
  return va >= vb ? a : b;
}
