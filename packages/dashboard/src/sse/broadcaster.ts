import type { ServerResponse } from "node:http";

export interface SSEClient {
  id: string;
  response: ServerResponse;
}

/**
 * Manages SSE (Server-Sent Events) connections and broadcasts.
 */
export class SSEBroadcaster {
  private clients: Map<string, SSEClient> = new Map();
  private nextId = 1;

  /**
   * Add a new SSE client.
   */
  addClient(res: ServerResponse): string {
    const id = `client-${this.nextId++}`;

    // Set SSE headers
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    // Send initial connection event
    res.write(`event: connected\ndata: ${JSON.stringify({ id })}\n\n`);

    this.clients.set(id, { id, response: res });

    // Handle client disconnect
    res.on("close", () => {
      this.removeClient(id);
    });

    return id;
  }

  /**
   * Remove an SSE client.
   */
  removeClient(id: string): void {
    const client = this.clients.get(id);
    if (client) {
      try {
        client.response.end();
      } catch {
        // Client may already be disconnected
      }
      this.clients.delete(id);
    }
  }

  /**
   * Broadcast an event to all connected clients.
   */
  broadcast(event: string, data: unknown): void {
    const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

    for (const [id, client] of this.clients) {
      try {
        client.response.write(message);
      } catch {
        // Client may have disconnected, remove it
        this.removeClient(id);
      }
    }
  }

  /**
   * Get the number of connected clients.
   */
  getClientCount(): number {
    return this.clients.size;
  }

  /**
   * Close all client connections.
   */
  closeAll(): void {
    for (const [id] of this.clients) {
      this.removeClient(id);
    }
  }
}
