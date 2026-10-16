"use strict";

const $ = id => document.getElementById(id);

let currentUser = null;
let streetLights = [];
let faultReports = [];
let sensorData = [];
let refreshTimer = null;
let isLoading = false;

async function apiRequest(url, options = {}) {
    const isFormData = options.body instanceof FormData;

    const response = await fetch(url, {
        ...options,
        headers: {
            ...(options.body && !isFormData
                ? { "Content-Type": "application/json" }
                : {}),
            ...(options.headers || {})
        }
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
        throw new Error(data.message || `Request failed (${response.status})`);
    }

    return data;
}

function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>"']/g, character => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
    })[character]);
}

function setText(id, value) {
    const element = $(id);
    if (element) {
        element.textContent =
            value === null || value === undefined || value === "" ? "--" : value;
    }
}

function normalize(value) {
    return String(value ?? "").trim();
}

function sameID(a, b) {
    return normalize(a).toLowerCase() === normalize(b).toLowerCase();
}

function formatDate(value) {
    if (!value) return "--";

    const date = new Date(
        typeof value === "string" && value.includes(" ")
            ? value.replace(" ", "T")
            : value
    );

    if (Number.isNaN(date.getTime())) return String(value);

    return date.toLocaleString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit"
    });
}

function isResolved(fault) {
    return normalize(fault.Status).toLowerCase() === "resolved";
}

function isUnresolved(fault) {
    return !isResolved(fault);
}

function showMessage(id, message, success = false) {
    const element = $(id);
    if (!element) return;
    element.textContent = message;
    element.style.color = success ? "#15803d" : "#dc2626";
}

/* LOGIN */

$("loginForm").addEventListener("submit", async function (event) {
    event.preventDefault();

    const username = normalize($("username").value);
    const password = $("password").value;
    const message = $("loginMessage");
    const button = this.querySelector('[type="submit"]');

    message.textContent = "";
    button.disabled = true;
    button.innerHTML = '<span>Signing in...</span><i class="fa-solid fa-spinner fa-spin"></i>';

    try {
        const result = await apiRequest("/api/login", {
            method: "POST",
            body: JSON.stringify({ username, password })
        });

        if (!result.success) {
            throw new Error(result.message || "Login failed.");
        }

        currentUser = result.user || { username };

        sessionStorage.setItem(
            "smartStreetLightUser",
            JSON.stringify(currentUser)
        );

        showDashboard();
        await loadDatabaseData();
        startLiveRefresh();

    } catch (error) {
        message.textContent = error.message || "Unable to connect to the backend.";
    } finally {
        button.disabled = false;
        button.innerHTML = '<span>Enter control center</span><i class="fa-solid fa-arrow-right"></i>';
    }
});

/* SHOW / HIDE PASSWORD */

$("togglePassword").addEventListener("click", function () {
    const input = $("password");
    const show = input.type === "password";

    input.type = show ? "text" : "password";
    this.innerHTML = show
        ? '<i class="fa-regular fa-eye-slash"></i>'
        : '<i class="fa-regular fa-eye"></i>';

    this.setAttribute("aria-label", show ? "Hide password" : "Show password");
});

/* PAGE SWITCHING */

function showDashboard() {
    $("loginPage").classList.add("hidden");
    $("dashboardPage").classList.remove("hidden");

    setText(
        "userAvatar",
        (currentUser?.username || "U").charAt(0).toUpperCase()
    );
}

function showLogin() {
    stopLiveRefresh();
    currentUser = null;

    sessionStorage.removeItem("smartStreetLightUser");

    $("dashboardPage").classList.add("hidden");
    $("loginPage").classList.remove("hidden");
    $("password").value = "";
    $("loginMessage").textContent = "";
}

/* LOAD DATABASE DATA */

