const STATE_KEY = "kipuAuto";
const BUILDING_KEY = "kipuBuilding";
const HOST_KEY = "kipuHost";

// Kipu instances live on subdomains of kipuworks.com, which is also what the
// manifest grants access to, so reject anything we couldn't actually run on.
const HOST_SUFFIX = ".kipuworks.com";

// Values match the p_building ids in the occupancy sub-nav.
const BUILDINGS = [
  { id: 6, name: "Aspen" },
  { id: 7, name: "Snowmass" },
  { id: 8, name: "Vail" },
];
const DEFAULT_BUILDING_ID = BUILDINGS[0].id;

const statusEl = document.getElementById("status");
const startBtn = document.getElementById("start");
const stopBtn = document.getElementById("stop");
const siteLabel = document.getElementById("siteLabel");
const siteField = document.getElementById("siteField");
const siteInput = document.getElementById("siteInput");
const siteSave = document.getElementById("siteSave");
const siteError = document.getElementById("siteError");
const changeSite = document.getElementById("changeSite");
const buildingField = document.getElementById("buildingField");
const buildingBtns = Array.from(
  document.querySelectorAll("#buildings button[data-building]")
);
const progressWrap = document.getElementById("progressWrap");
const progressText = document.getElementById("progressText");
const progressBar = document.getElementById("progressBar");

let selectedBuildingId = DEFAULT_BUILDING_ID;
let host = "";
let editingSite = false;

const patientsPrefix = () => `https://${host}/patients`;
const occupancyUrl = () => `https://${host}/occupancy`;

// Accepts "team.kipuworks.com", "https://team.kipuworks.com/patients", etc.
function parseHost(raw) {
  const trimmed = (raw || "").trim().toLowerCase();
  if (!trimmed) return "";
  let parsed;
  try {
    parsed = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
  } catch (_) {
    return "";
  }
  return parsed.hostname.endsWith(HOST_SUFFIX) ? parsed.hostname : "";
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function getState() {
  const data = await chrome.storage.local.get(STATE_KEY);
  return data[STATE_KEY] || { running: false };
}

function buildingName(id) {
  const match = BUILDINGS.find((b) => b.id === Number(id));
  return match ? match.name : "";
}

function renderBuildings() {
  buildingBtns.forEach((btn) => {
    const isActive = Number(btn.dataset.building) === selectedBuildingId;
    btn.classList.toggle("active", isActive);
  });
}

function setStatus(kind, html) {
  statusEl.className = `status ${kind}`;
  statusEl.innerHTML = html;
}

async function refresh() {
  const tab = await getActiveTab();
  const url = tab && tab.url ? tab.url : "";
  const onPatients = Boolean(host) && url.startsWith(patientsPrefix());
  const state = await getState();

  siteLabel.textContent = host || "Not configured";

  if (state.running) {
    const total = (state.queue && state.queue.length) || 0;
    const done = Math.min((state.index || 0) + 1, total || 1);
    const where = state.buildingName ? ` ${state.buildingName}` : "";
    setStatus("run", `Running${where} &mdash; do not close the Kipu tab.`);
    startBtn.style.display = "none";
    stopBtn.style.display = "block";
    siteField.style.display = "none";
    changeSite.style.display = "none";
    buildingField.style.display = "none";
    progressWrap.style.display = "block";
    if (total > 0) {
      progressText.textContent = `Client ${done} of ${total}`;
      progressBar.style.width = `${Math.round((done / total) * 100)}%`;
    } else {
      progressText.textContent = "Collecting client list\u2026";
      progressBar.style.width = "8%";
    }
    return;
  }

  // Not running
  const needsSite = !host || editingSite;
  startBtn.style.display = "block";
  stopBtn.style.display = "none";
  siteField.style.display = needsSite ? "block" : "none";
  changeSite.style.display = needsSite ? "none" : "inline";
  buildingField.style.display = "block";
  progressWrap.style.display = "none";
  renderBuildings();

  if (!host) {
    setStatus("warn", "Enter your Kipu site to get started.");
    startBtn.disabled = true;
  } else if (state.error) {
    setStatus("warn", state.error);
    startBtn.disabled = !onPatients;
  } else if (onPatients) {
    setStatus(
      "ok",
      `You're on the patients page. Ready to run <strong>${buildingName(
        selectedBuildingId
      )}</strong>.`
    );
    startBtn.disabled = false;
  } else {
    setStatus(
      "warn",
      `Please log in and navigate to <code>${patientsPrefix()}</code> first.`
    );
    startBtn.disabled = true;
  }
}

async function saveSite() {
  const parsed = parseHost(siteInput.value);
  if (!parsed) {
    siteError.textContent = `Enter a Kipu address ending in ${HOST_SUFFIX}.`;
    siteError.style.display = "block";
    return;
  }
  siteError.style.display = "none";
  host = parsed;
  editingSite = false;
  siteInput.value = host;
  await chrome.storage.local.set({ [HOST_KEY]: host });
  refresh();
}

siteSave.addEventListener("click", saveSite);
siteInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") saveSite();
});

changeSite.addEventListener("click", (e) => {
  e.preventDefault();
  editingSite = true;
  siteError.style.display = "none";
  refresh();
  siteInput.focus();
  siteInput.select();
});

buildingBtns.forEach((btn) => {
  btn.addEventListener("click", async () => {
    selectedBuildingId = Number(btn.dataset.building);
    renderBuildings();
    await chrome.storage.local.set({ [BUILDING_KEY]: selectedBuildingId });
    refresh();
  });
});

startBtn.addEventListener("click", async () => {
  if (!host) return;
  const tab = await getActiveTab();
  if (!tab || !tab.url || !tab.url.startsWith(patientsPrefix())) {
    setStatus("warn", `You must be on <code>${patientsPrefix()}</code> first.`);
    return;
  }
  await chrome.storage.local.set({
    [STATE_KEY]: {
      running: true,
      phase: "collect",
      queue: [],
      index: 0,
      buildingId: selectedBuildingId,
      buildingName: buildingName(selectedBuildingId),
    },
  });
  await chrome.tabs.update(tab.id, {
    url: `${occupancyUrl()}?p_building=${selectedBuildingId}`,
  });
  window.close();
});

stopBtn.addEventListener("click", async () => {
  await chrome.storage.local.set({ [STATE_KEY]: { running: false } });
  refresh();
});

// Keep the popup in sync while it is open.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[STATE_KEY]) refresh();
});

async function init() {
  const data = await chrome.storage.local.get([BUILDING_KEY, HOST_KEY]);
  const saved = Number(data[BUILDING_KEY]);
  if (BUILDINGS.some((b) => b.id === saved)) selectedBuildingId = saved;
  host = parseHost(data[HOST_KEY]);
  siteInput.value = host;
  renderBuildings();
  refresh();
  setInterval(refresh, 1000);
}

init();
