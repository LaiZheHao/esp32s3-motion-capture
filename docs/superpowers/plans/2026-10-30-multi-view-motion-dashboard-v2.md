# Multi-View Motion Dashboard V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the long scrolling dashboard with five route-driven views, a reference-matched interactive neutral mannequin, focused calibration including single-node recalibration, history/export, and synchronized pose replay.

**Architecture:** Keep the existing FastAPI routes, WebSockets, command payloads, and state owners. Add a small hash router that switches persistent front-end views without reconnecting, then redistribute the existing DOM controls into those views. Extend the existing Canvas renderer instead of adding a 3D dependency.

**Tech Stack:** Static HTML/CSS, browser JavaScript, Canvas 2D, Node.js tests, Python `unittest`, FastAPI/Starlette unchanged.

**Spec:** `docs/superpowers/specs/2026-10-30-multi-view-motion-dashboard-v2-design.md`

## Execution result — 2026-10-30

Implemented all five functional groups in the existing authorized checkout. The implementation retains each original DOM control and composes the persistent views in `navigation.js` before the controllers initialize; this avoids duplicated IDs and reconnecting data streams. View-specific styles live in `workspace.css`. `session_archive.js` reads the existing ZIP download endpoint for saved curve previews and CSV conversion; no backend changes were needed. Browser extraction is limited to 128 MiB per expanded entry; complete ZIP export is available for larger recordings. Playback speed uses existing pause/seek commands and saved time, while 1× playback uses the original server play command.

Validation: 244 Python tests passed; all existing JavaScript checks plus navigation, archive extraction, CSV escaping and camera interaction tests passed. Eight browser screenshots cover dashboard 1920/1366/narrow, calibration 1920/1366, direction 1366, records and replay. Route cycling preserves the state object and exposes exactly one view; desktop outer views fit the viewport and no viewport has horizontal overflow. Real fourteen-node hardware verification remains outstanding.

## Global Constraints

- Preserve USB/Wi-Fi connection, binding, bias calibration, direction calibration, fourteen nodes, diagnostics, recording, export, and replay.
- Do not change backend endpoints, command names, WebSocket addresses, or payload structures.
- Do not add Three.js, WebGL assets, external CDNs, or a real 3D model.
- Desktop dashboard and calibration views must fit 1920×1080 and 1366×768 without main-view vertical scrolling or a scrolling right status rail.
- Narrow screens may scroll vertically inside the active view but must never overflow horizontally.
- The reference images must not be used as production image or background content.
- Every action retains waiting, busy, success, failure, disconnected, stale, simulation, and replay feedback where applicable.

---

### Task 1: Hash Router and Persistent Application Views

**Files:**
- Create: `host/web/navigation.js`
- Create: `host/tests/test_navigation.js`
- Modify: `host/web/index.html`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: `window.AppNavigation.navigate(route: string): string`
- Produces: `window.AppNavigation.current(): string`
- Produces: `window.AppNavigation.routeFromHash(hash: string): string`
- Consumes: elements with `[data-route]` and `.app-view[data-view]`
- Emits: `app-route-change` with `{detail: {route}}`

- [ ] **Step 1: Write the failing router unit test**

Create `host/tests/test_navigation.js` with fake view and navigation elements. Assert unknown hashes normalize to `dashboard`, `#/records` selects only records, repeated navigation is idempotent, and the router never modifies application data objects.

```js
"use strict";
const assert=require("node:assert/strict");
const {routeFromHash,applyRoute}=require("../web/navigation.js");
assert.equal(routeFromHash("#/records"),"records");
assert.equal(routeFromHash("#overview"),"dashboard");
assert.equal(routeFromHash("#/unknown"),"dashboard");
const view=name=>({dataset:{view:name},hidden:false,classList:{toggle(){}}});
const link=name=>({dataset:{route:name},classList:{toggle(_,value){this.active=value;}},setAttribute(){}});
const views=[view("dashboard"),view("calibration"),view("records"),view("replay"),view("advanced")];
const links=views.map(item=>link(item.dataset.view));
assert.equal(applyRoute("records",{views,links}),"records");
assert.deepEqual(views.map(item=>item.hidden),[true,true,false,true,true]);
assert.deepEqual(links.map(item=>item.active),[false,false,true,false,false]);
console.log("navigation routes: normalization and exclusive view selection passed");
```

- [ ] **Step 2: Run the router test and verify it fails**

Run: `node tests/test_navigation.js` from `host`.

Expected: FAIL because `web/navigation.js` does not exist.

- [ ] **Step 3: Implement the router as an isolated browser/CommonJS module**