async function loadDatabaseData() {
    if (isLoading) return;

    isLoading = true;

    try {
        const [lights, faults, sensors] = await Promise.all([
            apiRequest("/api/lights"),
            apiRequest("/api/faults"),
            apiRequest("/api/sensors")
        ]);

        streetLights = Array.isArray(lights) ? lights : [];
        faultReports = Array.isArray(faults) ? faults : [];
        sensorData = Array.isArray(sensors) ? sensors : [];

        updateConnection(true);
        updateDashboard();

        setText(
            "lastUpdated",
            "Last updated: " + new Date().toLocaleTimeString("en-IN")
        );
    } catch (error) {
        console.error("Database loading error:", error);
        updateConnection(false);
    } finally {
        isLoading = false;
    }
}

function updateConnection(connected) {
    const text = $("connectionText");
    const dot = document.querySelector(".connection-status .status-dot");

    if (text) {
        text.textContent = connected ? "Database connected" : "Connection failed";
    }

    if (dot) {
        dot.classList.toggle("online", connected);
        dot.classList.toggle("offline", !connected);
    }
}

function startLiveRefresh() {
    stopLiveRefresh();
    refreshTimer = setInterval(loadDatabaseData, 5000);
}

function stopLiveRefresh() {
    if (refreshTimer !== null) {
        clearInterval(refreshTimer);
        refreshTimer = null;
    }
}

/* FAULT STATUS */

function getLightStatus(lightId) {
    const relatedFaults = faultReports.filter(f => sameID(f.LightID, lightId));

    if (!relatedFaults.length) return "normal";
    return relatedFaults.some(isUnresolved) ? "fault" : "resolved";
}

function getStatusBadge(status) {
    const value = normalize(status).toLowerCase();

    if (value === "resolved") {
        return '<span class="badge badge-resolved">Resolved</span>';
    }
    if (value === "normal") {
        return '<span class="badge badge-normal">Normal</span>';
    }
    if (value === "fault") {
        return '<span class="badge badge-fault">Fault</span>';
    }
    if (value === "on") {
        return '<span class="badge badge-normal">ON</span>';
    }
    if (value === "off") {
        return '<span class="badge badge-neutral">OFF</span>';
    }
    if (value === "in progress" || value === "pending") {
        return `<span class="badge badge-progress">${escapeHTML(status)}</span>`;
    }

    return `<span class="badge badge-neutral">${escapeHTML(status || "Unknown")}</span>`;
}

/* NOTIFICATION BELL */

function updateFaultNotifications() {
    const count = faultReports.filter(isUnresolved).length;
    const badge = $("notificationCount");
    const button = $("notificationButton");

    if (badge) {
        badge.textContent = count > 99 ? "99+" : String(count);
        badge.classList.toggle("hidden", count === 0);
    }

    if (button) {
        button.title = `${count} unresolved fault${count === 1 ? "" : "s"}`;
        button.setAttribute(
            "aria-label",
            `${count} unresolved fault${count === 1 ? "" : "s"}`
        );
    }
}

$("notificationButton").addEventListener("click", () => {
    showSection("faultsSection");
    $("faultFilter").value = "unresolved";
    renderFaultTable();
});

/* DASHBOARD */

function updateDashboard() {
    updateStatistics();
    renderStreetLightGrid();
    renderRecentFaults();
    renderFaultTable();
    renderStreetLightTable();
    populateSensorDropdown();
    renderSensorData();
    updateFaultNotifications();
}

function updateStatistics() {
    setText("totalLights", streetLights.length);
    setText("totalFaults", faultReports.filter(isUnresolved).length);
    setText("resolvedFaults", faultReports.filter(isResolved).length);
    setText("totalReadings", sensorData.length);

    const latest = sensorData[0];
    setText("latestVoltage", latest?.Voltage);
    setText("latestCurrent", latest?.["Current(A)"]);
    setText("latestBrightness", latest?.["Brightness(Lux)"]);
}

function getLatestSensor(lightId) {
    return sensorData.find(sensor => sameID(sensor.LightID, lightId));
}

