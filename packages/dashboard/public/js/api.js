/**
 * API client for Dashboard
 * Handles REST API calls and SSE connection
 */
const DashboardAPI = (() => {
  let eventSource = null;
  let reconnectTimer = null;
  let lastState = null;

  /**
   * Fetch JSON from API endpoint
   */
  async function fetchJSON(endpoint) {
    try {
      const response = await fetch(endpoint);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      return await response.json();
    } catch (error) {
      console.error(`API fetch error for ${endpoint}:`, error);
      throw error;
    }
  }

  /**
   * Get current orchestrator state
   */
  async function getState() {
    return fetchJSON("/api/state");
  }

  /**
   * Get worker instances
   */
  async function getWorkers() {
    return fetchJSON("/api/workers");
  }

  /**
   * Get tasks
   */
  async function getTasks() {
    return fetchJSON("/api/tasks");
  }

  /**
   * Get events
   */
  async function getEvents(limit = 50) {
    return fetchJSON(`/api/events?limit=${limit}`);
  }

  /**
   * Get audit chains
   */
  async function getChains() {
    return fetchJSON("/api/chains");
  }

  /**
   * Connect to SSE stream for real-time updates
   */
  function connectSSE(onStateUpdate, onConnect, onDisconnect) {
    if (eventSource) {
      eventSource.close();
    }

    eventSource = new EventSource("/api/events/stream");

    eventSource.addEventListener("connected", (event) => {
      console.log("SSE connected:", JSON.parse(event.data));
      onConnect?.();
    });

    eventSource.addEventListener("state", (event) => {
      const state = JSON.parse(event.data);
      lastState = state;
      onStateUpdate?.(state);
    });

    eventSource.onerror = (error) => {
      console.error("SSE error:", error);
      onDisconnect?.();

      // Reconnect after delay
      if (eventSource?.readyState === EventSource.CLOSED) {
        scheduleReconnect(onStateUpdate, onConnect, onDisconnect);
      }
    };

    return eventSource;
  }

  /**
   * Schedule SSE reconnection
   */
  function scheduleReconnect(onStateUpdate, onConnect, onDisconnect) {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
    }

    reconnectTimer = setTimeout(() => {
      console.log("Attempting SSE reconnection...");
      connectSSE(onStateUpdate, onConnect, onDisconnect);
    }, 5000);
  }

  /**
   * Disconnect SSE
   */
  function disconnectSSE() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
  }

  /**
   * Get last known state
   */
  function getLastState() {
    return lastState;
  }

  return {
    fetchJSON,
    getState,
    getWorkers,
    getTasks,
    getEvents,
    getChains,
    connectSSE,
    disconnectSSE,
    getLastState,
  };
})();