Create `host/web/navigation.js`:

```js
"use strict";
(function(root){
  const ROUTES=Object.freeze(["dashboard","calibration","records","replay","advanced"]);
  const routeFromHash=hash=>{
    const value=String(hash||"").replace(/^#\/?/,"");
    return ROUTES.includes(value)?value:"dashboard";
  };
  function applyRoute(route,{views,links}){
    const selected=ROUTES.includes(route)?route:"dashboard";
    views.forEach(view=>{view.hidden=view.dataset.view!==selected;view.classList.toggle("active",!view.hidden);});
    links.forEach(link=>{const active=link.dataset.route===selected;link.classList.toggle("active",active);link.setAttribute("aria-current",active?"page":"false");});
    return selected;
  }
  let active="dashboard";
  function render(){
    active=applyRoute(routeFromHash(root.location?.hash),{
      views:[...(root.document?.querySelectorAll(".app-view[data-view]")||[])],
      links:[...(root.document?.querySelectorAll("[data-route]")||[])],
    });
    root.document?.dispatchEvent(new CustomEvent("app-route-change",{detail:{route:active}}));
    return active;
  }
  function navigate(route){const selected=ROUTES.includes(route)?route:"dashboard";if(root.location)root.location.hash=`#/${selected}`;return render();}
  function start(){root.addEventListener?.("hashchange",render);return render();}
  const api={ROUTES,routeFromHash,applyRoute,navigate,current:()=>active,start};
  root.AppNavigation=api;if(typeof module!=="undefined")module.exports=api;
})(globalThis);
```

- [ ] **Step 4: Add route buttons and persistent view containers**

In `index.html`, replace anchor navigation with buttons such as:

```html
<button class="nav-item active" data-route="dashboard" aria-label="实时总览">…</button>
<button class="nav-item" data-route="calibration" aria-label="设备标定">…</button>
<button class="nav-item" data-route="records" aria-label="历史记录与导出">…</button>
<button class="nav-item" data-route="replay" aria-label="姿态回放">…</button>
<button class="nav-item" data-route="advanced" aria-label="高级设置">…</button>
```

Wrap each major content area in `<section class="app-view" data-view="…">`. Add `navigation.js` before the application scripts and call `AppNavigation.start()` after DOM parsing. Keep every existing control ID unique and present.

- [ ] **Step 5: Add the router to CI and run tests**

Add `node --check web/navigation.js` and `node tests/test_navigation.js` to `.github/workflows/ci.yml`.

Run:

```powershell
node --check web/navigation.js
node tests/test_navigation.js
python -B -X utf8 -m unittest tests.test_dashboard_ui -v
```

Expected: all pass.

- [ ] **Step 6: Commit the router**

```powershell
git add host/web/navigation.js host/web/index.html host/tests/test_navigation.js .github/workflows/ci.yml
git commit -m "feat: add route-driven dashboard views"
```

---

### Task 2: Fixed-Screen Dashboard and Calibration Views

**Files:**
- Modify: `host/web/index.html`
- Modify: `host/web/style.css`
- Modify: `host/tests/test_dashboard_ui.py`

**Interfaces:**
- Consumes: the route containers from Task 1
- Preserves: all IDs referenced by `app.js`, `body_app.js`, and `direction_app.js`
- Produces: `.dashboard-layout`, `.calibration-layout`, `.single-node-recalibration`

- [ ] **Step 1: Extend the dashboard UI contract test**

Add assertions to `host/tests/test_dashboard_ui.py`:

```python
def test_navigation_uses_views_instead_of_scroll_anchors(self):
    self.assertNotIn('href="#overview"', self.html)
    for route in ("dashboard", "calibration", "records", "replay", "advanced"):
        self.assertIn(f'data-view="{route}"', self.html)
        self.assertIn(f'data-route="{route}"', self.html)

def test_calibration_keeps_single_node_recalibration_contract(self):
    for element_id in ("nodeState", "bodySelectedDetails", "roll", "pitch", "yaw",
                       "zero", "calibrate", "cancelCalibration", "directionNeutralStart"):
        self.assertRegex(self.html, rf'\bid=["\']{element_id}["\']')

def test_desktop_status_rail_is_not_a_scroll_container(self):
    desktop = re.search(r'@media\(min-width:1121px\)\{(.*?)\n\}', self.css, re.S)
    self.assertIsNotNone(desktop)
    self.assertNotRegex(desktop.group(1), r'\.status-rail[^}]*overflow-y\s*:\s*auto')
