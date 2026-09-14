// Love Stafford Prayer Network — core.js
// Standalone app (own logic, not shared with the Leaflet Map canvassing
// family) — see G:\Leaflets\WORKFLOW.md and the plan this was built from
// for the full background.
(function () {
  "use strict";
  const CFG = window.PRAYER_CONFIG;
  const QUADRANTS = CFG.QUADRANTS;
  const WEEK_COUNT = CFG.WEEK_COUNT;
  const USING_LOCAL = !CFG.SHEET_ID || CFG.SHEET_ID.indexOf("TODO") === 0;

  const QUADRANT_COLORS = {
    "North East": "#e74c3c",
    "North West": "#3498db",
    "South East": "#2ecc71",
    "South West": "#f39c12",
  };

  const POI_ICONS = {
    church: "⛪", school: "🏫", care_home: "🏥", community_centre: "🏛️", custom: "📍",
  };

  // ── State ──────────────────────────────────────────────────────────────
  let allRoads = [];              // parsed Data rows
  let focusByQuadrant = {};       // quadrant -> {anchor, groupCount, overrideActive, overrideStreets}
  let prayerCounts = {};          // "quadrant::week::street" -> count
  let quadrantFeatures = null;    // GeoJSON FeatureCollection
  let allPois = [];               // parsed POIs rows
  let map, dimLayer, highlightLayer, quadrantOutlineLayer, poiLayer;
  let selectedQuadrant = QUADRANTS[0];
  let selectedWeek = 0;
  let userMarker = null;
  let placingPoi = false;

  let authToken = null, authTokenType = null, authEmail = null, authAuthorised = false;

  // ── Utilities ──────────────────────────────────────────────────────────
  function isMobile() { return window.innerWidth <= 640; }

  function parseWKT(wktField) {
    // Mirrors the canvassing app's parseWKT: pipe-separated
    // LINESTRING(lon lat, lon lat, ...) segments -> arrays of [lat,lon].
    if (!wktField || typeof wktField !== "string" || wktField.trim() === "-" || wktField.trim() === "") return [];
    const segs = [];
    wktField.split("|").forEach(part => {
      const m = /LINESTRING\s*\((.+)\)/i.exec(part.trim());
      if (!m) return;
      const pts = m[1].split(",").map(pair => {
        const xy = pair.trim().split(/\s+/);
        return [parseFloat(xy[1]), parseFloat(xy[0])]; // -> [lat, lon]
      }).filter(p => !isNaN(p[0]) && !isNaN(p[1]));
      if (pts.length >= 2) segs.push(pts);
    });
    return segs;
  }

  function fetchCSV(url) {
    return fetch(url, { cache: "no-store" }).then(r => r.text()).then(text => {
      const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
      return parsed.data;
    });
  }

  function publishedCsvUrl(gid) {
    return `https://docs.google.com/spreadsheets/d/e/${CFG.SHEET_ID}/pub?gid=${gid}&single=true&output=csv`;
  }

  function weekKey(quadrant, week) { return quadrant + "::" + week; }

  // ── Data loading ───────────────────────────────────────────────────────
  function loadAll() {
    const dataUrl = USING_LOCAL ? CFG.LOCAL_DATA_URL : publishedCsvUrl(CFG.DATA_GID);
    const focusUrl = USING_LOCAL ? "Focus.csv" : publishedCsvUrl(CFG.FOCUS_GID);
    const prayerUrl = USING_LOCAL ? "PrayerLog.csv" : publishedCsvUrl(CFG.PRAYERLOG_GID);
    const poisUrl = USING_LOCAL ? "POIs.csv" : publishedCsvUrl(CFG.POIS_GID);

    return Promise.all([
      fetchCSV(dataUrl),
      fetchCSV(focusUrl).catch(() => []),
      fetchCSV(prayerUrl).catch(() => []),
      fetch(CFG.LOCAL_QUADRANTS_URL || "stafford_quadrants.geojson").then(r => r.json()),
      fetchCSV(poisUrl).catch(() => []),
    ]).then(([dataRows, focusRows, prayerRows, geojson, poiRows]) => {
      allRoads = dataRows.map(r => ({
        Street: r.Street,
        lat: parseFloat(r["@lat"]),
        lon: parseFloat(r["@lon"]),
        Quadrant: r.Quadrant,
        RotationGroup: parseInt(r.RotationGroup, 10),
        Residences: r.Residences,
        Notes: r.Notes || "",
        geometry: r.road_geometry,
      })).filter(r => r.Street && r.Quadrant);

      focusByQuadrant = {};
      QUADRANTS.forEach(q => {
        focusByQuadrant[q] = { anchor: "2026-09-14", groupCount: WEEK_COUNT, overrideActive: false, overrideStreets: [] };
      });
      focusRows.forEach(r => {
        if (!r.Quadrant) return;
        focusByQuadrant[r.Quadrant] = {
          anchor: r.CycleAnchorDate || "2026-09-14",
          groupCount: parseInt(r.GroupCount, 10) || WEEK_COUNT,
          overrideActive: String(r.OverrideActive).toLowerCase() === "true",
          overrideStreets: (r.OverrideStreets || "").split("|").map(s => s.trim()).filter(Boolean),
        };
      });

      prayerCounts = {};
      prayerRows.forEach(r => {
        if (!r.Street || !r.Quadrant || !r.WeekKey) return;
        const key = r.Quadrant + "::" + r.WeekKey + "::" + r.Street;
        prayerCounts[key] = (prayerCounts[key] || 0) + 1;
      });

      quadrantFeatures = geojson;

      allPois = poiRows.map(r => ({
        Id: r.Id,
        Name: r.Name,
        Type: r.Type || "custom",
        Quadrant: r.Quadrant,
        lat: parseFloat(r.Lat),
        lon: parseFloat(r.Lon),
        Notes: r.Notes || "",
      })).filter(p => p.Id && p.Name && !isNaN(p.lat) && !isNaN(p.lon));
    });
  }

  // ── Rotation logic ─────────────────────────────────────────────────────
  function computeAutoWeek(quadrant) {
    const f = focusByQuadrant[quadrant];
    const anchor = new Date(f.anchor + "T00:00:00Z");
    const now = new Date();
    const diffDays = Math.floor((now - anchor) / 86400000);
    const weeksSince = Math.floor(diffDays / 7);
    const n = f.groupCount || WEEK_COUNT;
    return ((weeksSince % n) + n) % n;
  }

  function getWeekStreets(quadrant, week) {
    const f = focusByQuadrant[quadrant];
    const isCurrent = week === computeAutoWeek(quadrant);
    if (isCurrent && f.overrideActive && f.overrideStreets.length) {
      return f.overrideStreets;
    }
    return allRoads.filter(r => r.Quadrant === quadrant && r.RotationGroup === week).map(r => r.Street);
  }

  function prayerCountFor(quadrant, week, street) {
    return prayerCounts[quadrant + "::" + weekKey(quadrant, week) + "::" + street] || 0;
  }

  // ── Map / rendering ────────────────────────────────────────────────────
  function initMap() {
    map = L.map("map", { zoomControl: !isMobile() }).setView(CFG.INITIAL_VIEW, CFG.INITIAL_ZOOM);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors",
      maxZoom: 19,
    }).addTo(map);
    dimLayer = L.layerGroup().addTo(map);
    highlightLayer = L.layerGroup().addTo(map);
    quadrantOutlineLayer = L.layerGroup().addTo(map);
    poiLayer = L.layerGroup().addTo(map);

    map.on("click", (e) => {
      if (placingPoi) { finishPlacingPoi(e.latlng); return; }
      if (isMobile()) closeSidebar();
    });
  }

  function renderPois() {
    poiLayer.clearLayers();
    allPois.forEach(poi => {
      const icon = L.divIcon({
        className: "poi-marker",
        html: `<span>${POI_ICONS[poi.Type] || POI_ICONS.custom}</span>`,
        iconSize: [26, 26],
      });
      const marker = L.marker([poi.lat, poi.lon], { icon });
      // Bind ONCE with a content function (Leaflet calls it fresh on every
      // open) rather than calling bindPopup() again inside a click handler —
      // doing both attaches two competing click listeners (ours, plus the
      // one bindPopup itself registers), which made the second click net
      // out to an immediate open-then-close, looking like "only opens once".
      marker.bindPopup(() => {
        const div = document.createElement("div");
        div.className = "road-popup";
        renderPoiPopupContent(div, poi);
        return div;
      }, { maxWidth: 260 });
      marker.addTo(poiLayer);
    });
  }

  function renderPoiPopupContent(div, poi) {
    div.innerHTML = `
      <div class="popup-title">${POI_ICONS[poi.Type] || ""} ${escapeHtml(poi.Name)}</div>
      <div class="popup-quadrant">${escapeHtml(poi.Quadrant || "")} • ${escapeHtml(poi.Type.replace("_", " "))}</div>
      <div class="popup-notes">${poi.Notes ? escapeHtml(poi.Notes) : "<em>No notes yet.</em>"}</div>
      ${authAuthorised ? poiOrganiserEditHtml(poi) : ""}
    `;
    if (authAuthorised) wirePoiOrganiserEdit(div, poi);
  }

  function poiOrganiserEditHtml(poi) {
    return `
      <div class="organiser-edit">
        <label>Notes <textarea class="edit-poi-notes">${escapeHtml(poi.Notes || "")}</textarea></label>
        <button class="save-poi-btn">Save</button>
        ${poi.Id.indexOf("manual-") === 0 ? '<button class="delete-poi-btn">Delete this pin</button>' : ""}
      </div>`;
  }

  function wirePoiOrganiserEdit(div, poi) {
    const saveBtn = div.querySelector(".save-poi-btn");
    if (saveBtn) saveBtn.addEventListener("click", () => {
      const notes = div.querySelector(".edit-poi-notes").value;
      fetch(CFG.APPS_SCRIPT_URL, {
        method: "POST",
        body: JSON.stringify({ action: "updatePoiNotes", ...authPayloadBase(), id: poi.Id, notes }),
      }).then(r => r.json()).then(data => {
        if (data.ok) { poi.Notes = notes; renderPoiPopupContent(div, poi); } else alert(data.error || "Save failed.");
      });
    });
    const delBtn = div.querySelector(".delete-poi-btn");
    if (delBtn) delBtn.addEventListener("click", () => {
      if (!confirm("Delete this pin?")) return;
      fetch(CFG.APPS_SCRIPT_URL, {
        method: "POST",
        body: JSON.stringify({ action: "deletePoi", ...authPayloadBase(), id: poi.Id }),
      }).then(r => r.json()).then(data => {
        if (data.ok) { allPois = allPois.filter(p => p.Id !== poi.Id); renderPois(); map.closePopup(); }
        else alert(data.error || "Delete failed.");
      });
    });
  }

  function startPlacingPoi() {
    placingPoi = true;
    alert("Tap anywhere on the map to place a pin.");
  }

  function finishPlacingPoi(latlng) {
    placingPoi = false;
    const name = window.prompt("Name for this point of interest (e.g. \"4 Prospect Road shops\"):");
    if (!name) return;
    const typeInput = (window.prompt('Type: church / school / care_home / community_centre / custom', "custom") || "custom").trim();
    const type = ["church", "school", "care_home", "community_centre"].includes(typeInput) ? typeInput : "custom";
    let quadrant = selectedQuadrant;
    if (quadrantFeatures) {
      const pt = turf.point([latlng.lng, latlng.lat]);
      for (const feature of quadrantFeatures.features) {
        if (turf.booleanPointInPolygon(pt, feature)) { quadrant = feature.properties.Quadrant; break; }
      }
    }
    fetch(CFG.APPS_SCRIPT_URL, {
      method: "POST",
      body: JSON.stringify({ action: "addPoi", ...authPayloadBase(), name, type, quadrant, lat: latlng.lat, lon: latlng.lng }),
    }).then(r => r.json()).then(data => {
      if (data.ok) {
        allPois.push({ Id: data.id, Name: name, Type: type, Quadrant: quadrant, lat: latlng.lat, lon: latlng.lng, Notes: "" });
        renderPois();
      } else alert(data.error || "Failed to add pin.");
    });
  }

  function renderQuadrantOutlines() {
    quadrantOutlineLayer.clearLayers();
    if (!quadrantFeatures) return;
    L.geoJSON(quadrantFeatures, {
      style: f => ({
        color: QUADRANT_COLORS[f.properties.Quadrant] || "#888",
        weight: 2, dashArray: "6 4", fill: false, opacity: 0.6,
      }),
    }).addTo(quadrantOutlineLayer);
  }

  function renderRoads() {
    dimLayer.clearLayers();
    highlightLayer.clearLayers();

    const thisWeekStreets = new Set(getWeekStreets(selectedQuadrant, selectedWeek));

    allRoads.forEach(road => {
      const segs = parseWKT(road.geometry);
      const color = QUADRANT_COLORS[road.Quadrant] || "#888";
      const isFocus = road.Quadrant === selectedQuadrant && thisWeekStreets.has(road.Street);
      const layer = isFocus ? highlightLayer : dimLayer;
      const style = isFocus
        ? { color, weight: 6, opacity: 0.95 }
        : { color, weight: 2, opacity: 0.25 };

      if (segs.length) {
        segs.forEach(seg => {
          const line = L.polyline(seg, style);
          bindRoadPopup(line, road, isFocus);
          line.addTo(layer);
        });
      } else if (!isNaN(road.lat) && !isNaN(road.lon)) {
        const marker = L.circleMarker([road.lat, road.lon], { ...style, radius: isFocus ? 8 : 4 });
        bindRoadPopup(marker, road, isFocus);
        marker.addTo(layer);
      }
    });
  }

  function bindRoadPopup(layer, road, isFocus) {
    // Bind ONCE with a content function (called fresh by Leaflet on every
    // open) instead of calling bindPopup() again inside a click handler —
    // doing both attaches two competing click listeners (ours, plus the one
    // bindPopup itself registers), which made a second click on the same
    // road net out to an immediate open-then-close ("only opens once").
    // Leaflet already opens a bound popup on click by itself, so the only
    // thing our own click listener needs to do is stop the click reaching
    // the map (which would otherwise also fire the mobile close-sidebar
    // handler at the same time).
    layer.bindPopup(() => {
      const div = document.createElement("div");
      div.className = "road-popup";
      renderPopupContent(div, road);
      return div;
    }, { maxWidth: 280 });
    layer.on("click", (e) => L.DomEvent.stopPropagation(e));
  }

  function renderPopupContent(div, road) {
    const count = prayerCountFor(road.Quadrant, selectedWeek, road.Street);
    const already = localStorage.getItem(prayedFlagKey(road)) === "1";
    div.innerHTML = `
      <div class="popup-title">${escapeHtml(road.Street)}</div>
      <div class="popup-quadrant">${escapeHtml(road.Quadrant)}</div>
      <div class="popup-residences">${road.Residences ? "🏠 " + escapeHtml(String(road.Residences)) : "🏠 Unknown"}</div>
      <div class="popup-notes">${road.Notes ? escapeHtml(road.Notes) : "<em>No notes yet.</em>"}</div>
      <div class="popup-tally">Prayed for ${count} time${count === 1 ? "" : "s"} this week</div>
      <button class="pray-btn" ${already ? "disabled" : ""}>${already ? "Prayed for ✓" : "I prayed for here 🙏"}</button>
      ${authAuthorised ? organiserRoadEditHtml(road) : ""}
    `;
    div.querySelector(".pray-btn").addEventListener("click", () => logPrayer(road, div));
    if (authAuthorised) wireOrganiserRoadEdit(div, road);
  }

  function prayedFlagKey(road) {
    return "prayed_" + CFG.LS_SUFFIX + "_" + road.Quadrant + "_" + selectedWeek + "_" + road.Street;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function logPrayer(road, popupDiv) {
    const key = weekKey(road.Quadrant, selectedWeek);
    fetch(CFG.APPS_SCRIPT_URL, {
      method: "POST",
      body: JSON.stringify({ action: "logPrayer", street: road.Street, quadrant: road.Quadrant, weekKey: key }),
    }).then(r => r.json()).then(data => {
      if (data.ok) {
        localStorage.setItem(prayedFlagKey(road), "1");
        prayerCounts[road.Quadrant + "::" + key + "::" + road.Street] =
          (prayerCounts[road.Quadrant + "::" + key + "::" + road.Street] || 0) + 1;
        renderPopupContent(popupDiv, road);
        refreshQuadrantBanner();
      }
    }).catch(() => {});
  }

  // ── Sidebar ────────────────────────────────────────────────────────────
  function buildShell() {
    document.body.insertAdjacentHTML("beforeend", `
      <div id="app">
        <button id="sidebar-toggle" aria-label="Menu">☰</button>
        <div id="sidebar">
          <h1>${escapeHtml(CFG.TITLE)}</h1>
          <p class="subtitle">${escapeHtml(CFG.SUBTITLE)}</p>
          <button id="locate-btn">📍 Locate me</button>
          <div id="quadrant-banner" class="banner" hidden></div>

          <div class="field-row">
            <label for="quadrant-select">Quadrant</label>
            <select id="quadrant-select"></select>
          </div>
          <div class="field-row">
            <label for="week-select">Week</label>
            <select id="week-select"></select>
          </div>

          <div id="street-list"></div>

          <div id="auth-section">
            <button id="signin-btn">Sign in (organiser)</button>
            <div id="organiser-panel" hidden></div>
          </div>
        </div>
        <div id="map"></div>
      </div>
    `);

    const qSel = document.getElementById("quadrant-select");
    QUADRANTS.forEach(q => {
      const opt = document.createElement("option");
      opt.value = q; opt.textContent = q;
      qSel.appendChild(opt);
    });
    qSel.value = selectedQuadrant;
    qSel.addEventListener("change", () => {
      selectedQuadrant = qSel.value;
      selectedWeek = computeAutoWeek(selectedQuadrant);
      refreshAll();
    });

    document.getElementById("week-select").addEventListener("change", (e) => {
      selectedWeek = parseInt(e.target.value, 10);
      refreshAll();
    });

    document.getElementById("sidebar-toggle").addEventListener("click", toggleSidebar);
    document.getElementById("locate-btn").addEventListener("click", locateMe);
    document.getElementById("signin-btn").addEventListener("click", triggerSignIn);

    if (isMobile()) closeSidebar(); else openSidebar();
  }

  function toggleSidebar() {
    document.getElementById("sidebar").classList.toggle("open");
  }
  function openSidebar() { document.getElementById("sidebar").classList.add("open"); }
  function closeSidebar() { document.getElementById("sidebar").classList.remove("open"); }

  function populateWeekSelect() {
    const sel = document.getElementById("week-select");
    const groupCount = focusByQuadrant[selectedQuadrant].groupCount || WEEK_COUNT;
    const autoWeek = computeAutoWeek(selectedQuadrant);
    sel.innerHTML = "";
    for (let i = 0; i < groupCount; i++) {
      const opt = document.createElement("option");
      opt.value = i;
      opt.textContent = "Week " + (i + 1) + (i === autoWeek ? " (current)" : "");
      sel.appendChild(opt);
    }
    sel.value = selectedWeek;
  }

  function renderStreetList() {
    const container = document.getElementById("street-list");
    const streets = getWeekStreets(selectedQuadrant, selectedWeek);
    const overrideNote = (selectedWeek === computeAutoWeek(selectedQuadrant) && focusByQuadrant[selectedQuadrant].overrideActive)
      ? '<div class="override-note">Organiser-set list for this week</div>' : "";

    if (!streets.length) {
      container.innerHTML = overrideNote + "<p class='empty'>No streets assigned to this week yet.</p>";
      return;
    }
    container.innerHTML = overrideNote + "<ul>" + streets.map(s => {
      const count = prayerCountFor(selectedQuadrant, selectedWeek, s);
      return `<li data-street="${escapeHtml(s)}"><span>${escapeHtml(s)}</span><span class="tally">${count}</span></li>`;
    }).join("") + "</ul>";

    container.querySelectorAll("li").forEach(li => {
      li.addEventListener("click", () => panToStreet(li.dataset.street));
    });
  }

  function panToStreet(streetName) {
    const road = allRoads.find(r => r.Quadrant === selectedQuadrant && r.Street === streetName);
    if (!road) return;
    const segs = parseWKT(road.geometry);
    let target, bounds;
    if (segs.length) {
      const allPts = segs.flat();
      bounds = L.latLngBounds(allPts);
      target = bounds.getCenter();
    } else if (!isNaN(road.lat) && !isNaN(road.lon)) {
      target = L.latLng(road.lat, road.lon);
      bounds = L.latLngBounds([target]);
    } else return;

    map.flyToBounds(bounds.pad(0.3), { maxZoom: 17, duration: 0.6 });
    setTimeout(() => openRoadPopupForStreet(road), 650);
    // NOTE: on mobile, the sidebar deliberately stays open after this —
    // it's only closed by the map-click handler in initMap().
  }

  function openRoadPopupForStreet(road) {
    const segs = parseWKT(road.geometry);
    const at = segs.length ? L.latLng(segs[0][Math.floor(segs[0].length / 2)]) : L.latLng(road.lat, road.lon);
    const temp = L.circleMarker(at, { radius: 0, opacity: 0 }).addTo(map);
    const div = document.createElement("div");
    div.className = "road-popup";
    renderPopupContent(div, road);
    temp.bindPopup(div, { maxWidth: 280 }).openPopup();
    temp.on("popupclose", () => map.removeLayer(temp));
  }

  function refreshQuadrantBanner() {
    const banner = document.getElementById("quadrant-banner");
    const streets = getWeekStreets(selectedQuadrant, selectedWeek);
    const totalPrayers = streets.reduce((sum, s) => sum + prayerCountFor(selectedQuadrant, selectedWeek, s), 0);
    banner.hidden = false;
    banner.innerHTML = `You're praying for the <strong>${escapeHtml(selectedQuadrant)}</strong> quadrant —
      ${streets.length} street${streets.length === 1 ? "" : "s"} this week, ${totalPrayers} prayer${totalPrayers === 1 ? "" : "s"} logged so far.`;
  }

  function refreshAll() {
    document.getElementById("quadrant-select").value = selectedQuadrant;
    populateWeekSelect();
    renderRoads();
    renderStreetList();
    refreshQuadrantBanner();
    renderOrganiserPanel();
  }

  // ── GPS locate ─────────────────────────────────────────────────────────
  function locateMe() {
    if (!navigator.geolocation) { alert("Geolocation isn't available in this browser."); return; }
    navigator.geolocation.getCurrentPosition(pos => {
      const { latitude, longitude } = pos.coords;
      const pt = turf.point([longitude, latitude]);
      let found = null;
      if (quadrantFeatures) {
        for (const feature of quadrantFeatures.features) {
          if (turf.booleanPointInPolygon(pt, feature)) { found = feature.properties.Quadrant; break; }
        }
      }
      if (userMarker) map.removeLayer(userMarker);
      userMarker = L.circleMarker([latitude, longitude], { color: "#000", fillColor: "#fff", fillOpacity: 1, radius: 7, weight: 2 }).addTo(map);

      if (found) {
        selectedQuadrant = found;
        selectedWeek = computeAutoWeek(found);
        refreshAll();
        const feature = quadrantFeatures.features.find(f => f.properties.Quadrant === found);
        map.flyToBounds(L.geoJSON(feature).getBounds(), { maxZoom: 15, duration: 0.8 });
      } else {
        map.flyTo([latitude, longitude], 15, { duration: 0.8 });
        alert("You don't appear to be inside one of the 4 town quadrants — showing your location anyway.");
      }
    }, err => {
      alert("Couldn't get your location: " + err.message);
    }, { enableHighAccuracy: true, timeout: 10000 });
  }

  // ── Auth (Google Identity — same pattern as the canvassing apps) ───────
  function triggerSignIn() {
    if (typeof google === "undefined" || !google.accounts) { alert("Google Sign-In not loaded yet — try again in a moment."); return; }
    google.accounts.id.initialize({ client_id: CFG.GOOGLE_CLIENT_ID, callback: onGoogleSignIn, auto_select: false, cancel_on_tap_outside: false });
    google.accounts.id.prompt(n => { if (n.isNotDisplayed() || n.isSkippedMoment()) useOAuthPopupFallback(); });
  }
  function useOAuthPopupFallback() {
    google.accounts.oauth2.initTokenClient({
      client_id: CFG.GOOGLE_CLIENT_ID, scope: "openid email profile",
      callback: async tr => {
        if (tr.error) { alert("Sign-in failed: " + tr.error); return; }
        try {
          const info = await (await fetch("https://www.googleapis.com/oauth2/v3/userinfo", { headers: { Authorization: "Bearer " + tr.access_token } })).json();
          await processSignIn(null, info.email, tr.access_token);
        } catch (e) { alert("Sign-in error: " + e.message); }
      },
    }).requestAccessToken({ prompt: "select_account" });
  }
  async function onGoogleSignIn(response) { await processSignIn(response.credential, null, null); }
  async function processSignIn(idToken, emailHint, accessToken) {
    try {
      const payload = idToken ? { action: "verify", idToken } : { action: "verify", accessToken, email: emailHint };
      const data = await (await fetch(CFG.APPS_SCRIPT_URL, { method: "POST", body: JSON.stringify(payload) })).json();
      if (!data.ok) { alert(data.error || "Verification failed."); return; }
      authToken = idToken || accessToken; authTokenType = idToken ? "idToken" : "accessToken";
      authEmail = data.email || emailHint; authAuthorised = data.authorised === true;
      document.getElementById("signin-btn").textContent = authAuthorised ? ("Signed in: " + authEmail) : "Signed in (not an organiser)";
      renderOrganiserPanel();
      renderStreetList(); // popups need re-render to show edit fields next time opened
    } catch (e) { alert("Network error: " + e.message); }
  }

  function authPayloadBase() {
    return authTokenType === "idToken" ? { idToken: authToken } : { accessToken: authToken, email: authEmail };
  }

  // ── Organiser controls ──────────────────────────────────────────────────
  function organiserRoadEditHtml(road) {
    return `
      <div class="organiser-edit">
        <label>What's here (e.g. "72 homes and 4 shops") <input type="text" class="edit-residences" value="${escapeHtml(road.Residences || "")}"></label>
        <label>Notes <textarea class="edit-notes">${escapeHtml(road.Notes || "")}</textarea></label>
        <button class="save-road-btn">Save</button>
      </div>`;
  }
  function wireOrganiserRoadEdit(div, road) {
    const btn = div.querySelector(".save-road-btn");
    if (!btn) return;
    btn.addEventListener("click", () => {
      const residences = div.querySelector(".edit-residences").value;
      const notes = div.querySelector(".edit-notes").value;
      fetch(CFG.APPS_SCRIPT_URL, {
        method: "POST",
        body: JSON.stringify({ action: "updateRoad", ...authPayloadBase(), street: road.Street, quadrant: road.Quadrant, residences, notes }),
      }).then(r => r.json()).then(data => {
        if (data.ok) {
          road.Residences = residences; road.Notes = notes;
          renderPopupContent(div, road);
        } else alert(data.error || "Save failed.");
      });
    });
  }

  function renderOrganiserPanel() {
    const panel = document.getElementById("organiser-panel");
    if (!authAuthorised) { panel.hidden = true; panel.innerHTML = ""; return; }
    panel.hidden = false;
    const quadrantRoads = allRoads.filter(r => r.Quadrant === selectedQuadrant && r.RotationGroup >= 0);
    const byGroup = {};
    quadrantRoads.forEach(r => { (byGroup[r.RotationGroup] = byGroup[r.RotationGroup] || []).push(r.Street); });
    const groupsHtml = Object.keys(byGroup).sort((a, b) => a - b).map(g => `
      <optgroup label="Week ${parseInt(g, 10) + 1}">
        ${byGroup[g].map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join("")}
      </optgroup>`).join("");

    panel.innerHTML = `
      <h3>Set this week's focus — ${escapeHtml(selectedQuadrant)}</h3>
      <select id="focus-picker" multiple size="8">${groupsHtml}</select>
      <button id="save-focus-btn">Save as this week's focus</button>
      <button id="clear-focus-btn">Clear override (use auto-rotation)</button>
      <h3>Points of interest</h3>
      <button id="add-poi-btn">📍 Add a pin (church, shop, anywhere)</button>
    `;
    document.getElementById("add-poi-btn").addEventListener("click", startPlacingPoi);
    document.getElementById("save-focus-btn").addEventListener("click", () => {
      const picked = Array.from(document.getElementById("focus-picker").selectedOptions).map(o => o.value);
      if (!picked.length) { alert("Select at least one street."); return; }
      fetch(CFG.APPS_SCRIPT_URL, {
        method: "POST",
        body: JSON.stringify({ action: "setFocus", ...authPayloadBase(), quadrant: selectedQuadrant, streets: picked }),
      }).then(r => r.json()).then(data => {
        if (data.ok) {
          focusByQuadrant[selectedQuadrant].overrideActive = true;
          focusByQuadrant[selectedQuadrant].overrideStreets = picked;
          refreshAll();
        } else alert(data.error || "Save failed.");
      });
    });
    document.getElementById("clear-focus-btn").addEventListener("click", () => {
      fetch(CFG.APPS_SCRIPT_URL, {
        method: "POST",
        body: JSON.stringify({ action: "clearFocus", ...authPayloadBase(), quadrant: selectedQuadrant }),
      }).then(r => r.json()).then(data => {
        if (data.ok) {
          focusByQuadrant[selectedQuadrant].overrideActive = false;
          focusByQuadrant[selectedQuadrant].overrideStreets = [];
          refreshAll();
        } else alert(data.error || "Clear failed.");
      });
    });
  }

  function registerServiceWorker() {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    }
  }

  // ── Init ───────────────────────────────────────────────────────────────
  function init() {
    buildShell();
    initMap();
    registerServiceWorker();
    loadAll().then(() => {
      selectedWeek = computeAutoWeek(selectedQuadrant);
      renderQuadrantOutlines();
      renderPois();
      refreshAll();
    }).catch(err => {
      document.getElementById("street-list").innerHTML = `<p class="error">Failed to load data: ${escapeHtml(err.message)}</p>`;
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
