// API documentation generator for dashboard endpoints

export interface ApiEndpoint {
  method: string;
  path: string;
  description: string;
  query?: Record<string, string>;
  body?: string;
  response: string;
  auth: boolean;
  rateLimit?: string;
}

/**
 * Get documentation for all API endpoints.
 */
export function getApiDocs(): ApiEndpoint[] {
  return [
    {
      method: "GET",
      path: "/api/state",
      description: "Get current orchestrator state",
      response: "State object with workers, tasks, events",
      auth: false,
      rateLimit: "Standard rate limit applies",
    },
    {
      method: "GET",
      path: "/api/workers",
      description: "Get worker status and health",
      response: "Array of worker objects with status and metrics",
      auth: false,
      rateLimit: "Standard rate limit applies",
    },
    {
      method: "GET",
      path: "/api/tasks",
      description: "Get task list with status",
      response: "Array of task objects with status and progress",
      auth: false,
      rateLimit: "Standard rate limit applies",
    },
    {
      method: "GET",
      path: "/api/events",
      description: "Get event history",
      query: { limit: "Number of events to return (default: 50)" },
      response: "Array of event objects with timestamp and details",
      auth: false,
      rateLimit: "Standard rate limit applies",
    },
    {
      method: "GET",
      path: "/api/chains",
      description: "Get audit chain data",
      response: "Array of chain objects with operations and metadata",
      auth: false,
      rateLimit: "Standard rate limit applies",
    },
    {
      method: "POST",
      path: "/api/send",
      description: "Send command to orchestrator",
      body: '{ "command": "string", "args": {} }',
      response: '{ "ok": true } or error',
      auth: true,
      rateLimit: "Standard rate limit applies",
    },
    {
      method: "GET",
      path: "/api/events/stream",
      description: "SSE endpoint for real-time updates",
      response: "Server-Sent Events stream",
      auth: false,
    },
    {
      method: "GET",
      path: "/api/docs",
      description: "Get API documentation",
      response: "JSON array of endpoint documentation",
      auth: false,
    },
    {
      method: "GET",
      path: "/api/health",
      description: "Health check endpoint",
      response: '{ "status": "ok", "version": "1.0.0" }',
      auth: false,
    },
  ];
}

/**
 * Generate HTML documentation page.
 */
export function generateDocsHtml(): string {
  const endpoints = getApiDocs();

  const rows = endpoints
    .map(
      (ep) => `
    <tr>
      <td><span class="method ${ep.method.toLowerCase()}">${ep.method}</span></td>
      <td><code>${ep.path}</code></td>
      <td>${ep.description}</td>
      <td>${ep.auth ? "Yes" : "No"}</td>
    </tr>`
    )
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Dashboard API Documentation</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 2rem; line-height: 1.6; }
    h1 { color: #333; }
    table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
    th, td { border: 1px solid #ddd; padding: 0.75rem; text-align: left; }
    th { background: #f5f5f5; }
    code { background: #f0f0f0; padding: 0.2rem 0.4rem; border-radius: 3px; }
    .method { display: inline-block; padding: 0.2rem 0.5rem; border-radius: 3px; color: white; font-weight: bold; font-size: 0.85rem; }
    .get { background: #49cc90; }
    .post { background: #fca130; }
  </style>
</head>
<body>
  <h1>Dashboard API</h1>
  <p>REST API for monitoring and controlling the orchestrator.</p>

  <h2>Endpoints</h2>
  <table>
    <thead>
      <tr>
        <th>Method</th>
        <th>Path</th>
        <th>Description</th>
        <th>Auth Required</th>
      </tr>
    </thead>
    <tbody>
      ${rows}
    </tbody>
  </table>

  <h2>Authentication</h2>
  <p>When enabled, include a Bearer token in the Authorization header:</p>
  <pre>Authorization: Bearer &lt;your-token&gt;</pre>

  <h2>Real-time Updates</h2>
  <p>Connect to <code>/api/events/stream</code> for Server-Sent Events.</p>
  <p>Events include: state updates, worker status changes, task progress.</p>

  <h2>Error Responses</h2>
  <p>All endpoints return JSON error responses with appropriate HTTP status codes:</p>
  <ul>
    <li><strong>400</strong> - Bad request / invalid JSON</li>
    <li><strong>401</strong> - Authentication required</li>
    <li><strong>404</strong> - Endpoint not found</li>
    <li><strong>429</strong> - Rate limit exceeded</li>
    <li><strong>500</strong> - Internal server error</li>
  </ul>
</body>
</html>`;
}