```

- [ ] **Step 2: Run the contract test and verify it fails**

Run: `python -B -X utf8 -m unittest tests.test_dashboard_ui -v` from `host`.

Expected: FAIL on anchor navigation, missing view containers, or the scrolling status rail.

- [ ] **Step 3: Recompose the dashboard view**

Move, without renaming, the connection and slot controls into the left column; `bodyFixed` into the central stage; quality, device, and calibration status into the right column; and the three chart canvases plus recording controls into the bottom row. Add click-through buttons:

```html
<button type="button" class="card-link" data-go="calibration">进入标定</button>
<button type="button" class="card-link" data-go="records">查看记录</button>
```

Bind `[data-go]` once in `navigation.js` to `navigate(button.dataset.go)`.

- [ ] **Step 4: Build the five-step calibration layout and single-node panel**

Place existing binding, zero-bias, initialization, and direction controls under one calibration view. Add a step header with `data-calibration-step` markers and a closed-by-default `<dialog id="singleNodeCalibration">`. The dialog must reuse the existing IDs `nodeState`, `bodySelectedDetails`, `roll`, `pitch`, `yaw`, `calibrate`, `cancelCalibration`, sensor values, and diagnostics rather than creating duplicate controls.

The entry button is:

```html
<button id="openSingleNodeCalibration" type="button">单节点重新标定</button>
```

The dialog includes a close button with ID `closeSingleNodeCalibration`; opening it requires a selected node and otherwise reports “请先选择一个在线节点”. Direction controls continue to show their actual multi-node scope from `directionScope`.

- [ ] **Step 5: Replace long-page CSS with fixed active-view CSS**

Implement desktop layout rules:

```css
.app-main{height:calc(100vh - 28px);display:grid;grid-template-rows:auto minmax(0,1fr)}
.view-stack{min-height:0;overflow:hidden}
.app-view{height:100%;min-height:0}
.app-view[hidden]{display:none!important}
.dashboard-layout{height:100%;display:grid;grid-template-columns:minmax(220px,270px) minmax(0,1fr) minmax(270px,330px);grid-template-rows:minmax(0,1fr) 190px;gap:12px}
.dashboard-telemetry{grid-column:1/-1;min-height:0}
.status-rail{min-height:0;overflow:visible}
```

At `max-width:900px`, allow `.view-stack{overflow-y:auto}` and collapse the active view to one column while keeping `overflow-x:hidden`.

- [ ] **Step 6: Run the UI contract and JavaScript selection tests**

Run:

```powershell
python -B -X utf8 -m unittest tests.test_dashboard_ui -v
node tests/test_body_selection.js
node tests/test_direction_ui.js
```

Expected: all pass.

- [ ] **Step 7: Commit the two primary views**

```powershell
git add host/web/index.html host/web/style.css host/tests/test_dashboard_ui.py
git commit -m "feat: build fixed dashboard and calibration views"
```

---

### Task 3: Reference-Matched Interactive Neutral Mannequin

**Files:**
- Modify: `host/web/body_view.js`
- Modify: `host/tests/test_scene_coordinates.js`
- Modify: `host/tests/test_body_view.js`

**Interfaces:**
- Preserves: `BodyView.draw(frame, options)`, `BodyView.reset()`, `BodyView.clearTrail()`
- Produces: `BodyView.setZoom(value: number)`
- Consumes: existing `body_frame.segments`; never mutates it

- [ ] **Step 1: Write interaction and immutability tests**

Extend `test_scene_coordinates.js` with a canvas that records event handlers:

```js
const handlers={};
const interactiveCanvas={
  addEventListener(name,handler){handlers[name]=handler;},
  setPointerCapture(){},
  getBoundingClientRect(){return {left:0,top:0,width:800,height:600};},
  getContext(){return ctx;},
};
const interaction=new BodyView(interactiveCanvas,{kind:"fixed"});
const original=JSON.stringify(frame);
handlers.pointerdown({clientX:100,clientY:100,pointerId:1,shiftKey:false});
handlers.pointermove({clientX:150,clientY:120});
handlers.pointerup({clientX:150,clientY:120});
assert.notEqual(interaction.yaw,0);
assert.notEqual(interaction.elevation,.18);
handlers.wheel({deltaY:-100,preventDefault(){}});
assert.ok(interaction.zoom>1);
interaction.draw(frame,{});
assert.equal(JSON.stringify(frame),original);
interaction.reset();
assert.equal(interaction.yaw,0);
```

- [ ] **Step 2: Run the Canvas tests and verify the wheel test fails**

Run:

```powershell
node tests/test_scene_coordinates.js
node tests/test_body_view.js
```

Expected: FAIL because wheel zoom and `setZoom` are not implemented.

- [ ] **Step 3: Add rotation, pan, wheel, and zoom APIs**

In the constructor, keep ordinary drag for yaw/elevation and Shift-drag for pan. Add:

```js
canvas.addEventListener("wheel",event=>{
  event.preventDefault();
  this.setZoom(this.zoom*Math.exp(-event.deltaY*.001));
},{passive:false});
```

Add:

```js
setZoom(value){this.zoom=Math.max(.45,Math.min(2.8,Number(value)||1));return this.zoom;}
```

Clamp elevation to `[-0.9, 0.9]`. `reset()` restores yaw `0`, elevation `.18`, zoom `1`, and pan `[0,0]`.

- [ ] **Step 4: Replace disconnected sticks with a continuous neutral mannequin**

Continue using projected live endpoints, but render in this order:

1. floor and axes;
2. torso polygon from both shoulder origins and both thigh origins;
3. pelvis rounded polygon;
4. thick rounded limb strokes with upper/lower width differences;
5. neutral head ellipse and short neck;
6. live skeleton lines and fourteen numbered status nodes.

Use gradients only when `createLinearGradient` exists so the fake Canvas tests remain valid. Do not add anatomy lines. Keep missing segments dashed and status colored.

- [ ] **Step 5: Connect all model zoom controls through `setZoom`**

In `body_app.js`, replace direct assignments with:

```js
for(const input of document.querySelectorAll("[data-zoom]")){
  input.oninput=()=>{
    const view=views.find(item=>item.canvas.id===input.dataset.zoom);
    if(view){view.setZoom(Number(input.value));draw();}
  };
}
```

- [ ] **Step 6: Run the Canvas and body UI tests**

Run:

```powershell
node tests/test_body_view.js
node tests/test_scene_coordinates.js
node tests/test_render_visibility.js
node tests/test_body_selection.js
```

Expected: all pass.

- [ ] **Step 7: Commit the mannequin and camera controls**

```powershell
git add host/web/body_view.js host/web/body_app.js host/tests/test_body_view.js host/tests/test_scene_coordinates.js
git commit -m "feat: render interactive neutral motion mannequin"
```

---

### Task 4: History/Export and Pose Replay Views

**Files:**
- Modify: `host/web/index.html`
- Modify: `host/web/style.css`
- Modify: `host/web/app.js`
- Modify: `host/web/body_app.js`
- Modify: `host/tests/test_body_selection.js`
- Modify: `host/tests/test_dashboard_ui.py`

**Interfaces:**
- Consumes: existing `/api/recordings`, `/api/body/recordings`, replay, preview, and download endpoints
- Consumes: `AppNavigation.navigate(route)` from Task 1
- Preserves: existing `bodySessions`, `bodyReplayOpen`, `bodyReplayPlay`, `bodyReplayPause`, `bodyReplayClose`, `bodyReplaySeek`
- Produces: history view selection and replay view transitions

- [ ] **Step 1: Add route-transition tests to the body app harness**

In `test_body_selection.js`, stub:

```js
globalThis.AppNavigation={routes:[],navigate(route){this.routes.push(route);return route;}};
```

Assert a successful replay open navigates to `replay`, replay close navigates to `dashboard`, and opening the records control navigates to `records` without clearing `selectedDevice`.

- [ ] **Step 2: Run the body selection test and verify it fails**

Run: `node tests/test_body_selection.js`.

Expected: FAIL because record and replay operations do not yet navigate.

- [ ] **Step 3: Convert the record dialog into the history/export view**

Keep the current session selectors, preview table, export buttons, and IDs, but place them in the records view. The layout must contain:

```html
<div class="records-layout">
  <aside class="record-browser">…bodySessions and sessions…</aside>
  <section class="record-preview">…summary, previewTable, three preview canvases…</section>
  <aside class="record-export">…integrity, source, download…</aside>
