/**
 * Main Dashboard Application
 * Handles UI updates and real-time data
 */
const DashboardApp = (() => {
  let updateInterval = null;
  let currentTab = "overview";

  /**
   * Initialize the dashboard
   */
  function init() {
    setupTabNavigation();
    setupEventListeners();
    connectToSSE();
    fetchInitialData();

    // Periodic polling as fallback (every 5 seconds)
    updateInterval = setInterval(fetchUpdate, 5000);
  }

  /**
   * Setup tab navigation
   */
  function setupTabNavigation() {
    const tabs = document.querySelectorAll(".tab");
    tabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        const tabName = tab.dataset.tab;
        switchTab(tabName);
      });
    });
  }

  /**
   * Switch to a tab
   */
  function switchTab(tabName) {
    currentTab = tabName;

    // Update tab buttons
    document.querySelectorAll(".tab").forEach((t) => {
      t.classList.toggle("active", t.dataset.tab === tabName);
    });

    // Update tab content
    document.querySelectorAll(".tab-content").forEach((content) => {
      content.classList.toggle("active", content.id === `tab-${tabName}`);
    });
  }

  /**
   * Setup event listeners
   */
  function setupEventListeners() {
    // Handle window resize for charts
    window.addEventListener("resize", debounce(() => {
      if (currentTab === "overview") {
        updateOverviewCharts();
      }
    }, 250));
  }

  /**
   * Connect to SSE for real-time updates
   */
  function connectToSSE() {
    DashboardAPI.connectSSE(
      // State update
      (state) => {
        updateDashboard(state);
        updateConnectionStatus(true);
      },
      // Connected
      () => {
        updateConnectionStatus(true);
      },
      // Disconnected
      () => {
        updateConnectionStatus(false);
      }
    );
  }

  /**
   * Fetch initial data
   */
  async function fetchInitialData() {
    try {
      const state = await DashboardAPI.getState();
      updateDashboard(state);
    } catch (error) {
      console.error("Failed to fetch initial data:", error);
    }
  }

  /**
   * Fetch update (fallback polling)
   */
  async function fetchUpdate() {
    try {
      const state = await DashboardAPI.getState();
      updateDashboard(state);
    } catch (error) {
      // Silently ignore polling errors
    }
  }

  /**
   * Update connection status indicator
   */
  function updateConnectionStatus(connected) {
    const statusBadge = document.getElementById("connection-status");
    if (statusBadge) {
      statusBadge.textContent = connected ? "Connected" : "Disconnected";
      statusBadge.className = `status-badge ${connected ? "connected" : "disconnected"}`;
    }
  }

  /**
   * Update last update timestamp
   */
  function updateLastUpdateTime() {
    const lastUpdate = document.getElementById("last-update");
    if (lastUpdate) {
      lastUpdate.textContent = `Updated: ${new Date().toLocaleTimeString()}`;
    }
  }

  /**
   * Update the entire dashboard with new state
   */
  function updateDashboard(state) {
    if (!state) return;

    updateLastUpdateTime();
    updateStats(state);

    if (currentTab === "overview") {
      updateOverviewCharts();
      updateRecentActivity(state);
    } else if (currentTab === "workers") {
      updateWorkersTable(state);
    } else if (currentTab === "tasks") {
      updateTasksTable(state);
    } else if (currentTab === "events") {
      updateEventsTable(state);
    } else if (currentTab === "chains") {
      updateChainsTable(state);
    }
  }

  /**
   * Update statistics cards
   */
  function updateStats(state) {
    const workers = state.workers ?? [];
    const pendingTasks = state.pending_tasks ?? [];
    const inProgressTasks = state.in_progress_tasks ?? [];
    const completedTasks = state.completed_tasks ?? [];

    setTextContent("stat-workers", workers.length.toString());
    setTextContent("stat-pending", pendingTasks.length.toString());
    setTextContent("stat-progress", inProgressTasks.length.toString());
    setTextContent("stat-completed", completedTasks.length.toString());
  }

  /**
   * Update overview charts
   */
  function updateOverviewCharts() {
    const state = DashboardAPI.getLastState();
    if (!state) return;

    // Worker status chart
    const workers = state.workers ?? [];
    const workerStatus = {};
    workers.forEach((w) => {
      const status = w.status || "unknown";
      workerStatus[status] = (workerStatus[status] || 0) + 1;
    });
    DashboardCharts.drawPieChart("chart-worker-status", workerStatus);

    // Task status chart
    const pendingTasks = state.pending_tasks ?? [];
    const inProgressTasks = state.in_progress_tasks ?? [];
    const completedTasks = state.completed_tasks ?? [];
    const taskStatus = {
      pending: pendingTasks.length,
      in_progress: inProgressTasks.length,
      completed: completedTasks.length,
    };
    DashboardCharts.drawPieChart("chart-task-status", taskStatus);

    // Events timeline
    const events = state.events ?? [];
    DashboardCharts.drawTimelineChart("chart-events-timeline", events.slice(-20));
  }

  /**
   * Update recent activity list
   */
  function updateRecentActivity(state) {
    const activityList = document.getElementById("recent-activity");
    if (!activityList) return;

    const events = state.events ?? [];
    const recentEvents = events.slice(-10).reverse();

    if (recentEvents.length === 0) {
      activityList.innerHTML = '<li class="activity-item">No recent activity</li>';
      return;
    }

    activityList.innerHTML = recentEvents
      .map((event) => {
        const time = new Date(event.timestamp).toLocaleTimeString();
        return `<li class="activity-item">
          <span class="timestamp">${time}</span>
          ${event.type}: ${event.instance_id ?? event.task_id ?? "N/A"}
        </li>`;
      })
      .join("");
  }

  /**
   * Update workers table
   */
  function updateWorkersTable(state) {
    const tbody = document.getElementById("workers-tbody");
    if (!tbody) return;

    const workers = state.workers ?? [];

    if (workers.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No workers found</td></tr>';
      return;
    }

    tbody.innerHTML = workers
      .map((worker) => {
        const statusClass = `status-${worker.status || "idle"}`;
        const lastHeartbeat = worker.last_heartbeat
          ? new Date(worker.last_heartbeat).toLocaleString()
          : "--";
        const connectedSince = worker.connected_since
          ? new Date(worker.connected_since).toLocaleString()
          : "--";

        return `<tr>
          <td>${escapeHtml(worker.name)}</td>
          <td><span class="${statusClass}">${worker.status || "idle"}</span></td>
          <td>${worker.role || "executor"}</td>
          <td>${worker.current_task_id ?? "--"}</td>
          <td>${lastHeartbeat}</td>
          <td>${connectedSince}</td>
        </tr>`;
      })
      .join("");
  }

  /**
   * Update tasks tables
   */
  function updateTasksTable(state) {
    const pendingTbody = document.getElementById("pending-tasks-tbody");
    const progressTbody = document.getElementById("progress-tasks-tbody");

    const pendingTasks = state.pending_tasks ?? [];
    const inProgressTasks = state.in_progress_tasks ?? [];

    if (pendingTbody) {
      if (pendingTasks.length === 0) {
        pendingTbody.innerHTML = '<tr><td colspan="5" class="empty-state">No pending tasks</td></tr>';
      } else {
        pendingTbody.innerHTML = pendingTasks
          .map((task) => `<tr>
            <td>${escapeHtml(task.id)}</td>
            <td>${escapeHtml(task.subject ?? "--")}</td>
            <td>${task.status}</td>
            <td>${task.owner ?? "--"}</td>
            <td>${task.created_at ? new Date(task.created_at).toLocaleString() : "--"}</td>
          </tr>`)
          .join("");
      }
    }

    if (progressTbody) {
      if (inProgressTasks.length === 0) {
        progressTbody.innerHTML = '<tr><td colspan="5" class="empty-state">No tasks in progress</td></tr>';
      } else {
        progressTbody.innerHTML = inProgressTasks
          .map((task) => `<tr>
            <td>${escapeHtml(task.id)}</td>
            <td>${escapeHtml(task.subject ?? "--")}</td>
            <td>${task.status}</td>
            <td>${task.owner ?? "--"}</td>
            <td>${task.started_at ? new Date(task.started_at).toLocaleString() : "--"}</td>
          </tr>`)
          .join("");
      }
    }
  }

  /**
   * Update events table
   */
  function updateEventsTable(state) {
    const tbody = document.getElementById("events-tbody");
    if (!tbody) return;

    const events = state.events ?? [];

    if (events.length === 0) {
      tbody.innerHTML = '<tr><td colspan="3" class="empty-state">No events</td></tr>';
      return;
    }

    tbody.innerHTML = events
      .slice(-50)
      .reverse()
      .map((event) => {
        const time = new Date(event.timestamp).toLocaleString();
        const details = JSON.stringify(event).slice(0, 100);

        return `<tr>
          <td>${time}</td>
          <td>${event.type}</td>
          <td>${escapeHtml(details)}</td>
        </tr>`;
      })
      .join("");
  }

  /**
   * Update chains table
   */
  function updateChainsTable(state) {
    const tbody = document.getElementById("chains-tbody");
    if (!tbody) return;

    const chains = state.chains ?? [];

    if (chains.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" class="empty-state">No chains found</td></tr>';
      return;
    }

    tbody.innerHTML = chains
      .map((chain) => {
        const lastUpdated = chain.updated_at
          ? new Date(chain.updated_at).toLocaleString()
          : "--";

        return `<tr>
          <td>${escapeHtml(chain.id ?? "--")}</td>
          <td>${chain.operations?.length ?? 0}</td>
          <td>${chain.status ?? "unknown"}</td>
          <td>${lastUpdated}</td>
        </tr>`;
      })
      .join("");
  }

  /**
   * Utility: Set text content safely
   */
  function setTextContent(id, text) {
    const element = document.getElementById(id);
    if (element) {
      element.textContent = text;
    }
  }

  /**
   * Utility: Escape HTML
   */
  function escapeHtml(str) {
    if (!str) return "";
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  /**
   * Utility: Debounce function
   */
  function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  }

  /**
   * Cleanup when leaving the page
   */
  function destroy() {
    if (updateInterval) {
      clearInterval(updateInterval);
    }
    DashboardAPI.disconnectSSE();
  }

  return {
    init,
    destroy,
    switchTab,
  };
})();

// Initialize dashboard when DOM is ready
document.addEventListener("DOMContentLoaded", () => {
  DashboardApp.init();
});

// Cleanup on page unload
window.addEventListener("beforeunload", () => {
  DashboardApp.destroy();
});