function renderStreetLightGrid() {
    const container = $("streetLightGrid");

    if (!streetLights.length) {
        container.innerHTML =
            '<p class="empty-state">No street lights found. Submit a hardware reading or report a fault to register a light.</p>';
        return;
    }

    container.innerHTML = streetLights.map(light => {
        const id = light.LightID || "";
        const sensor = getLatestSensor(id);
        const status = getLightStatus(id);
        const hasFault = status === "fault";

        return `
            <article class="light-card ${hasFault ? "has-fault" : ""}">
                <div class="light-card-top">
                    <div class="light-symbol" title="${hasFault ? "Unresolved fault" : "Street light"}">
                        <i class="fa-solid fa-lightbulb"></i>
                    </div>
                    ${getStatusBadge(status)}
                </div>
                <h3>${escapeHTML(id)}</h3>
                <p>${escapeHTML(light.Area || "Area not specified")}</p>
                <div class="light-metrics">
                    <span>Voltage<strong>${escapeHTML(sensor?.Voltage ?? "--")} V</strong></span>
                    <span>Current<strong>${escapeHTML(sensor?.["Current(A)"] ?? "--")} A</strong></span>
                    <span>Brightness<strong>${escapeHTML(sensor?.["Brightness(Lux)"] ?? "--")} lux</strong></span>
                </div>
            </article>
        `;
    }).join("");
}

function renderRecentFaults() {
    const tbody = $("recentFaultTable");
    const recent = [...faultReports]
        .sort((a, b) => new Date(b.ReportedTime || 0) - new Date(a.ReportedTime || 0))
        .slice(0, 5);

    if (!recent.length) {
        tbody.innerHTML = '<tr><td colspan="6">No fault reports found.</td></tr>';
        return;
    }

    tbody.innerHTML = recent.map(fault => `
        <tr>
            <td>#${escapeHTML(fault.FaultID)}</td>
            <td>${escapeHTML(fault.LightID)}</td>
            <td>${escapeHTML(fault.Area || "--")}</td>
            <td>${escapeHTML(fault.FaultType)}</td>
            <td>${escapeHTML(formatDate(fault.ReportedTime))}</td>
            <td>${getStatusBadge(fault.Status)}</td>
        </tr>
    `).join("");
}

/* FAULT REPORT TABLE AND PHOTO LINKS */

function getPhotoURL(path) {
    if (!path) return "";
    if (/^https?:\/\//i.test(path)) return path;

    return `${window.location.origin}/${String(path).replace(/^\/+/, "")}`;
}

function photoCell(fault) {
    const path = fault.PhotoPath || fault.photo_path || fault.photoPath || "";

    if (!path) return "—";

    return `<a class="photo-link" href="${escapeHTML(getPhotoURL(path))}"
        target="_blank" rel="noopener noreferrer">
        <i class="fa-regular fa-image"></i> View photo
    </a>`;
}

function renderFaultTable() {
    const tbody = $("faultTable");
    const filter = $("faultFilter").value;

    let rows = [...faultReports];

    if (filter === "resolved") rows = rows.filter(isResolved);
    if (filter === "unresolved") rows = rows.filter(isUnresolved);

    if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="9">No matching fault reports.</td></tr>';
        return;
    }

    tbody.innerHTML = rows.map(fault => {
        const resolved = isResolved(fault);

        return `
            <tr>
                <td>#${escapeHTML(fault.FaultID)}</td>
                <td>${escapeHTML(fault.LightID)}</td>
                <td>${escapeHTML(fault.Area || "--")}</td>
                <td>${escapeHTML(fault.FaultType)}</td>
                <td><span class="priority-badge ${escapeHTML(String(fault.Priority || "Medium").toLowerCase())}">${escapeHTML(fault.Priority || "Medium")}</span></td>
                <td>${escapeHTML(formatDate(fault.ReportedTime))}</td>
                <td>${getStatusBadge(fault.Status)}</td>
                <td>${photoCell(fault)}</td>
                <td>
                    <button class="small-button"
                        data-resolve-light="${escapeHTML(fault.LightID)}"
                        ${resolved ? "disabled" : ""}>
                        ${resolved ? "Resolved" : "Resolve"}
                    </button>
                </td>
            </tr>
        `;
    }).join("");
}

