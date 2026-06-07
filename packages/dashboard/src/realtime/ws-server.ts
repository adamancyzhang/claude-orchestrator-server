import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";

export interface WSClient {
  id: string;
  socket: WebSocket;
  subscriptions: Set<string>;
}

/**
 * Manages WebSocket connections and broadcasts.
 */
export class WSServer {
  private wss: WebSocketServer | null = null;
  private clients: Map<string, WSClient> = new Map();
  private nextId = 1;

  /**
   * Attach WebSocket server to an existing HTTP server.
   */
  attach(server: Server): void {
    this.wss = new WebSocketServer({ server });

    this.wss.on("connection", (socket: WebSocket) => {
      const clientId = `ws-${this.nextId++}`;
      const client: WSClient = {
        id: clientId,
        socket,
        subscriptions: new Set(["all"]), // Default subscription
      };

      this.clients.set(clientId, client);

      // Send welcome message
      this.sendToClient(client, {
        type: "connected",
        clientId,
      });

      socket.on("message", (data) => {
        this.handleMessage(client, data.toString());
      });

      socket.on("close", () => {
        this.clients.delete(clientId);
      });

      socket.on("error", (error) => {
        console.error(`WebSocket error for ${clientId}:`, error);
        this.clients.delete(clientId);
      });
    });
  }

  /**
   * Handle incoming messages from clients.
   */
  private handleMessage(client: WSClient, raw: string): void {
    try {
      const msg = JSON.parse(raw);

      if (msg.type === "subscribe" && msg.channel) {
        client.subscriptions.add(msg.channel);
        this.sendToClient(client, {
          type: "subscribed",
          channel: msg.channel,
        });
      } else if (msg.type === "unsubscribe" && msg.channel) {
        client.subscriptions.delete(msg.channel);
        this.sendToClient(client, {
          type: "unsubscribed",
          channel: msg.channel,
        });
      }
    } catch {
      // Ignore invalid messages
    }
  }

  /**
   * Broadcast an event to all subscribed clients.
   */
  broadcast(channel: string, data: unknown): void {
    const message = JSON.stringify({
      type: "event",
      channel,
      data,
      timestamp: Date.now(),
    });

    for (const [, client] of this.clients) {
      if (client.subscriptions.has(channel) || client.subscriptions.has("all")) {
        this.sendRaw(client, message);
      }
    }
  }

  /**
   * Send a message to a specific client.
   */
  private sendToClient(client: WSClient, data: unknown): void {
    try {
      client.socket.send(JSON.stringify(data));
    } catch {
      // Client may be disconnected
    }
  }

  /**
   * Send raw string to client.
   */
  private sendRaw(client: WSClient, raw: string): void {
    try {
      client.socket.send(raw);
    } catch {
      // Client may be disconnected
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
    for (const [, client] of this.clients) {
      client.socket.close();
    }
    this.clients.clear();
  }
}
