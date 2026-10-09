# Kipu Shift Note Filler (Chrome Extension)

Auto-fills a standard shift note for **every client** in a chosen building on a
Kipu occupancy board.

## What it does

Set your Kipu site once, pick a building (**Aspen**, **Snowmass**, or **Vail**)
in the popup, then click **Fill in bubbles** (while logged in and on the
patients page) and it:

1. Navigates to `/occupancy` for the chosen building, switching tabs in the
   occupancy sub-nav if the board didn't already open on it.
2. Reads every client in that building's occupancy table (patient IDs are pulled
   dynamically from the `/patients/{id}` links, so names/order don't matter).
3. For each client, in order:
   - Opens **Shift Notes** (`/patients/{id}/records?process=88`).
   - Clicks **Add form**.
   - Clicks **New Shift Note**.
   - Fills the form with these defaults:
     | Field | Selection |
     | --- | --- |
     | ADLS | Bathing, Grooming, Neat, Clean |
     | Appetite | Within Normal Limits |
     | Behavior | Cooperative |
     | Thinking | *(left blank)* |
     | Eye Contact | Appropriate |
     | Affect | Appropriate |
     | Mood | Euthymic |
     | Speech | Appropriate |
     | Orientation | Time, Person, Place, and Situation |
     | Insight | Good |
     | Risk Thoughts/Behaviors | None Reported |
     | Additional Info about Risk Thoughts/Behaviors | None |
     | Withdrawal and Detox Symptoms | None |
     | PAW Symptoms | None |
   - Clicks **Update**.
4. Repeats until all clients are done.

The options are matched by **section title + option label text** (not by
hard-coded element IDs), so it keeps working even though Kipu regenerates IDs on
every page load.

## Safety gate

The **Fill in bubbles** button is only enabled when the active tab is on the
`/patients` page of your configured Kipu site. This ensures you are logged in
before anything runs. There's also a **Stop** button to cancel a run in
progress.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Toggle **Developer mode** (top-right).
3. Click **Load unpacked** and select the `kipu-shift-note-extension` folder.
4. Pin the extension so it's visible in the toolbar.

## Usage

1. Click the extension icon and enter your Kipu site (for example
   `yourteam.kipuworks.com`). It's stored locally and only asked for once; use
   **Change site** to update it.
2. Log in to Kipu and go to that site's `/patients` page.
3. Click the extension icon, choose **Aspen**, **Snowmass**, or **Vail**, then
   click **Fill in bubbles**. Your choice is remembered for next time.
4. Leave the tab open; the popup shows progress (`Client X of Y`). Click **Stop**
   at any time to halt.

Buildings map to the occupancy sub-nav's `p_building` ids (Aspen `6`,
Snowmass `7`, Vail `8`); update `BUILDINGS` in `popup.js` if Kipu ever changes
them. If the run can't confirm the chosen building's list is on screen, it stops
instead of filling notes for the wrong unit.

## Notes / troubleshooting

- Keep the Kipu tab focused and open while it runs. If you navigate away, the
  loop pauses; re-running starts over from the top of the occupancy board.
- Checkbox selections are set on the DOM and committed when **Update** submits
  the whole form (no per-field auto-save events are triggered, to avoid mid-fill
  reloads).
- Open the page's **DevTools console** and filter for `[KipuShiftNote]` to see
  per-client progress and any options/sections it couldn't find.
- If Kipu renames a section title or option label, update the corresponding
  string in `fillShiftNoteForm()` inside `content.js`.
- The site must end in `.kipuworks.com`, which is the only host the manifest
  grants access to. For a Kipu instance on a custom domain, add it to
  `host_permissions` and `content_scripts.matches` in `manifest.json` and
  relax `HOST_SUFFIX` in `popup.js`.
