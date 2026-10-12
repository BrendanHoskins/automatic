(() => {
  "use strict";

  // Only drive automation from the top frame.
  if (window.top !== window) return;

  // Whichever Kipu instance this page belongs to; the popup decides which host
  // a run starts on, so we just stay on the current origin.
  const BASE = window.location.origin;
  const STATE_KEY = "kipuAuto";
  const LOG = "[KipuShiftNote]";

  // ---- state helpers ---------------------------------------------------------

  async function getState() {
    const data = await chrome.storage.local.get(STATE_KEY);
    return data[STATE_KEY] || { running: false };
  }

  async function setState(patch) {
    const cur = await getState();
    const next = { ...cur, ...patch };
    await chrome.storage.local.set({ [STATE_KEY]: next });
    return next;
  }

  // ---- generic utils ---------------------------------------------------------

  function normalize(s) {
    return (s || "")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  // Section titles carry trailing punctuation/whitespace ("ADLS: ", "Mood: ").
  function normTitle(s) {
    return normalize(s).replace(/[:*\s]+$/g, "").trim();
  }

  function waitFor(fn, timeout = 12000, interval = 200) {
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        let result = null;
        try {
          result = fn();
        } catch (_) {
          result = null;
        }
        if (result) return resolve(result);
        if (Date.now() - start >= timeout) return resolve(null);
        setTimeout(tick, interval);
      };
      tick();
    });
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function todayMMDDYYYY() {
    const d = new Date();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${mm}/${dd}/${d.getFullYear()}`;
  }

  const recordsUrl = (id) => `${BASE}/patients/${id}/records?process=88`;

  // ---- step: switch the occupancy board to the chosen building ---------------

  function buildingIdFrom(str) {
    const m = (str || "").match(/[?&]p_building=(\d+)/);
    return m ? Number(m[1]) : null;
  }

  function subNavLink(buildingId) {
    const links = document.querySelectorAll(
      '[data-occupancy-sub-nav] a[href*="p_building="]'
    );
    for (const a of links) {
      if (buildingIdFrom(a.getAttribute("href")) === buildingId) return a;
    }
    return null;
  }

  // Which building's list is on screen right now, per the sub-nav's active tab.
  // Falls back to the query string for loads where the sub-nav isn't rendered.
  function activeBuildingId() {
    const active = document.querySelector(
      '[data-occupancy-sub-nav] li.active a[href*="p_building="]'
    );
    if (active) return buildingIdFrom(active.getAttribute("href"));
    if (document.querySelector("[data-occupancy-sub-nav]")) return null;
    return buildingIdFrom(window.location.search);
  }

  // The sub-nav tabs are data-remote links, so clicking one swaps the bed list
  // over AJAX without a page load. Resolves true once the chosen building's
  // list is the one on screen.
  async function selectBuilding(buildingId, buildingName) {
    if (!buildingId) return true;

    // Give the sub-nav a chance to render so we judge by its active tab rather
    // than the URL, which Kipu may ignore.
    await waitFor(() => activeBuildingId(), 8000);
    if (activeBuildingId() === buildingId) return true;

    const link = subNavLink(buildingId);
    if (!link) {
      console.warn(LOG, `Could not find the ${buildingName} tab on the board.`);
      return false;
    }

    console.log(LOG, `Switching occupancy list to ${buildingName}.`);
    const previousBeds = document.querySelector("#assigned_beds");
    link.click();

    // Kipu may re-render the sub-nav, the bed list, or both. Treat either the
    // active tab moving or the bed table being replaced as the swap landing.
    const switched = await waitFor(() => {
      if (activeBuildingId() === buildingId) return true;
      const beds = document.querySelector("#assigned_beds");
      return beds && previousBeds && beds !== previousBeds ? true : null;
    }, 15000);
    if (!switched) {
      console.warn(LOG, `The ${buildingName} list did not load.`);
      return false;
    }

    // The active tab can flip before the replacement bed list lands, so give
    // the old table a chance to be swapped out before reading rows.
    await waitFor(
      () => {
        const beds = document.querySelector("#assigned_beds");
        return beds && beds !== previousBeds ? true : null;
      },
      4000,
      200
    );
    await sleep(500);
    return true;
  }

  // ---- step: collect client ids from the occupancy board ---------------------

  function collectPatientIds() {
    const anchors = document.querySelectorAll(
      '#assigned_beds a[href*="/patients/"]'
    );
    const ids = [];
    const seen = new Set();
    anchors.forEach((a) => {
      const href = a.getAttribute("href") || "";
      const m = href.match(/\/patients\/(\d+)(?:[/?#]|$)/);
      if (m && !seen.has(m[1])) {
        seen.add(m[1]);
        ids.push(m[1]);
      }
    });
    return ids;
  }

  async function doCollect(state) {
    // Wait for the document to finish loading first.
    await waitFor(() => (document.readyState === "complete" ? true : null), 8000);

    // Make sure we're reading the building the user picked. Bail out rather
    // than risk writing shift notes for the wrong unit's clients.
    const buildingName = state.buildingName || "the selected building";

    // If clicking a tab triggers a real navigation instead of the AJAX swap,
    // this step reruns on the fresh page; cap it so it can't loop forever.
    const attempts = (state.collectAttempts || 0) + 1;
    await setState({ collectAttempts: attempts });
    if (attempts > 3) {
      await setState({
        running: false,
        phase: "done",
        error: `Could not open the ${buildingName} occupancy list.`,
      });
      return;
    }

    if (!(await selectBuilding(state.buildingId, buildingName))) {
      await setState({
        running: false,
        phase: "done",
        error: `Could not open the ${buildingName} occupancy list.`,
      });
      return;
    }

    // The occupancy board can hydrate rows progressively, so grabbing the list
    // on the first non-empty poll can miss the last row. Wait until the detected
    // client count stays the same across several consecutive polls.
    let ids = [];
    let lastCount = -1;
    let stablePolls = 0;
    await waitFor(
      () => {
        const found = collectPatientIds();
        ids = found;
        if (found.length && found.length === lastCount) {
          stablePolls += 1;
        } else {
          stablePolls = 0;
          lastCount = found.length;
        }
        return stablePolls >= 4 ? found : null; // stable for ~1s
      },
      15000,
      250
    );

    if (!ids.length) ids = collectPatientIds();

    if (!ids.length) {
      console.warn(LOG, `No clients found on the ${buildingName} list. Stopping.`);
      await setState({
        running: false,
        phase: "done",
        error: `No clients found on the ${buildingName} occupancy list.`,
      });
      return;
    }

    console.log(LOG, `Found ${ids.length} clients in ${buildingName}:`, ids);
    await setState({ queue: ids, index: 0, phase: "opening_form" });
    window.location.href = recordsUrl(ids[0]);
  }

  // ---- step: open the "New Shift Note" form ----------------------------------

  // The modal link that CREATES a brand new shift note (add_evaluation).
  function findAddNewShiftNoteLink() {
    const links = document.querySelectorAll('a[href*="add_evaluation"]');
    for (const a of links) {
      const text = normalize(a.textContent);
      if (text.startsWith("new shift note")) return a;
    }
    return null;
  }

  // Existing "New Shift Note" rows already in the shift-notes list, each with an
  // edit link like /patients/{pid}/patient_evaluations/{eid}/edit.
  function findShiftNoteEditLinks() {
    const links = document.querySelectorAll(
      'a.forms_app__edit_patient_evaluation_link, a[href*="/patient_evaluations/"][href*="/edit"]'
    );
    const results = [];
    links.forEach((a) => {
      const href = a.getAttribute("href") || "";
      const m = href.match(/\/patient_evaluations\/(\d+)\/edit/);
      if (!m) return;
      const nameEl = a.querySelector(".evaluation-name");
      const name = normalize(
        nameEl
          ? nameEl.getAttribute("data-text") || nameEl.textContent
          : a.textContent
      );
      if (name.startsWith("new shift note")) {
        results.push({ id: m[1], href: a.href });
      }
    });
    return results;
  }

  // Pick the shift note we just created: prefer an id that wasn't present before
  // creating; otherwise fall back to the newest (highest) id.
  function pickNewShiftNoteEditLink(preExistingIds) {
    const all = findShiftNoteEditLinks();
    if (!all.length) return null;
    const pre = new Set((preExistingIds || []).map(String));
    const fresh = all.filter((x) => !pre.has(String(x.id)));
    const pool = fresh.length ? fresh : all;
    pool.sort((a, b) => Number(b.id) - Number(a.id));
    return pool[0];
  }

  async function doOpenForm(state) {
    // Remember which shift notes already exist so we can identify the new one.
    const preExistingEvalIds = findShiftNoteEditLinks().map((x) => x.id);

    // 1. Click "Add form" to open the forms modal.
    const addForm = await waitFor(
      () => document.querySelector('.open-modal-cancel[name="addform"]'),
      12000
    );
    if (!addForm) return skipPatient(state, 'could not find "Add form"');
    addForm.click();

    // 2. Wait for the modal, then follow the "New Shift Note" (create) link.
    //    This creates the note and returns to the shift-notes list.
    const link = await waitFor(() => findAddNewShiftNoteLink(), 12000);
    if (!link) return skipPatient(state, 'could not find "New Shift Note"');

    await setState({ phase: "open_edit", preExistingEvalIds });
    window.location.href = link.href;
  }

  // After creating, open the new note's edit form so we can fill the bubbles.
  async function doOpenEdit(state) {
    const path = window.location.pathname;

    // If creating dropped us straight onto the edit form, just fill it.
    if (!/^\/patients\/\d+\/records/.test(path)) {
      await doFill(state);
      return;
    }

    // Otherwise we're back on the shift-notes list: click the new note's edit link.
    const link = await waitFor(
      () => pickNewShiftNoteEditLink(state.preExistingEvalIds || []),
      12000
    );
    if (!link) {
      return skipPatient(state, "could not find the new shift note edit link");
    }
    await setState({ phase: "filling" });
    window.location.href = link.href;
  }

  // ---- checkbox profiles per building ----------------------------------------
  //
  // Keys are section titles as they appear on the form; values are the option
  // labels that should end up checked in that section (and nothing else).

  const SHARED_SELECTIONS = {
    "ADLS:": ["Bathing", "Grooming", "Neat", "Clean"],
    "Appetite:": ["Within Normal Limits"],
    "Behavior:": ["Cooperative", "Restless"],
    "Thinking:": ["Black & White Thinking", "Negativity"],
    "Eye Contact:": ["Appropriate"],
    "Affect:": ["Appropriate"],
    "Mood:": ["Euthymic", "Anxious"],
    "Speech:": ["Appropriate"],
    "Orientation:": ["Time, Person, Place, and Situation"],
    "Insight:": ["Good"],
    "Risk Thoughts/Behaviors:": ["None Reported"],
    "Additional Information about Risk Thoughts and Behaviors:": ["None"],
    "Current Craving Level:": ["8"],
  };

  // Where cravings get recorded is the only thing that differs by building.
  const CRAVINGS_UNDER_PAW = {
    "Withdrawal and Detox Symptoms:": ["None"],
    "PAW Symptoms:": ["Cravings", "Lack of Energy"],
  };
  const CRAVINGS_UNDER_WITHDRAWAL = {
    "Withdrawal and Detox Symptoms:": ["Cravings", "Lack of Energy"],
    "PAW Symptoms:": ["None"],
  };

  // Keyed by the occupancy board's p_building id (see BUILDINGS in popup.js).
  const PROFILE_BY_BUILDING = {
    6: { ...SHARED_SELECTIONS, ...CRAVINGS_UNDER_PAW }, // Aspen
    7: { ...SHARED_SELECTIONS, ...CRAVINGS_UNDER_WITHDRAWAL }, // Snowmass
    8: { ...SHARED_SELECTIONS, ...CRAVINGS_UNDER_PAW }, // Vail
  };

  function profileFor(buildingId) {
    return PROFILE_BY_BUILDING[Number(buildingId)] || null;
  }

  // ---- step: fill and submit the form ----------------------------------------

  function findSection(titleText) {
    const wantTitle = normTitle(titleText);
    const items = document.querySelectorAll(".patient_evaluation_item");
    for (const item of items) {
      const titleEl = item.querySelector(".item_title");
      if (titleEl && normTitle(titleEl.textContent) === wantTitle) return item;
    }
    return null;
  }

  function checkboxForLabel(label) {
    const cb = label.htmlFor
      ? document.getElementById(label.htmlFor)
      : label.closest(".wrap")?.querySelector('input[type="checkbox"]');
    return cb && cb.type === "checkbox" ? cb : null;
  }

  // Make a section's checked boxes exactly match labelTexts. Kipu pre-checks
  // defaults like "None", so anything not in the list is unchecked too;
  // otherwise "None" could sit alongside real symptoms.
  function setSection(titleText, labelTexts) {
    const section = findSection(titleText);
    if (!section) {
      console.warn(LOG, "Section not found:", titleText);
      return;
    }

    const wanted = new Set(labelTexts.map(normalize));
    const found = new Set();
    section.querySelectorAll("label").forEach((label) => {
      const cb = checkboxForLabel(label);
      if (!cb) return;
      const text = normalize(label.textContent);
      const shouldCheck = wanted.has(text);
      if (cb.checked !== shouldCheck) cb.checked = shouldCheck;
      if (shouldCheck) found.add(text);
    });

    labelTexts.forEach((wantedLabel) => {
      if (!found.has(normalize(wantedLabel))) {
        console.warn(LOG, `Option not found: ${titleText} > ${wantedLabel}`);
      }
    });
  }

  function dateField() {
    return document.querySelector(
      '#patient_evaluation_evaluation_date, input[name="patient_evaluation[evaluation_date]"]'
    );
  }

  function setDateField() {
    const el = dateField();
    if (!el) {
      console.warn(LOG, "Date field not found.");
      return;
    }
    // Set value directly (no change event) so we don't trigger the
    // submit_on_done auto-save mid-fill; the final Update submits this value.
    el.value = todayMMDDYYYY();
  }

  // The date field is a jQuery datepicker whose value Kipu may set/clear
  // asynchronously after load. Set it and confirm it stays put, retrying if
  // the page overwrites it, so the date is reliably populated before submit.
  async function ensureDateSet(attempts = 10, delay = 250) {
    const want = todayMMDDYYYY();
    for (let i = 0; i < attempts; i++) {
      const el = dateField();
      if (el) {
        if (el.value !== want) el.value = want;
        await sleep(delay);
        const check = dateField();
        if (check && check.value === want) {
          // Confirm it survives a second check (nothing overwrote it).
          await sleep(delay);
          const check2 = dateField();
          if (check2 && check2.value === want) return true;
        }
      } else {
        await sleep(delay);
      }
    }
    console.warn(LOG, "Could not confirm the date field value.");
    return false;
  }

  // Continuously force the date to today until stopped. Counters Kipu clearing
  // or replacing the field asynchronously (e.g. when its loading indicator runs).
  // Setting input.value doesn't create DOM mutations, so this also plays nicely
  // with waitForDateQuiet below.
  function startDateEnforcer() {
    const want = todayMMDDYYYY();
    const apply = () => {
      const el = dateField();
      if (el && el.value !== want) el.value = want;
    };
    apply();
    const iv = setInterval(apply, 150);
    let obs = null;
    const parent = dateField()?.parentElement;
    if (parent) {
      obs = new MutationObserver(apply);
      try {
        obs.observe(parent, { childList: true, subtree: true, attributes: true });
      } catch (_) {
        obs = null;
      }
    }
    return () => {
      clearInterval(iv);
      if (obs) obs.disconnect();
    };
  }

  // Resolve once the date field's container has had no DOM mutations for a quiet
  // window, so we don't submit while Kipu is mid-render.
  function waitForDateQuiet(quietMs = 700, timeout = 8000) {
    return new Promise((resolve) => {
      const parent = dateField()?.parentElement;
      if (!parent) return resolve(false);
      let last = Date.now();
      const obs = new MutationObserver(() => {
        last = Date.now();
      });
      obs.observe(parent, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });
      const start = Date.now();
      const iv = setInterval(() => {
        if (Date.now() - last >= quietMs) {
          clearInterval(iv);
          obs.disconnect();
          resolve(true);
        } else if (Date.now() - start >= timeout) {
          clearInterval(iv);
          obs.disconnect();
          resolve(false);
        }
      }, 100);
    });
  }

  function fillShiftNoteForm(state) {
    setDateField();
    const profile = profileFor(state.buildingId);
    if (!profile) {
      console.warn(
        LOG,
        `No checkbox profile for building ${state.buildingId}; skipping fill.`
      );
      return;
    }
    console.log(
      LOG,
      `Filling ${state.buildingName || "building"} checkbox profile.`
    );
    Object.entries(profile).forEach(([title, labels]) => {
      setSection(title, labels);
    });
  }

  async function doFill(state) {
    // 1. Wait for the document itself to finish loading.
    await waitFor(() => (document.readyState === "complete" ? true : null), 15000);

    // 2. Wait for the submit button and the eval sections to appear.
    const submitBtn = await waitFor(
      () => document.querySelector("#form_submit"),
      20000
    );
    if (!submitBtn) return skipPatient(state, "shift note form did not load");

    await waitFor(
      () => document.querySelector(".patient_evaluation_item .item_title"),
      15000
    );

    // 3. The form renders its defaults/checkboxes progressively. Wait until the
    //    number of eval sections and checkboxes stops changing before filling,
    //    so we don't populate values before the page has fully loaded.
    let lastSignature = "";
    let stablePolls = 0;
    await waitFor(
      () => {
        const sections = document.querySelectorAll(
          ".patient_evaluation_item .item_title"
        ).length;
        const checkboxes = document.querySelectorAll(
          '.checkbox_list_wrap input[type="checkbox"]'
        ).length;
        const signature = `${sections}:${checkboxes}`;
        if (checkboxes > 0 && signature === lastSignature) {
          stablePolls += 1;
        } else {
          stablePolls = 0;
          lastSignature = signature;
        }
        return stablePolls >= 4 ? true : null; // stable for ~1s
      },
      15000,
      250
    );

    // 4. Small settle delay so any last default values finish applying.
    await sleep(600);

    fillShiftNoteForm(state);
    await ensureDateSet();

    // Keep forcing the date to today right up until (and through) submit, so a
    // late Kipu re-render/clear can't blank it out.
    const stopDateEnforcer = startDateEnforcer();

    // Mark advancing first: if the submit happens to trigger a full navigation,
    // the next page load will handle the advance.
    await setState({ phase: "advancing" });
    console.log(LOG, `Submitting shift note for client ${state.queue[state.index]}`);

    const form =
      submitBtn.closest("form") ||
      document.querySelector("form.edit_patient_evaluation");

    // The form is submitted via AJAX (data-remote), so we must wait for the
    // request to finish before navigating away, otherwise the save is aborted.
    let advanced = false;
    const advanceOnce = async () => {
      if (advanced) return;
      advanced = true;
      stopDateEnforcer();
      const s = await getState();
      if (s.running) await doAdvance(s);
    };

    if (form) {
      ["ajax:success", "ajax:complete", "ajax:error"].forEach((ev) =>
        form.addEventListener(ev, () => setTimeout(advanceOnce, 500), {
          once: true,
        })
      );
    }

    // Also watch the submit button: rails-ujs disables it ("Working...") during
    // the request and re-enables it when done.
    let sawDisabled = false;
    const startedAt = Date.now();
    const poll = setInterval(() => {
      const disabled =
        submitBtn.disabled ||
        submitBtn.getAttribute("aria-disabled") === "true";
      if (disabled) sawDisabled = true;
      if ((sawDisabled && !disabled) || Date.now() - startedAt > 15000) {
        clearInterval(poll);
        setTimeout(advanceOnce, 500);
      }
    }, 200);

    // Wait for the date area to stop mutating (Kipu may be mid-render), then set
    // the date and click in the SAME synchronous tick so the AJAX form
    // serialization is guaranteed to capture today's date.
    await waitForDateQuiet();
    const freshBtn = document.querySelector("#form_submit") || submitBtn;
    const dEl = dateField();
    if (dEl) dEl.value = todayMMDDYYYY();
    freshBtn.click();
  }

  // ---- step: move on to the next client --------------------------------------

  async function doAdvance(state) {
    const nextIndex = (state.index || 0) + 1;
    const queue = state.queue || [];
    if (nextIndex >= queue.length) {
      console.log(LOG, "All clients processed. Done.");
      await setState({ running: false, phase: "done" });
      return;
    }
    await setState({ index: nextIndex, phase: "opening_form" });
    window.location.href = recordsUrl(queue[nextIndex]);
  }

  async function skipPatient(state, reason) {
    console.warn(
      LOG,
      `Skipping client ${state.queue?.[state.index]} (${reason}).`
    );
    await doAdvance(state);
  }

  // ---- main dispatcher -------------------------------------------------------

  async function run() {
    const state = await getState();
    if (!state.running) return;

    const path = window.location.pathname;

    try {
      switch (state.phase) {
        case "collect":
          if (path === "/occupancy") await doCollect(state);
          break;
        case "opening_form":
          if (/^\/patients\/\d+\/records/.test(path)) {
            await doOpenForm(state);
          } else if (document.querySelector("#form_submit")) {
            // Unexpectedly landed straight on the edit form; recover by filling.
            await doFill(state);
          }
          break;
        case "open_edit":
          await doOpenEdit(state);
          break;
        case "filling":
          await doFill(state);
          break;
        case "advancing":
          await doAdvance(state);
          break;
        default:
          break;
      }
    } catch (err) {
      console.error(LOG, "Unexpected error:", err);
    }
  }

  run();
})();