$("faultTable").addEventListener("click", async event => {
    const button = event.target.closest("[data-resolve-light]");
    if (!button || button.disabled) return;

    const lightId = button.dataset.resolveLight;

    if (!confirm(`Resolve all unresolved faults for ${lightId}?`)) return;

    button.disabled = true;

    try {
        await apiRequest(
            `/api/faults/light/${encodeURIComponent(lightId)}/resolve`,
            { method: "PUT" }
        );

        await loadDatabaseData();
    } catch (error) {
        alert("Could not update fault: " + error.message);
        button.disabled = false;
    }
});

$("faultFilter").addEventListener("change", renderFaultTable);

/* STREET LIGHT TABLE */

function renderStreetLightTable() {
    const tbody = $("lightTable");

    if (!streetLights.length) {
        tbody.innerHTML = '<tr><td colspan="5">No registered street lights.</td></tr>';
        return;
    }

    tbody.innerHTML = streetLights.map(light => `
        <tr>
            <td>${escapeHTML(light.LightID)}</td>
            <td>${escapeHTML(light.Area || "--")}</td>
            <td>${escapeHTML(light.Latitude ?? "--")}</td>
            <td>${escapeHTML(light.Longitude ?? "--")}</td>
            <td>${getStatusBadge(getLightStatus(light.LightID))}</td>
        </tr>
    `).join("");
}

/* SENSOR TABLE */

function populateSensorDropdown() {
    const select = $("sensorFilter");
    const previous = select.value;

    const ids = [...new Set(sensorData.map(sensor => sensor.LightID).filter(Boolean))];

    select.innerHTML = '<option value="all">All street lights</option>' +
        ids.map(id => `<option value="${escapeHTML(id)}">${escapeHTML(id)}</option>`).join("");

    select.value = ids.includes(previous) ? previous : "all";
}

function renderSensorData() {
    const tbody = $("sensorTable");
    const filter = $("sensorFilter").value;

    const rows = filter === "all"
        ? sensorData
        : sensorData.filter(sensor => sameID(sensor.LightID, filter));

    if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="6">No sensor readings found.</td></tr>';
        return;
    }

    tbody.innerHTML = rows.map(sensor => `
        <tr>
            <td>${escapeHTML(sensor.LightID)}</td>
            <td>${escapeHTML(formatDate(sensor.Timestamp))}</td>
            <td>${escapeHTML(sensor.Voltage ?? "--")}</td>
            <td>${escapeHTML(sensor["Current(A)"] ?? "--")}</td>
            <td>${escapeHTML(sensor["Brightness(Lux)"] ?? "--")}</td>
            <td>${getStatusBadge(sensor.LightStatus || "Unknown")}</td>
        </tr>
    `).join("");
}

$("sensorFilter").addEventListener("change", renderSensorData);

/* FAULT FORM */

function openFaultForm() {
    showSection("faultsSection");
    $("faultForm").classList.remove("hidden");
    $("faultForm").scrollIntoView({ behavior: "smooth", block: "start" });
}

$("showFaultForm").addEventListener("click", openFaultForm);
$("showFaultFormAlt").addEventListener("click", openFaultForm);

$("cancelFaultForm").addEventListener("click", () => {
    $("faultForm").reset();
    $("faultMessage").textContent = "";
    $("faultForm").classList.add("hidden");
    $("faultPhotoPreview").removeAttribute("src");
    $("faultPhotoPreview").classList.add("hidden");
});

/* PHOTO PREVIEW */

