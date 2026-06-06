/**
 * Chart rendering using Canvas API
 * No external dependencies
 */
const DashboardCharts = (() => {
  // Color palette
  const COLORS = {
    idle: "#6366f1",
    busy: "#f59e0b",
    error: "#ef4444",
    connected: "#10b981",
    pending: "#3b82f6",
    in_progress: "#f59e0b",
    completed: "#10b981",
    failed: "#ef4444",
    default: "#94a3b8",
  };

  /**
   * Draw a pie chart
   */
  function drawPieChart(canvasId, data, options = {}) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    const width = canvas.width;
    const height = canvas.height;
    const centerX = width / 2;
    const centerY = height / 2;
    const radius = Math.min(width, height) / 2 - 20;

    // Clear canvas
    ctx.clearRect(0, 0, width, height);

    // Calculate total
    const total = Object.values(data).reduce((sum, val) => sum + val, 0);
    if (total === 0) {
      ctx.fillStyle = "#94a3b8";
      ctx.font = "14px -apple-system, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("No data", centerX, centerY);
      return;
    }

    // Draw pie slices
    let startAngle = -Math.PI / 2;
    const entries = Object.entries(data);

    entries.forEach(([label, value]) => {
      if (value === 0) return;

      const sliceAngle = (value / total) * 2 * Math.PI;
      const endAngle = startAngle + sliceAngle;

      // Draw slice
      ctx.beginPath();
      ctx.moveTo(centerX, centerY);
      ctx.arc(centerX, centerY, radius, startAngle, endAngle);
      ctx.closePath();
      ctx.fillStyle = COLORS[label] || COLORS.default;
      ctx.fill();

      // Draw label
      const midAngle = startAngle + sliceAngle / 2;
      const labelRadius = radius * 0.65;
      const labelX = centerX + Math.cos(midAngle) * labelRadius;
      const labelY = centerY + Math.sin(midAngle) * labelRadius;

      if (sliceAngle > 0.3) {
        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 12px -apple-system, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(value.toString(), labelX, labelY);
      }

      startAngle = endAngle;
    });

    // Draw legend
    const legendX = width - 100;
    let legendY = 20;

    entries.forEach(([label, value]) => {
      if (value === 0) return;

      ctx.fillStyle = COLORS[label] || COLORS.default;
      ctx.fillRect(legendX, legendY, 12, 12);

      ctx.fillStyle = "#1e293b";
      ctx.font = "11px -apple-system, sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(`${label} (${value})`, legendX + 18, legendY + 6);

      legendY += 18;
    });
  }

  /**
   * Draw a bar chart
   */
  function drawBarChart(canvasId, data, options = {}) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    const width = canvas.width;
    const height = canvas.height;
    const padding = { top: 20, right: 20, bottom: 40, left: 50 };

    // Clear canvas
    ctx.clearRect(0, 0, width, height);

    const entries = Object.entries(data);
    if (entries.length === 0) {
      ctx.fillStyle = "#94a3b8";
      ctx.font = "14px -apple-system, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("No data", width / 2, height / 2);
      return;
    }

    // Calculate dimensions
    const chartWidth = width - padding.left - padding.right;
    const chartHeight = height - padding.top - padding.bottom;
    const maxValue = Math.max(...entries.map(([, val]) => val), 1);
    const barWidth = Math.min(40, chartWidth / entries.length - 10);
    const barSpacing = (chartWidth - barWidth * entries.length) / (entries.length + 1);

    // Draw bars
    entries.forEach(([label, value], index) => {
      const barHeight = (value / maxValue) * chartHeight;
      const x = padding.left + barSpacing + index * (barWidth + barSpacing);
      const y = padding.top + chartHeight - barHeight;

      // Draw bar
      ctx.fillStyle = COLORS[label] || COLORS.primary || "#3b82f6";
      ctx.fillRect(x, y, barWidth, barHeight);

      // Draw value on top
      if (barHeight > 20) {
        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 11px -apple-system, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(value.toString(), x + barWidth / 2, y + 15);
      }

      // Draw label
      ctx.fillStyle = "#64748b";
      ctx.font = "10px -apple-system, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(label, x + barWidth / 2, height - padding.bottom + 15);
    });

    // Draw Y-axis
    ctx.strokeStyle = "#e2e8f0";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padding.left, padding.top);
    ctx.lineTo(padding.left, padding.top + chartHeight);
    ctx.stroke();

    // Draw X-axis
    ctx.beginPath();
    ctx.moveTo(padding.left, padding.top + chartHeight);
    ctx.lineTo(padding.left + chartWidth, padding.top + chartHeight);
    ctx.stroke();
  }

  /**
   * Draw a timeline chart
   */
  function drawTimelineChart(canvasId, events, options = {}) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    const width = canvas.width;
    const height = canvas.height;
    const padding = { top: 20, right: 20, bottom: 30, left: 20 };

    // Clear canvas
    ctx.clearRect(0, 0, width, height);

    if (!events || events.length === 0) {
      ctx.fillStyle = "#94a3b8";
      ctx.font = "14px -apple-system, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("No events", width / 2, height / 2);
      return;
    }

    // Sort events by timestamp
    const sortedEvents = [...events].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    // Calculate time range
    const firstTime = new Date(sortedEvents[0].timestamp).getTime();
    const lastTime = new Date(sortedEvents[sortedEvents.length - 1].timestamp).getTime();
    const timeRange = Math.max(lastTime - firstTime, 1);

    const chartWidth = width - padding.left - padding.right;
    const chartHeight = height - padding.top - padding.bottom;

    // Draw timeline line
    ctx.strokeStyle = "#e2e8f0";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(padding.left, padding.top + chartHeight / 2);
    ctx.lineTo(padding.left + chartWidth, padding.top + chartHeight / 2);
    ctx.stroke();

    // Draw event points
    const typeColors = {
      state: "#3b82f6",
      worker_connected: "#10b981",
      worker_disconnected: "#ef4444",
      task_created: "#6366f1",
      task_completed: "#10b981",
      task_failed: "#ef4444",
    };

    sortedEvents.forEach((event) => {
      const eventTime = new Date(event.timestamp).getTime();
      const x = padding.left + ((eventTime - firstTime) / timeRange) * chartWidth;
      const y = padding.top + chartHeight / 2;

      // Draw point
      ctx.beginPath();
      ctx.arc(x, y, 6, 0, 2 * Math.PI);
      ctx.fillStyle = typeColors[event.type] || COLORS.default;
      ctx.fill();

      // Draw event type label
      ctx.fillStyle = "#64748b";
      ctx.font = "9px -apple-system, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(event.type, x, y - 12);
    });

    // Draw time labels
    ctx.fillStyle = "#94a3b8";
    ctx.font = "10px -apple-system, sans-serif";
    ctx.textAlign = "center";

    // First and last time
    const firstDate = new Date(firstTime);
    const lastDate = new Date(lastTime);

    ctx.fillText(
      firstDate.toLocaleTimeString(),
      padding.left,
      height - 10
    );
    ctx.fillText(
      lastDate.toLocaleTimeString(),
      padding.left + chartWidth,
      height - 10
    );
  }

  /**
   * Clear a canvas
   */
  function clearCanvas(canvasId) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  return {
    drawPieChart,
    drawBarChart,
    drawTimelineChart,
    clearCanvas,
    COLORS,
  };
})();