</div>
```

The `records` button calls `AppNavigation.navigate("records")`. `closeDialog` becomes a “返回总览” button rather than closing a modal. Existing `/api/recordings/{session}/download` remains the export source.

- [ ] **Step 4: Build the independent replay view**

Move `bodyTranslated` or a dedicated existing BodyView canvas into the replay view, together with the existing replay controls and three live chart canvases. Add source text that reads from the current mode. On successful `bodyReplayOpen`, navigate to replay; on `bodyReplayClose`, navigate to dashboard.

Do not create a second replay state. Continue using `BodyReplay` through `body_app.js` and the saved `body_frame` data.

- [ ] **Step 5: Update the single-node record/replay handlers**

In `app.js`, replace `recordDialog.showModal()` and `recordDialog.close()` with navigation calls. After `loadReplay` succeeds, call `AppNavigation.navigate("replay")`; after `exitReplay`, call `AppNavigation.navigate("dashboard")`. Keep all fetch URLs and parsed payloads unchanged.

- [ ] **Step 6: Style records and replay without empty or crowded regions**

Use `grid-template-columns:minmax(230px,.8fr) minmax(0,1.7fr) minmax(230px,.8fr)` for desktop records and `grid-template-columns:minmax(0,1fr) 300px` plus a bottom timeline for replay. At 1366×768, reduce preview heights; at 900px, collapse to one column and allow active-view vertical scrolling.

- [ ] **Step 7: Run history, replay, and integration tests**

Run:

```powershell
node tests/test_body_selection.js
node tests/test_display_buffer.js
python -B -X utf8 -m unittest tests.test_body_recording tests.test_app_integration tests.test_dashboard_ui -v
```

Expected: all pass.

- [ ] **Step 8: Commit history and replay views**

```powershell
git add host/web/index.html host/web/style.css host/web/app.js host/web/body_app.js host/tests/test_body_selection.js host/tests/test_dashboard_ui.py
git commit -m "feat: add history export and pose replay views"
```

---

### Task 5: Advanced View, Full Regression, and Visual QA

**Files:**
- Modify: `host/web/index.html`
- Modify: `host/web/style.css`
- Modify: `tools/capture_dashboard_screenshots.mjs`
- Create: `docs/ui/reviews/dashboard-v2-1920x1080.png`
- Create: `docs/ui/reviews/dashboard-v2-1366x768.png`
- Create: `docs/ui/reviews/dashboard-v2-430x932.png`
- Create: `docs/ui/reviews/calibration-v2-1920x1080.png`
- Create: `docs/ui/reviews/records-v2-1920x1080.png`
- Create: `docs/ui/reviews/replay-v2-1920x1080.png`

**Interfaces:**
- Consumes: all prior view routes
- Produces: repeatable screenshots and overflow metrics per route

- [ ] **Step 1: Place all low-frequency controls in the advanced view**

Move, without renaming, processing profile, position tracking, coordinates, board angles, raw sensor table, and diagnostic text into `data-view="advanced"`. Preserve details disclosure state during route changes because views are hidden, not destroyed.

- [ ] **Step 2: Extend screenshot capture to route-aware cases**

Change the capture matrix to include URL hashes:

```js
const cases=[
  {name:"dashboard-v2-1920x1080.png",route:"dashboard",width:1920,height:1080},
  {name:"dashboard-v2-1366x768.png",route:"dashboard",width:1366,height:768},
  {name:"dashboard-v2-430x932.png",route:"dashboard",width:430,height:932},
  {name:"calibration-v2-1920x1080.png",route:"calibration",width:1920,height:1080},
  {name:"records-v2-1920x1080.png",route:"records",width:1920,height:1080},
  {name:"replay-v2-1920x1080.png",route:"replay",width:1920,height:1080},
];
```

For every case, fail if `document.documentElement.scrollWidth > innerWidth`. For desktop dashboard and calibration, also fail if the active view `scrollHeight > clientHeight` or `.status-rail.scrollHeight > .status-rail.clientHeight`.

- [ ] **Step 3: Run the complete JavaScript suite**

Run all CI browser commands, including router, pose math, buffers, rendering, body view, scene coordinates, body selection, direction UI, and preset report tests.

Expected: every Node process exits `0`.

- [ ] **Step 4: Run the complete Python suite**

Run: `python -B -X utf8 -m unittest discover -s tests -v` from `host`.

Expected: all tests pass, including dashboard UI, body recording, integration, transports, calibration, and replay.

- [ ] **Step 5: Start the dashboard and capture every route**

Run the normal dashboard on an unused local port, launch headless Chrome with a dedicated temporary profile, and execute `tools/capture_dashboard_screenshots.mjs`. Inspect all six PNGs, paying special attention to reference-like mannequin proportions, non-scrolling desktop side rails, calibration step density, record layout balance, replay timeline, and narrow-screen bottom navigation.

- [ ] **Step 6: Audit the final repository state**

Run:

```powershell
git diff --check
git status --short
rg -n "dashboard-glass-v1.png|calibration-glass-v1.png" host/web
```

Expected: no whitespace errors, only intended files changed, and no production reference-image use.

- [ ] **Step 7: Commit the final view and review artifacts**

```powershell
git add host/web/index.html host/web/style.css tools/capture_dashboard_screenshots.mjs docs/ui/reviews
git commit -m "feat: complete multi-view motion dashboard v2"
```