$("faultPhoto").addEventListener("change", () => {
    const file = $("faultPhoto").files[0];
    const preview = $("faultPhotoPreview");

    preview.removeAttribute("src");
    preview.classList.add("hidden");

    if (!file) return;

    const allowedTypes = ["image/jpeg", "image/png", "image/webp"];

    if (!allowedTypes.includes(file.type)) {
        $("faultPhoto").value = "";
        showMessage("faultMessage", "Choose a JPG, PNG, or WEBP image.");
        return;
    }

    if (file.size > 5 * 1024 * 1024) {
        $("faultPhoto").value = "";
        showMessage("faultMessage", "Photo must be 5 MB or smaller.");
        return;
    }

    preview.src = URL.createObjectURL(file);
    preview.classList.remove("hidden");
    showMessage("faultMessage", "");
});

/* SAVE FAULT REPORT */

$("faultForm").addEventListener("submit", async function (event) {
    event.preventDefault();

    const button = this.querySelector('[type="submit"]');
    const file = $("faultPhoto").files[0];

    if (file && file.size > 5 * 1024 * 1024) {
        showMessage("faultMessage", "Photo must be 5 MB or smaller.");
        return;
    }

    const formData = new FormData();

    formData.append("lightId", normalize($("faultLightId").value));
    formData.append("area", normalize($("faultArea").value));
    formData.append("faultType", normalize($("faultType").value));
    formData.append("priority", $("faultPriority").value);
    formData.append("technician", normalize($("faultTechnician").value));
    formData.append("description", normalize($("faultDescription").value));

    if (file) formData.append("photo", file);

    button.disabled = true;
    button.textContent = "Saving...";
    showMessage("faultMessage", "");

    try {
        const result = await apiRequest("/api/faults", {
            method: "POST",
            body: formData
        });

        this.reset();
        $("faultPhotoPreview").removeAttribute("src");
        $("faultPhotoPreview").classList.add("hidden");
        this.classList.add("hidden");

        await loadDatabaseData();
        showSection("faultsSection");

        showMessage(
            "faultMessage",
            result.message || "Fault report saved successfully.",
            true
        );
    } catch (error) {
        console.error("Fault submission error:", error);
        showMessage("faultMessage", "Could not save fault: " + error.message);
    } finally {
        button.disabled = false;
        button.textContent = "Save Fault Report";
    }
});

/* NAVIGATION */

const sectionTitles = {
    dashboardSection: "Street Light Dashboard",
    faultsSection: "Fault Reports",
    lightsSection: "Street Lights",
    sensorsSection: "Sensor Data"
};

function showSection(sectionId) {
    document.querySelectorAll(".nav-item").forEach(item => {
        item.classList.toggle("active", item.dataset.section === sectionId);
    });

    document.querySelectorAll(".content-section").forEach(section => {
        section.classList.toggle("active-section", section.id === sectionId);
    });

    setText("pageTitle", sectionTitles[sectionId] || "Dashboard");
    $("sidebar").classList.remove("mobile-open");
}

document.querySelectorAll("[data-section]").forEach(button => {
    button.addEventListener("click", () => showSection(button.dataset.section));
});

document.querySelectorAll("[data-go]").forEach(button => {
    button.addEventListener("click", () => showSection(button.dataset.go));
});

$("mobileMenu").addEventListener("click", () => {
    $("sidebar").classList.toggle("mobile-open");
});

$("refreshButton").addEventListener("click", loadDatabaseData);
$("logoutButton").addEventListener("click", showLogin);

/* CLOCK */

function updateClock() {
    setText("clock", new Date().toLocaleTimeString("en-IN"));
}

updateClock();
setInterval(updateClock, 1000);

/* RESTORE SESSION */

async function initializeApp() {
    const savedUser = sessionStorage.getItem("smartStreetLightUser");
    if (!savedUser) return;

    try {
        currentUser = JSON.parse(savedUser);
        await apiRequest("/api/health");

        showDashboard();
        await loadDatabaseData();
        startLiveRefresh();
    } catch (error) {
        console.warn("Backend unavailable:", error.message);
        sessionStorage.removeItem("smartStreetLightUser");
        currentUser = null;
    }
}

initializeApp();