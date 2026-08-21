import { AsyncResource } from "node:async_hooks";
import WebSocket from "ws";
import type { PluginContext } from "@paperclipai/plugin-sdk";

// This resource is created while the worker module loads, outside any
// host-issued Paperclip invocation. WebSocket listeners are registered during
// onConfigChanged and would otherwise retain that short-lived invocation in
// AsyncLocalStorage. Running callbacks in this root scope lets Paperclip apply
// the worker's configured proactive company scope instead of receiving an
// expired invocation id.
const proactiveSocketScope = new AsyncResource("SlackSocketModeProactiveCallback");

export function runInProactiveSocketScope<T>(callback: () => T): T {
  return proactiveSocketScope.runInAsyncScope(callback);
}

type SocketEnvelope = {
  envelope_id?: string;
  type?: string;
  payload?: Record<string, unknown>;
};

type OpenConnectionResponse = {
  ok: boolean;
  url?: string;
  error?: string;
};

export class SlackSocketModeClient {
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    private readonly ctx: PluginContext,
    private readonly appToken: string,
    private readonly onEnvelope: (envelope: SocketEnvelope) => Promise<void>,
  ) {}

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close();
    this.socket = null;
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, 3_000);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;

    try {
      const response = await this.ctx.http.fetch("https://slack.com/api/apps.connections.open", {
        method: "POST",
        headers: { Authorization: `Bearer ${this.appToken}` },
      });
      const opened = await response.json() as OpenConnectionResponse;
      if (!opened.ok || !opened.url) {
        throw new Error(opened.error ?? `HTTP ${response.status}`);
      }

      const socket = new WebSocket(opened.url);
      this.socket = socket;

      socket.on("open", () => {
        runInProactiveSocketScope(() => {
          this.ctx.logger.info("Slack Socket Mode connected");
        });
      });

      socket.on("message", (data) => {
        void runInProactiveSocketScope(() => this.handleMessage(socket, data.toString()));
      });

      socket.on("error", (err) => {
        runInProactiveSocketScope(() => {
          this.ctx.logger.warn("Slack Socket Mode connection error", { error: String(err) });
        });
      });

      socket.on("close", () => {
        runInProactiveSocketScope(() => {
          if (this.socket === socket) this.socket = null;
          this.ctx.logger.warn("Slack Socket Mode disconnected; reconnecting");
          this.scheduleReconnect();
        });
      });
    } catch (err) {
      this.ctx.logger.warn("Failed to open Slack Socket Mode connection", { error: String(err) });
      this.scheduleReconnect();
    }
  }

  private async handleMessage(socket: WebSocket, raw: string): Promise<void> {
    let envelope: SocketEnvelope;
    try {
      envelope = JSON.parse(raw) as SocketEnvelope;
    } catch {
      this.ctx.logger.warn("Ignoring malformed Slack Socket Mode envelope");
      return;
    }

    if (envelope.envelope_id && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
    }

    try {
      await this.onEnvelope(envelope);
    } catch (err) {
      this.ctx.logger.warn("Slack Socket Mode envelope failed", {
        envelopeType: envelope.type,
        error: String(err),
      });
    }
  }
}

export type { SocketEnvelope };
