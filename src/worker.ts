import { createHmac, timingSafeEqual } from "node:crypto";
import {
  definePlugin,
  runWorker,
  type PluginContext,
  type PluginEvent,
  type PluginWebhookInput,
  type PluginHealthDiagnostics,
} from "@paperclipai/plugin-sdk";
import { WEBHOOK_KEYS, STATE_KEYS, PLUGIN_ID, DEFAULT_CONFIG } from "./constants.js";
import {
  openView,
  postMessage,
  resolveSlackChannelId,
  respondToAction,
  respondEphemeral,
  updateMessage,
} from "./slack-api.js";
import type { SlackMessage } from "./slack-api.js";
import type { SlackConfig, EscalationRecord, CommandDefinition, SessionEntry } from "./types.js";
import { SlackAdapter } from "./adapter.js";
import {
  spawnAgent,
  closeAgent,
  routeMessageToAgent,
  handleAgentOutput,
  handleHandoffAction,
  handleDiscussionAction,
  handleAcpSlashCommand,
  startDiscussion,
  buildHandoffBlocks,
} from "./acp-bridge.js";
import {
  setBaseUrl,
  formatIssueCreated,
  formatIssueDone,
  formatApprovalCreated,
  formatApprovalResolved,
  formatAgentError,
  formatAgentConnected,
  formatBudgetThreshold,
  formatOnboardingMilestone,
  formatDailyDigest,
  formatEscalationMessage,
  formatEscalationResolved,
} from "./formatters.js";
import { processMediaFile, isMediaFile } from "./media-pipeline.js";
import {
  registerCommand,
  handleCommandsSlash,
  tryCustomCommand,
  parseCommand,
} from "./custom-commands.js";
import {
  registerWatch,
  removeWatch,
  listWatches,
  checkWatches,
  BUILTIN_WATCH_TEMPLATES,
} from "./proactive-suggestions.js";
import { resolveStartupSlackToken, type SlackRuntimeHealth } from "./runtime-token.js";
import { SlackSocketModeClient, type SocketEnvelope } from "./socket-mode.js";
import {
  CREATE_TASK_MODAL_CALLBACK_ID,
  CREATE_TASK_SHORTCUT_CALLBACK_ID,
  buildCreateTaskModal,
  parseCreateTaskSubmission,
  type TaskFormOption,
} from "./task-action.js";
import {
  PLAN_APPROVE_ACTION_ID,
  PLAN_REJECT_ACTION_ID,
  PLAN_REJECT_MODAL_CALLBACK_ID,
  buildPlanApprovalMessage,
  buildPlanRejectionModal,
  buildResolvedPlanApprovalMessage,
  decodePlanApprovalActionRef,
  isPlanApprovalInteraction,
  parsePlanRejectionSubmission,
  type PlanApprovalInteraction,
  type PlanApprovalMessageRef,
} from "./plan-approval.js";
import {
  buildIssueQueueMessage,
  parseIssueQueueMessage,
  type IssueQueueStatus,
} from "./issue-query.js";
import { encodeSlashCommandPayload, parseSlashCommand } from "./slash-command.js";

let pluginCtx: PluginContext;
let pluginToken: string;
let pluginConfig: SlackConfig;
let slackAdapter: SlackAdapter;
let runtimeHealth: SlackRuntimeHealth = { status: "ok" };
let socketModeClient: SlackSocketModeClient | null = null;
let paperclipApiKey = "";
let pluginCompanyId = "";
let applyRuntimeConfig: ((config: SlackConfig, companyId: string) => Promise<void>) | null = null;
const issueBySlackThread = new Map<string, string>();
const slackThreadByIssue = new Map<string, { channelId: string; threadTs: string }>();
const handledSlackEvents = new Set<string>();
const handledPaperclipEvents = new Set<string>();
const notifiedIssueIds = new Set<string>();

// --- Slack signature verification ---

let slackSigningSecret: string | null = null;

function verifySlackSignature(
  headers: Record<string, string | string[]>,
  rawBody: string,
): boolean {
  if (!slackSigningSecret) return true; // skip if not configured

  const timestamp = String(
    headers["x-slack-request-timestamp"] ??
    headers["X-Slack-Request-Timestamp"] ?? ""
  );
  const signature = String(
    headers["x-slack-signature"] ??
    headers["X-Slack-Signature"] ?? ""
  );

  if (!timestamp || !signature) return false;

  // Reject requests older than 5 minutes to prevent replay attacks
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > 300) return false;

  const baseString = `v0:${timestamp}:${rawBody}`;
  const hmac = createHmac("sha256", slackSigningSecret)
    .update(baseString)
    .digest("hex");
  const expected = `v0=${hmac}`;

  if (expected.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

// --- Helpers ---

async function resolveChannel(
  ctx: PluginContext,
  companyId: string,
  fallback: string,
): Promise<string | null> {
  const override = await ctx.state.get({
    scopeKind: "company",
    scopeId: companyId,
    stateKey: STATE_KEYS.slackChannel,
  });
  return (override as string) ?? fallback ?? null;
}

function statusBadge(status: string): string {
  const badges: Record<string, string> = {
    active: ":large_green_circle:",
    running: ":large_green_circle:",
    idle: ":white_circle:",
    paused: ":double_vertical_bar:",
    error: ":red_circle:",
    pending_approval: ":hourglass:",
    terminated: ":black_circle:",
  };
  return badges[status] ?? ":white_circle:";
}

function genId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function handleSlackEventCallback(
  ctx: PluginContext,
  body: Record<string, unknown>,
): Promise<void> {
  if (body.type !== "event_callback") return;

  const eventId = String(body.event_id ?? "");
  if (eventId && handledSlackEvents.has(eventId)) return;
  if (eventId) {
    handledSlackEvents.add(eventId);
    if (handledSlackEvents.size > 1_000) {
      const oldest = handledSlackEvents.values().next().value;
      if (oldest) handledSlackEvents.delete(oldest);
    }
  }

  const event = body.event as Record<string, unknown> | undefined;
  if (!event) return;

  if (event.type === "file_shared") {
    ctx.logger.info("Ignoring standalone Slack file event in issue bridge mode");
    return;
  }

  if (event.type !== "message") return;
  if (event.bot_id || event.app_id) return;
  const subtype = String(event.subtype ?? "");
  if (subtype && subtype !== "file_share") return;

  const channel = String(event.channel ?? "");
  const threadTs = String(event.thread_ts ?? "");
  const messageTs = String(event.ts ?? "");
  const userId = String(event.user ?? "");
  const text = String(event.text ?? "").trim();
  const files = Array.isArray(event.files) ? event.files as Array<Record<string, unknown>> : [];
  if (!channel || (!text && files.length === 0)) return;

  const config = pluginConfig;
  if (config.slackUserId && userId !== config.slackUserId) {
    ctx.logger.warn("Ignoring Slack message from an unauthorized user", { userId, channel });
    return;
  }

  const channelType = String(event.channel_type ?? "");
  const dmQueueStatus = channelType === "im" || channel.startsWith("D")
    ? parseIssueQueueMessage(text)
    : null;
  if (dmQueueStatus) {
    if (!pluginCompanyId) {
      await postMessage(ctx, pluginToken, channel, {
        text: ":warning: Nenhuma empresa está vinculada a esta conversa.",
      }, threadTs ? { threadTs } : undefined);
      return;
    }
    const issues = await listAllIssuesByStatus(ctx, pluginCompanyId, dmQueueStatus);
    const result = await postMessage(
      ctx,
      pluginToken,
      channel,
      buildIssueQueueMessage(issues, dmQueueStatus, config.paperclipBaseUrl),
      threadTs ? { threadTs } : undefined,
    );
    if (!result.ok) {
      throw new Error(`Slack DM issue query failed: ${result.error ?? "unknown error"}`);
    }
    await ctx.metrics.write("slack.commands.handled", 1, {
      command_name: dmQueueStatus === "blocked" ? "dm_blocked" : "dm_review",
    });
    return;
  }

  if (!threadTs) return;

  let issueId = issueBySlackThread.get(`${channel}:${threadTs}`) ?? null;
  if (!issueId) {
    const response = await ctx.http.fetch(
      `https://slack.com/api/conversations.replies?channel=${encodeURIComponent(channel)}&ts=${encodeURIComponent(threadTs)}&limit=1`,
      { headers: { Authorization: `Bearer ${pluginToken}` } },
    );
    const history = await response.json() as { ok?: boolean; messages?: Array<Record<string, unknown>> };
    const root = history.messages?.[0];
    const serialized = JSON.stringify(root ?? {});
    const match = serialized.match(/\/issues\/([0-9a-f]{8}-[0-9a-f-]{27,})/i);
    issueId = match?.[1] ?? null;
    if (issueId) {
      issueBySlackThread.set(`${channel}:${threadTs}`, issueId);
      slackThreadByIssue.set(issueId, { channelId: channel, threadTs });
    }
  }

  if (issueId && text) {
    if (!paperclipApiKey || !config.paperclipBaseUrl) {
      ctx.logger.warn("Cannot relay Slack reply: Paperclip API credentials are not configured", { issueId });
      return;
    }
    const response = await ctx.http.fetch(`${config.paperclipBaseUrl}/api/issues/${issueId}/comments`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${paperclipApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ body: text }),
    });
    if (!response.ok) {
      throw new Error(`Paperclip comment relay failed with HTTP ${response.status}`);
    }
    return;
  }
  ctx.logger.warn("Ignoring Slack reply because its thread is not linked to a Paperclip issue", {
    channel,
    threadTs,
    messageTs,
  });
}

async function handleSocketEnvelope(envelope: SocketEnvelope): Promise<void> {
  if (!pluginCtx || !envelope.payload) return;
  if (envelope.type === "events_api") {
    await handleSlackEventCallback(pluginCtx, envelope.payload);
    return;
  }
  if (envelope.type === "interactive") {
    await handleSlackInteractivePayload(pluginCtx, envelope.payload);
    return;
  }
  if (envelope.type === "slash_commands") {
    await handleSlashCommand(pluginCtx, encodeSlashCommandPayload(envelope.payload));
  }
}

function paperclipUrl(path: string): string {
  return `${pluginConfig.paperclipBaseUrl.replace(/\/$/, "")}${path}`;
}

async function paperclipRequest<T>(
  ctx: PluginContext,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  if (!paperclipApiKey || !pluginCompanyId || !pluginConfig.paperclipBaseUrl) {
    throw new Error("Paperclip task creation is not configured");
  }
  const response = await ctx.http.fetch(paperclipUrl(path), {
    ...init,
    headers: {
      Authorization: `Bearer ${paperclipApiKey}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    throw new Error(`Paperclip request failed with HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}

async function loadTaskFormOptions(ctx: PluginContext): Promise<{
  agents: TaskFormOption[];
  projects: TaskFormOption[];
}> {
  type Agent = { id?: string; name?: string; title?: string; status?: string };
  type Project = { id?: string; name?: string; status?: string };
  const [agents, projects] = await Promise.all([
    paperclipRequest<Agent[]>(ctx, `/api/companies/${pluginCompanyId}/agents`),
    paperclipRequest<Project[]>(ctx, `/api/companies/${pluginCompanyId}/projects`),
  ]);
  return {
    agents: agents
      .filter((agent) => agent.id && agent.name && agent.status !== "terminated")
      .map((agent) => ({
        id: String(agent.id),
        label: agent.title ? `${agent.name} — ${agent.title}` : String(agent.name),
      })),
    projects: projects
      .filter((project) => project.id && project.name && project.status !== "cancelled")
      .map((project) => ({ id: String(project.id), label: String(project.name) })),
  };
}

function slackInteractionUserId(payload: Record<string, unknown>): string {
  const user = payload.user as Record<string, unknown> | undefined;
  return String(user?.id ?? "");
}

function slackInteractionMessageLocation(payload: Record<string, unknown>): {
  channelId: string;
  messageTs: string;
} {
  const container = payload.container as Record<string, unknown> | undefined;
  const channel = payload.channel as Record<string, unknown> | undefined;
  const message = payload.message as Record<string, unknown> | undefined;
  return {
    channelId: String(container?.channel_id ?? channel?.id ?? ""),
    messageTs: String(container?.message_ts ?? message?.ts ?? ""),
  };
}

async function markPlanApprovalResolved(
  ctx: PluginContext,
  interactionId: string,
): Promise<void> {
  await ctx.state.set(
    {
      scopeKind: "instance",
      stateKey: `${pluginCompanyId}:${STATE_KEYS.planApprovalResolved(interactionId)}`,
    },
    true,
  );
}

async function updateResolvedPlanApproval(
  ctx: PluginContext,
  ref: PlanApprovalMessageRef,
  interaction: PlanApprovalInteraction,
  slackUserId?: string,
): Promise<void> {
  const issue = await paperclipRequest<{ id: string; identifier?: string | null; title?: string | null }>(
    ctx,
    `/api/issues/${ref.issueId}`,
  );
  const updated = await updateMessage(
    ctx,
    pluginToken,
    ref.channelId,
    ref.messageTs,
    buildResolvedPlanApprovalMessage(issue, interaction, pluginConfig.paperclipBaseUrl, slackUserId),
  );
  if (!updated.ok) throw new Error(updated.error ?? "Could not update the Slack plan approval card");
  await markPlanApprovalResolved(ctx, ref.interactionId);
}

async function findSlackThreadForIssue(
  ctx: PluginContext,
  issueId: string,
  issueIdentifier?: string | null,
): Promise<{ channelId: string; threadTs: string } | null> {
  const cached = slackThreadByIssue.get(issueId);
  if (cached) return cached;

  const channelId = await resolveSlackChannelId(
    ctx,
    pluginToken,
    pluginConfig.defaultChannelId,
  );
  if (!channelId) return null;

  let cursor = "";
  for (let page = 0; page < 5; page++) {
    const query = new URLSearchParams({ channel: channelId, limit: "100" });
    if (cursor) query.set("cursor", cursor);
    const response = await ctx.http.fetch(
      `https://slack.com/api/conversations.history?${query.toString()}`,
      { headers: { Authorization: `Bearer ${pluginToken}` } },
    );
    const body = await response.json() as {
      ok?: boolean;
      error?: string;
      messages?: Array<Record<string, unknown>>;
      response_metadata?: { next_cursor?: string };
    };
    if (!body.ok) {
      ctx.logger.warn("Could not search Slack history for an issue thread", {
        error: body.error,
        issueId,
      });
      return null;
    }
    const root = body.messages?.find((message) => {
      if (message.thread_ts) return false;
      const serialized = JSON.stringify(message);
      return serialized.includes(issueId)
        || Boolean(issueIdentifier && serialized.includes(issueIdentifier));
    });
    const threadTs = String(root?.ts ?? "");
    if (threadTs) {
      const linked = { channelId, threadTs };
      slackThreadByIssue.set(issueId, linked);
      issueBySlackThread.set(`${channelId}:${threadTs}`, issueId);
      return linked;
    }
    cursor = body.response_metadata?.next_cursor?.trim() ?? "";
    if (!cursor) break;
  }
  return null;
}

async function reportPlanApprovalFailure(
  ctx: PluginContext,
  userId: string,
  responseUrl: string,
): Promise<void> {
  const message = {
    text: ":x: Não foi possível registrar essa decisão no Paperclip. O plano pode já ter sido alterado ou encerrado; tente novamente.",
  };
  if (responseUrl) {
    await respondEphemeral(ctx, responseUrl, message);
    return;
  }
  await postMessage(ctx, pluginToken, pluginConfig.slackUserId || userId, message);
}

async function handleSlackInteractivePayload(
  ctx: PluginContext,
  payload: Record<string, unknown>,
): Promise<void> {
  const userId = slackInteractionUserId(payload);
  if (!userId || (pluginConfig.slackUserId && userId !== pluginConfig.slackUserId)) {
    ctx.logger.warn("Ignoring Slack task action from an unauthorized user", { userId });
    return;
  }

  if (payload.type === "block_actions") {
    const actions = payload.actions as Array<Record<string, unknown>> | undefined;
    const action = actions?.[0];
    const actionId = String(action?.action_id ?? "");
    if (actionId !== PLAN_APPROVE_ACTION_ID && actionId !== PLAN_REJECT_ACTION_ID) return;

    const ref = decodePlanApprovalActionRef(String(action?.value ?? ""));
    const location = slackInteractionMessageLocation(payload);
    const responseUrl = String(payload.response_url ?? "");
    if (!ref || !location.channelId || !location.messageTs) {
      ctx.logger.warn("Ignoring malformed Slack plan approval action", { actionId });
      return;
    }

    if (actionId === PLAN_REJECT_ACTION_ID) {
      const triggerId = String(payload.trigger_id ?? "");
      if (!triggerId) return;
      const opened = await openView(ctx, pluginToken, triggerId, buildPlanRejectionModal({
        ...ref,
        ...location,
      }));
      if (!opened.ok) {
        await reportPlanApprovalFailure(ctx, userId, responseUrl);
      }
      return;
    }

    try {
      const interaction = await paperclipRequest<PlanApprovalInteraction>(
        ctx,
        `/api/issues/${ref.issueId}/interactions/${ref.interactionId}/accept`,
        { method: "POST", body: JSON.stringify({}) },
      );
      await updateResolvedPlanApproval(
        ctx,
        { ...ref, ...location },
        interaction,
        userId,
      );
      await ctx.metrics.write("slack.plan_approvals.decided", 1, { decision: "accept" });
    } catch (err) {
      ctx.logger.warn("Slack plan approval failed", { error: String(err), ...ref });
      await reportPlanApprovalFailure(ctx, userId, responseUrl);
    }
    return;
  }

  if (payload.type === "view_submission") {
    const view = payload.view as Record<string, unknown> | undefined;
    if (view?.callback_id === PLAN_REJECT_MODAL_CALLBACK_ID) {
      try {
        const submission = parsePlanRejectionSubmission({
          privateMetadata: String(view.private_metadata ?? ""),
          state: (view.state ?? {}) as Parameters<typeof parsePlanRejectionSubmission>[0]["state"],
        });
        const interaction = await paperclipRequest<PlanApprovalInteraction>(
          ctx,
          `/api/issues/${submission.issueId}/interactions/${submission.interactionId}/reject`,
          {
            method: "POST",
            body: JSON.stringify({ reason: submission.reason }),
          },
        );
        await updateResolvedPlanApproval(
          ctx,
          submission,
          interaction,
          userId,
        );
        await ctx.metrics.write("slack.plan_approvals.decided", 1, { decision: "reject" });
      } catch (err) {
        ctx.logger.warn("Slack plan rejection failed", { error: String(err) });
        await reportPlanApprovalFailure(ctx, userId, "");
      }
      return;
    }
  }

  if (
    payload.type === "shortcut" &&
    payload.callback_id === CREATE_TASK_SHORTCUT_CALLBACK_ID
  ) {
    const triggerId = String(payload.trigger_id ?? "");
    if (!triggerId) return;
    let options: { agents: TaskFormOption[]; projects: TaskFormOption[] } = {
      agents: [],
      projects: [],
    };
    try {
      options = await loadTaskFormOptions(ctx);
    } catch (err) {
      ctx.logger.warn("Could not load Paperclip task form options", { error: String(err) });
    }
    const opened = await openView(ctx, pluginToken, triggerId, buildCreateTaskModal(options));
    if (!opened.ok) throw new Error(opened.error ?? "Could not open create task modal");
    return;
  }

  if (payload.type !== "view_submission") return;
  const view = payload.view as Record<string, unknown> | undefined;
  if (view?.callback_id !== CREATE_TASK_MODAL_CALLBACK_ID) return;

  try {
    const input = parseCreateTaskSubmission(
      (view.state ?? {}) as Parameters<typeof parseCreateTaskSubmission>[0],
    );
    const viewId = String(view.id ?? Date.now());
    await paperclipRequest<Record<string, unknown>>(
      ctx,
      `/api/companies/${pluginCompanyId}/issues`,
      {
        method: "POST",
        body: JSON.stringify({
          title: input.title,
          description: input.description || null,
          status: "todo",
          priority: input.priority,
          createdByUserId: pluginConfig.paperclipUserId,
          responsibleUserId: pluginConfig.paperclipUserId,
          idempotencyKey: `slack:create-task:${viewId}`,
          ...(input.assigneeAgentId ? { assigneeAgentId: input.assigneeAgentId } : {}),
          ...(input.projectId ? { projectId: input.projectId } : {}),
        }),
      },
    );
    try {
      await ctx.metrics.write("slack.tasks.created", 1);
    } catch (err) {
      ctx.logger.warn("Could not record Slack task creation metric", { error: String(err) });
    }
  } catch (err) {
    ctx.logger.warn("Slack create task action failed", { error: String(err) });
    await postMessage(ctx, pluginToken, pluginConfig.slackUserId || userId, {
      text: ":x: Não foi possível criar a task no Paperclip. Tente novamente.",
    });
  }
}

// --- Slash command routing ---

async function handleSlashCommand(ctx: PluginContext, rawBody: string): Promise<void> {
  const { text, responseUrl, userId, channelId, threadTs } = parseSlashCommand(rawBody);
  const parts = text.trim().split(/\s+/);
  const subcommand = parts[0]?.toLowerCase() ?? "";
  const arg = parts[1]?.toLowerCase() ?? "";

  const companies = pluginCompanyId
    ? []
    : await ctx.companies.list({ limit: 1, offset: 0 });
  const companyId = pluginCompanyId || companies[0]?.id || "";
  if (!companyId) {
    await respondEphemeral(ctx, responseUrl, {
      text: ":warning: Nenhuma empresa está vinculada a este comando.",
    });
    return;
  }

  try {
    switch (subcommand) {
      case "status":
        await handleStatusCommand(ctx, companyId, responseUrl);
        break;
      case "help":
      case "":
        await handleHelpCommand(ctx, responseUrl);
        break;
      case "agents":
        await handleAgentsCommand(ctx, companyId, responseUrl);
        break;
      case "issues":
        await handleIssuesCommand(ctx, companyId, responseUrl, arg);
        break;
      case "blocked":
      case "bloqueadas":
      case "bloqueados":
        await handleIssueQueueCommand(ctx, companyId, responseUrl, userId, "blocked");
        break;
      case "review":
      case "revisao":
      case "revisão":
      case "in_review":
        await handleIssueQueueCommand(ctx, companyId, responseUrl, userId, "in_review");
        break;
      case "approve":
        await handleApproveCommand(ctx, responseUrl, arg);
        break;
      case "acp": {
        const acpText = parts.slice(1).join(" ");
        await handleAcpSlashCommand(ctx, pluginToken, {
          channel: channelId,
          threadTs,
          text: acpText,
          companyId,
        });
        break;
      }
      case "commands":
        await handleCommandsSlash(ctx, companyId, responseUrl);
        break;
      case "watches": {
        const watches = await listWatches(ctx, companyId);
        if (watches.length === 0) {
          await respondEphemeral(ctx, responseUrl, {
            text: "No active watches. Use the `register_watch` tool to add watches.",
          });
        } else {
          const lines = watches.map((w) =>
            `:bell: \`${w.eventPattern}\` -> *${w.agentId}* (triggered ${w.triggerCount}x)`
          );
          await respondEphemeral(ctx, responseUrl, {
            text: `${watches.length} active watch(es)`,
            blocks: [
              {
                type: "header",
                text: { type: "plain_text", text: `Active Watches (${watches.length})` },
              },
              {
                type: "section",
                text: { type: "mrkdwn", text: lines.join("\n") },
              },
            ],
          });
        }
        break;
      }
      default:
        await respondEphemeral(ctx, responseUrl, {
          text: `Unknown command: \`${subcommand}\`. Use \`/clip help\` to see available commands.`,
        });
    }
    await ctx.metrics.write("slack.commands.handled", 1, { command_name: subcommand || "help" });
  } catch (err) {
    ctx.logger.warn("Slash command failed", { subcommand, err });
    await respondEphemeral(ctx, responseUrl, {
      text: "Something went wrong processing your command. Please try again.",
    });
  }
}

async function handleStatusCommand(ctx: PluginContext, companyId: string, responseUrl: string): Promise<void> {
  const agents = await ctx.agents.list({ companyId, limit: 100, offset: 0 });
  const activeAgents = agents.filter((a) => a.status === "active" || a.status === "running");
  const recentDone = await ctx.issues.list({ companyId, status: "done", limit: 5, offset: 0 });

  const agentSummary = activeAgents.length > 0
    ? activeAgents.map((a) => `${statusBadge(a.status)} ${a.name}`).join("\n")
    : "_No active agents_";

  const issueSummary = recentDone.length > 0
    ? recentDone.map((i) => `:white_check_mark: ${i.title}`).join("\n")
    : "_No recent completions_";

  await respondEphemeral(ctx, responseUrl, {
    text: `Status: ${activeAgents.length} active agents, ${recentDone.length} recent completions`,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: "Paperclip Status" },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Active Agents (${activeAgents.length})*\n${agentSummary}` },
          { type: "mrkdwn", text: `*Recent Completions*\n${issueSummary}` },
        ],
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "View Dashboard" },
            url: pluginConfig.paperclipBaseUrl,
            action_id: "view_dashboard",
          },
        ],
      },
    ],
  });
}

async function handleHelpCommand(ctx: PluginContext, responseUrl: string): Promise<void> {
  await respondEphemeral(ctx, responseUrl, {
    text: "Available /clip commands",
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: "Paperclip Slash Commands" },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: [
            "`/clip status` - Show active agents and recent completions",
            "`/clip agents` - List all agents with status badges",
            "`/clip issues [open|done]` - List issues filtered by status",
            "`/clip bloqueadas` - Lista todas as tasks bloqueadas",
            "`/clip revisao` - Lista todas as tasks pendentes de revisão",
            "`/clip approve <id>` - Approve a pending approval",
            "`/clip acp spawn <agent> [display]` - Add an agent to this thread",
            "`/clip acp status` - Show all agents in this thread",
            "`/clip acp close [name]` - Close a specific agent (or most recent)",
            "`/clip commands` - List registered custom commands",
            "`/clip watches` - List active event watches",
            "`/clip help` - Show this help message",
          ].join("\n"),
        },
      },
      {
        type: "context",
        elements: [
          { type: "mrkdwn", text: `<${pluginConfig.paperclipBaseUrl}|Open Paperclip Dashboard>` },
        ],
      },
    ],
  });
}

async function handleAgentsCommand(ctx: PluginContext, companyId: string, responseUrl: string): Promise<void> {
  const agents = await ctx.agents.list({ companyId, limit: 100, offset: 0 });

  if (agents.length === 0) {
    await respondEphemeral(ctx, responseUrl, { text: "No agents found." });
    return;
  }

  const lines = agents.map((a) => `${statusBadge(a.status)} *${a.name}* - \`${a.status}\``);

  await respondEphemeral(ctx, responseUrl, {
    text: `${agents.length} agents`,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: `Agents (${agents.length})` },
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: lines.join("\n") },
      },
    ],
  });
}

async function handleIssuesCommand(ctx: PluginContext, companyId: string, responseUrl: string, filter: string): Promise<void> {
  const status = filter === "done" ? "done" as const : filter === "open" ? "todo" as const : undefined;
  const issues = await ctx.issues.list({ companyId, status, limit: 10, offset: 0 });

  if (issues.length === 0) {
    await respondEphemeral(ctx, responseUrl, { text: `No ${status ?? ""} issues found.` });
    return;
  }

  const lines = issues.map((i) => {
    const badge = i.status === "done" ? ":white_check_mark:" : ":blue_book:";
    return `${badge} *${i.title}* - \`${i.status}\``;
  });

  await respondEphemeral(ctx, responseUrl, {
    text: `${issues.length} issues`,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: `Issues${status ? ` (${status})` : ""} - showing ${issues.length}` },
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: lines.join("\n") },
      },
    ],
  });
}

async function listAllIssuesByStatus(
  ctx: PluginContext,
  companyId: string,
  status: IssueQueueStatus,
) {
  const issues = [];
  const seen = new Set<string>();
  const limit = 100;
  let offset = 0;

  while (true) {
    const page = await ctx.issues.list({ companyId, status, limit, offset });
    let added = 0;
    for (const issue of page) {
      if (seen.has(issue.id)) continue;
      seen.add(issue.id);
      issues.push(issue);
      added++;
    }
    if (page.length < limit || added === 0) break;
    offset += page.length;
  }
  return issues;
}

async function handleIssueQueueCommand(
  ctx: PluginContext,
  companyId: string,
  responseUrl: string,
  userId: string,
  status: IssueQueueStatus,
): Promise<void> {
  if (pluginConfig.slackUserId && userId !== pluginConfig.slackUserId) {
    await respondEphemeral(ctx, responseUrl, {
      text: ":no_entry: Você não está autorizado a consultar as tasks desta empresa.",
    });
    return;
  }
  const issues = await listAllIssuesByStatus(ctx, companyId, status);
  await respondEphemeral(
    ctx,
    responseUrl,
    buildIssueQueueMessage(issues, status, pluginConfig.paperclipBaseUrl),
  );
}

async function handleApproveCommand(ctx: PluginContext, responseUrl: string, approvalId: string): Promise<void> {
  if (!approvalId) {
    await respondEphemeral(ctx, responseUrl, { text: "Usage: `/clip approve <approval-id>`" });
    return;
  }

  try {
    await ctx.http.fetch(
      `${pluginConfig.paperclipBaseUrl}/api/approvals/${approvalId}/approve`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decidedByUserId: "slack:command" }),
      },
    );
    await respondEphemeral(ctx, responseUrl, { text: `:white_check_mark: Approval \`${approvalId}\` approved.` });
    await ctx.metrics.write("slack.approvals.decided", 1, { decision: "approve" });
  } catch (err) {
    ctx.logger.warn("Approve command failed", { approvalId, err });
    await respondEphemeral(ctx, responseUrl, { text: `:x: Failed to approve \`${approvalId}\`. Check the ID and try again.` });
  }
}

// --- Plugin definition ---

const plugin = definePlugin({
  async setup(ctx) {
    const config = { ...DEFAULT_CONFIG } as SlackConfig;
    let token = "";
    // Always reads the current persisted config so flag changes (e.g.
    // toggling notifyOnAgentConnected) take effect without restarting the
    // plugin worker.
    const getConfig = async (companyId: string): Promise<SlackConfig> =>
      (await ctx.config.get(companyId)) as unknown as SlackConfig;

    pluginCtx = ctx;
    pluginConfig = config;
    runtimeHealth = { status: "degraded", message: "Slack bridge is not configured" };

    applyRuntimeConfig = async (nextConfig, companyId) => {
      pluginConfig = nextConfig;
      pluginCompanyId = companyId;
      if (nextConfig.paperclipBaseUrl) setBaseUrl(nextConfig.paperclipBaseUrl);

      const resolvedToken = await resolveStartupSlackToken(
        ctx,
        nextConfig.slackTokenRef,
        companyId,
        (health) => { runtimeHealth = health; },
      );
      if (!resolvedToken) return;
      token = resolvedToken;
      pluginToken = resolvedToken;
      slackAdapter = new SlackAdapter(ctx, resolvedToken);

      if (nextConfig.slackSigningSecretRef) {
        slackSigningSecret = await ctx.secrets.resolve(nextConfig.slackSigningSecretRef, {
          companyId,
          configPath: "slackSigningSecretRef",
        });
      }

      paperclipApiKey = await ctx.secrets.resolve(nextConfig.paperclipApiKeyRef, {
        companyId,
        configPath: "paperclipApiKeyRef",
      });
      const appToken = await ctx.secrets.resolve(nextConfig.slackAppTokenRef, {
        companyId,
        configPath: "slackAppTokenRef",
      });
      await socketModeClient?.stop();
      socketModeClient = new SlackSocketModeClient(ctx, appToken, handleSocketEnvelope);
      await socketModeClient.start();
      runtimeHealth = { status: "ok" };
    };

    // =========================================================================
    // PHASE 1: Escalation - using 3-arg ctx.tools.register with ToolRunContext
    // =========================================================================

    ctx.tools.register(
      "escalate_to_human",
      {
        displayName: "Escalate to Human",
        description: "Escalates the current conversation to a human operator via the configured Slack escalation channel.",
        parametersSchema: {
          type: "object",
          properties: {
            reason: { type: "string", description: "Why the agent is escalating" },
            confidence: { type: "number", description: "Agent confidence score (0-1)" },
            agentName: { type: "string", description: "Name of the escalating agent" },
            conversationHistory: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  role: { type: "string" },
                  text: { type: "string" },
                },
              },
              description: "Last N messages of conversation context",
            },
            agentReasoning: { type: "string", description: "Agent's reasoning for the escalation" },
            suggestedReply: { type: "string", description: "Agent's suggested reply for the human to use" },
          },
          required: ["reason"],
        },
      },
      async (params: unknown, runCtx) => {
        const p = params as Record<string, unknown>;
        const companyId = runCtx.companyId;
        const escalationId = genId("esc");

        const record: EscalationRecord = {
          id: escalationId,
          reason: String(p.reason ?? ""),
          confidence: p.confidence != null ? Number(p.confidence) : undefined,
          agentName: p.agentName != null ? String(p.agentName) : undefined,
          conversationHistory: p.conversationHistory as Array<{ role: string; text: string }> | undefined,
          agentReasoning: p.agentReasoning != null ? String(p.agentReasoning) : undefined,
          suggestedReply: p.suggestedReply != null ? String(p.suggestedReply) : undefined,
          status: "open",
          createdAt: new Date().toISOString(),
        };

        const channelId = config.escalationChatId || config.approvalsChannelId || config.defaultChannelId;
        if (!channelId) {
          return { error: "No escalation channel configured" };
        }

        const message = formatEscalationMessage(record);
        const result = await postMessage(ctx, token, channelId, message);

        if (result.ok && result.ts) {
          await ctx.state.set(
            { scopeKind: "company", scopeId: companyId, stateKey: STATE_KEYS.escalationTs(escalationId) },
            result.ts,
          );
          await ctx.state.set(
            { scopeKind: "company", scopeId: companyId, stateKey: STATE_KEYS.escalationChannel(escalationId) },
            channelId,
          );
          await ctx.state.set(
            { scopeKind: "company", scopeId: companyId, stateKey: STATE_KEYS.escalationRecord(escalationId) },
            record,
          );
          await ctx.activity.log({
            companyId,
            message: `Escalation posted to Slack: ${record.reason}`,
            entityType: "plugin",
            entityId: escalationId,
          });
          await ctx.metrics.write("slack.escalations.created", 1);
        }

        if (config.escalationHoldMessage) {
          return { content: JSON.stringify({ escalationId, holdMessage: config.escalationHoldMessage }) };
        }
        return { content: JSON.stringify({ escalationId }) };
      },
    );

    // =========================================================================
    // PHASE 2: Multi-Agent - handoff and discuss tools
    // =========================================================================

    ctx.tools.register(
      "handoff_to_agent",
      {
        displayName: "Handoff to Agent",
        description: "Requests a handoff from one agent to another in the same Slack thread. Posts an approval prompt with Approve/Reject buttons.",
        parametersSchema: {
          type: "object",
          properties: {
            fromAgent: { type: "string", description: "Name of the agent initiating the handoff" },
            toAgent: { type: "string", description: "Name of the target agent to hand off to" },
            reason: { type: "string", description: "Why the handoff is needed" },
            context: { type: "string", description: "Context to pass to the target agent on approval" },
            channelId: { type: "string", description: "Slack channel ID" },
            threadTs: { type: "string", description: "Slack thread timestamp" },
          },
          required: ["fromAgent", "toAgent", "reason", "channelId", "threadTs"],
        },
      },
      async (params: unknown, runCtx) => {
        const p = params as Record<string, unknown>;
        const companyId = runCtx.companyId;
        const fromAgent = String(p.fromAgent ?? "");
        const toAgent = String(p.toAgent ?? "");
        const reason = String(p.reason ?? "");
        const channelId = String(p.channelId ?? "");
        const threadTs = String(p.threadTs ?? "");
        const context = p.context != null ? String(p.context) : undefined;

        const handoffId = genId("hoff");

        await ctx.state.set(
          { scopeKind: "company", scopeId: companyId, stateKey: STATE_KEYS.handoff(handoffId) },
          {
            id: handoffId,
            fromAgent,
            toAgent,
            reason,
            context,
            channelId,
            threadTs,
            companyId,
            status: "pending",
            createdAt: new Date().toISOString(),
          },
        );

        const blocks = buildHandoffBlocks(fromAgent, toAgent, reason, handoffId);
        await postMessage(ctx, token, channelId, {
          text: `Handoff: ${fromAgent} -> ${toAgent}: ${reason}`,
          blocks,
        }, threadTs ? { threadTs } : undefined);

        return { content: JSON.stringify({ handoffId, status: "pending" }) };
      },
    );

    ctx.tools.register(
      "discuss_with_agent",
      {
        displayName: "Discuss with Agent",
        description: "Starts a conversation loop between two agents in a Slack thread with human checkpoints every 5 turns.",
        parametersSchema: {
          type: "object",
          properties: {
            initiatorAgent: { type: "string", description: "Name of the agent starting the discussion" },
            targetAgent: { type: "string", description: "Name of the other agent" },
            topic: { type: "string", description: "The topic or question to discuss" },
            maxTurns: { type: "number", description: "Maximum number of turns (default 10)" },
            channelId: { type: "string", description: "Slack channel ID" },
            threadTs: { type: "string", description: "Slack thread timestamp" },
          },
          required: ["initiatorAgent", "targetAgent", "topic", "channelId", "threadTs"],
        },
      },
      async (params: unknown, runCtx) => {
        const p = params as Record<string, unknown>;
        const companyId = runCtx.companyId;
        const result = await startDiscussion(ctx, token, companyId, {
          initiatorAgent: String(p.initiatorAgent ?? ""),
          targetAgent: String(p.targetAgent ?? ""),
          topic: String(p.topic ?? ""),
          channelId: String(p.channelId ?? ""),
          threadTs: String(p.threadTs ?? ""),
          maxTurns: Number(p.maxTurns ?? 10),
        });
        return { content: JSON.stringify(result) };
      },
    );

    // =========================================================================
    // PHASE 3: Media Pipeline tool
    // =========================================================================

    ctx.tools.register(
      "process_media",
      {
        displayName: "Process Media",
        description: "Processes a media file (audio/video) from Slack - transcribes audio and optionally generates a brief.",
        parametersSchema: {
          type: "object",
          properties: {
            fileId: { type: "string", description: "Slack file ID to process" },
            channelId: { type: "string", description: "Channel to post results to" },
            threadTs: { type: "string", description: "Thread to post results in" },
            briefAgentId: { type: "string", description: "Optional agent ID to generate a brief from the transcription" },
          },
          required: ["fileId", "channelId", "threadTs"],
        },
      },
      async (params: unknown, runCtx) => {
        const p = params as Record<string, unknown>;
        const result = await processMediaFile(
          ctx,
          token,
          runCtx.companyId,
          String(p.fileId),
          String(p.channelId),
          String(p.threadTs),
          p.briefAgentId ? String(p.briefAgentId) : undefined,
        );

        if (!result) {
          return { error: "Failed to process media file" };
        }
        return { content: JSON.stringify(result) };
      },
    );

    // =========================================================================
    // PHASE 4: Custom Commands tool
    // =========================================================================

    ctx.tools.register(
      "register_command",
      {
        displayName: "Register Custom Command",
        description: "Registers a custom !command that can be triggered from Slack messages. Commands can have workflow steps like invoking agents, posting messages, or creating issues.",
        parametersSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Command name (without ! prefix)" },
            description: { type: "string", description: "What the command does" },
            usage: { type: "string", description: "Usage example (e.g. '!deploy staging')" },
            steps: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  type: {
                    type: "string",
                    enum: ["invoke_agent", "post_message", "create_issue", "wait_approval"],
                  },
                  agentId: { type: "string" },
                  prompt: { type: "string" },
                  message: { type: "string" },
                  issueTitle: { type: "string" },
                  issueDescription: { type: "string" },
                  timeout: { type: "number" },
                },
                required: ["type"],
              },
              description: "Workflow steps to execute",
            },
          },
          required: ["name", "description", "usage", "steps"],
        },
      },
      async (params: unknown, runCtx) => {
        const p = params as Record<string, unknown>;
        const command: CommandDefinition = {
          name: String(p.name),
          description: String(p.description),
          usage: String(p.usage),
          steps: (p.steps as CommandDefinition["steps"]) ?? [],
        };

        const ok = await registerCommand(ctx, runCtx.companyId, command);
        return { content: JSON.stringify({ registered: ok, name: command.name }) };
      },
    );

    // =========================================================================
    // PHASE 5: Proactive Suggestions tool
    // =========================================================================

    ctx.tools.register(
      "register_watch",
      {
        displayName: "Register Event Watch",
        description: "Registers a watch that triggers an agent when a matching event occurs. The agent will be invoked with a prompt interpolated with event data.",
        parametersSchema: {
          type: "object",
          properties: {
            eventPattern: {
              type: "string",
              description: "Event pattern to watch (e.g. 'issue.created', 'agent.run.*')",
            },
            agentId: { type: "string", description: "Agent to invoke when triggered" },
            prompt: {
              type: "string",
              description: "Prompt template (use ${event.payload.key} for interpolation)",
            },
            channelId: { type: "string", description: "Slack channel to post results to" },
            threadTs: { type: "string", description: "Optional thread to post results in" },
          },
          required: ["eventPattern", "agentId", "prompt", "channelId"],
        },
      },
      async (params: unknown, runCtx) => {
        const p = params as Record<string, unknown>;
        const watch = await registerWatch(ctx, runCtx.companyId, {
          channelId: String(p.channelId),
          threadTs: String(p.threadTs ?? ""),
          companyId: runCtx.companyId,
          eventPattern: String(p.eventPattern),
          agentId: String(p.agentId),
          prompt: String(p.prompt),
          createdBy: runCtx.agentId ?? "tool",
        });
        return { content: JSON.stringify({ watchId: watch.id, eventPattern: watch.eventPattern }) };
      },
    );

    ctx.tools.register(
      "remove_watch",
      {
        displayName: "Remove Event Watch",
        description: "Removes a registered event watch by ID.",
        parametersSchema: {
          type: "object",
          properties: {
            watchId: { type: "string", description: "Watch ID to remove" },
          },
          required: ["watchId"],
        },
      },
      async (params: unknown, _runCtx) => {
        const p = params as Record<string, unknown>;
        const removed = await removeWatch(ctx, String(p.watchId));
        return { content: JSON.stringify({ removed, watchId: String(p.watchId) }) };
      },
    );

    ctx.tools.register(
      "list_watch_templates",
      {
        displayName: "List Watch Templates",
        description: "Lists built-in watch templates for common use cases like sales follow-ups, deal monitoring, and error diagnosis.",
        parametersSchema: {
          type: "object",
          properties: {},
        },
      },
      async (_params, _runCtx) => {
        const templates = BUILTIN_WATCH_TEMPLATES.map((t) => ({
          name: t.name,
          eventPattern: t.eventPattern,
          description: t.description,
        }));
        return { content: JSON.stringify({ templates }) };
      },
    );

    // =========================================================================
    // Notification helper (supports per-type channel override + threading)
    // =========================================================================

    const notify = async (
      event: PluginEvent,
      formatter: (e: PluginEvent) => SlackMessage,
      overrideChannelId?: string,
      opts?: { threadTs?: string },
    ) => {
      const liveConfig = await getConfig(event.companyId);
      const fallback = overrideChannelId || liveConfig.defaultChannelId;
      const channelId = await resolveChannel(ctx, event.companyId, fallback);
      if (!channelId) return;
      const result = await postMessage(ctx, token, channelId, formatter(event), opts);
      if (result.ok) {
        await ctx.activity.log({
          companyId: event.companyId,
          message: `Forwarded ${event.eventType} to Slack`,
          entityType: "plugin",
          entityId: event.entityId,
        });
        await ctx.metrics.write("slack.notifications.sent", 1, { event_type: event.eventType });
      } else {
        await ctx.metrics.write("slack.notifications.failed", 1, { event_type: event.eventType, error_code: result.error ?? "unknown" });
      }
      return result;
    };

    // =========================================================================
    // Core event subscriptions (existing notifications)
    // =========================================================================

    // Handlers are always registered so that config changes (e.g. toggling
    // notifyOnAgentConnected) take effect without a plugin restart.
    ctx.events.on("issue.created", async (event: PluginEvent) => {
      const issueId = event.entityId ?? "";
      if (!issueId || notifiedIssueIds.has(issueId)) return;
      notifiedIssueIds.add(issueId);

      try {
        const existingThread = await ctx.state.get({
          scopeKind: "company",
          scopeId: event.companyId,
          stateKey: STATE_KEYS.threadIssue(issueId),
        });
        if (existingThread) return;

        const live = await getConfig(event.companyId);
        if (!live.notifyOnIssueCreated) return;
        const result = await notify(event, formatIssueCreated);
        if (!result?.ok || !result.ts) {
          notifiedIssueIds.delete(issueId);
          return;
        }

        const channelId = result.channel ?? await resolveChannel(ctx, event.companyId, live.defaultChannelId);
        await ctx.state.set(
          { scopeKind: "company", scopeId: event.companyId, stateKey: STATE_KEYS.threadIssue(issueId) },
          result.ts,
        );
        if (channelId) {
          issueBySlackThread.set(`${channelId}:${result.ts}`, issueId);
          slackThreadByIssue.set(issueId, { channelId, threadTs: result.ts });
          await ctx.state.set(
            { scopeKind: "company", scopeId: event.companyId, stateKey: STATE_KEYS.threadIssueChannel(issueId) },
            channelId,
          );
          await ctx.state.set(
            { scopeKind: "company", scopeId: event.companyId, stateKey: STATE_KEYS.issueForThread(channelId, result.ts) },
            issueId,
          );
        }
      } catch (error) {
        notifiedIssueIds.delete(issueId);
        throw error;
      }
    });

    ctx.events.on("issue.comment.created", async (event: PluginEvent) => {
      if (handledPaperclipEvents.has(event.eventId)) return;
      handledPaperclipEvents.add(event.eventId);
      const issueId = event.entityId ?? "";
      const payload = event.payload as Record<string, unknown>;
      const commentId = String(payload.commentId ?? "");
      if (!issueId || !commentId) return;

      const live = await getConfig(event.companyId);
      const comments = await ctx.issues.listComments(issueId, event.companyId);
      const comment = comments.find((candidate) => candidate.id === commentId);
      if (!comment || comment.authorUserId === live.paperclipUserId) return;

      const linkedThread = slackThreadByIssue.get(issueId);
      const threadTs = linkedThread?.threadTs ?? await ctx.state.get({
          scopeKind: "company",
          scopeId: event.companyId,
          stateKey: STATE_KEYS.threadIssue(issueId),
        }) as string | null;
      const channelId = linkedThread?.channelId ?? await ctx.state.get({
          scopeKind: "company",
          scopeId: event.companyId,
          stateKey: STATE_KEYS.threadIssueChannel(issueId),
        }) as string | null;
      if (!threadTs || !channelId) return;

      let authorName = "Paperclip";
      if (comment.authorAgentId) {
        const agent = await ctx.agents.get(comment.authorAgentId, event.companyId);
        authorName = agent?.name ?? "Paperclip agent";
      }
      const message = `*${authorName}:* ${comment.body}`;
      const result = await postMessage(ctx, token, channelId, { text: message }, { threadTs });
      if (result.ok) await ctx.metrics.write("slack.issue_comments.sent", 1);
    });

    ctx.events.on("issue.updated", async (event: PluginEvent) => {
      if (handledPaperclipEvents.has(event.eventId)) return;
      handledPaperclipEvents.add(event.eventId);
      const live = await getConfig(event.companyId);
      if (!live.notifyOnIssueDone) return;
      const payload = event.payload as Record<string, unknown>;
      if (payload.status !== "done") return;
      const issueId = event.entityId ?? "";
      const linkedThread = slackThreadByIssue.get(issueId);
      const threadTs = linkedThread?.threadTs ?? await ctx.state.get({
          scopeKind: "company",
          scopeId: event.companyId,
          stateKey: STATE_KEYS.threadIssue(issueId),
        }) as string | null;
      const channelId = linkedThread?.channelId ?? await ctx.state.get({
          scopeKind: "company",
          scopeId: event.companyId,
          stateKey: STATE_KEYS.threadIssueChannel(issueId),
        }) as string | null;
      await notify(event, formatIssueDone, channelId ?? undefined, threadTs ? { threadTs } : undefined);
    });

    ctx.events.on("approval.created", async (event: PluginEvent) => {
      const live = await getConfig(event.companyId);
      if (!live.notifyOnApprovalCreated) return;
      await notify(event, formatApprovalCreated, live.approvalsChannelId);
    });

    ctx.events.on("agent.run.failed", async (event: PluginEvent) => {
      const live = await getConfig(event.companyId);
      if (!live.notifyOnAgentError) return;
      await notify(event, formatAgentError, live.errorsChannelId);
    });

    ctx.events.on("agent.status_changed", async (event: PluginEvent) => {
      const live = await getConfig(event.companyId);
      if (!live.notifyOnAgentConnected) return;
      const payload = event.payload as Record<string, unknown>;
      if (payload.status === "active" || payload.status === "online") {
        await notify(event, formatAgentConnected, live.pipelineChannelId);
      }
    });

    ctx.events.on("agent.run.finished", async (event: PluginEvent) => {
      const live = await getConfig(event.companyId);
      if (!live.notifyOnAgentConnected) return;
      const payload = event.payload as Record<string, unknown>;
      // Dedup on agent id, not run id — event.entityId is the run UUID for
      // agent.run.finished, so using it produces a unique key every run.
      const agentId = String(payload.agentId ?? event.entityId ?? "");
      const key = STATE_KEYS.firstRunNotified(agentId);
      const alreadyNotified = await ctx.state.get({
        scopeKind: "company",
        scopeId: event.companyId,
        stateKey: key,
      });
      if (alreadyNotified) return;

      await ctx.state.set(
        { scopeKind: "company", scopeId: event.companyId, stateKey: key },
        true,
      );
      const milestoneEvent = {
        ...event,
        payload: {
          ...payload,
          agentName: String(payload.agentName ?? payload.name ?? agentId),
          milestone: "first successful run",
        },
      };
      await notify(milestoneEvent, formatOnboardingMilestone, live.pipelineChannelId);
    });

    ctx.events.on("cost_event.created", async (event: PluginEvent) => {
      const live = await getConfig(event.companyId);
      if (!live.notifyOnBudgetThreshold) return;
      const payload = event.payload as Record<string, unknown>;
      const pct = Number(payload.percentUsed ?? 0);
      if (pct < 80) return;

      const bucket = pct >= 100 ? 100 : pct >= 90 ? 90 : 80;
      const key = STATE_KEYS.budgetAlert(event.entityId ?? "", bucket);
      const alreadySent = await ctx.state.get({
        scopeKind: "company",
        scopeId: event.companyId,
        stateKey: key,
      });
      if (alreadySent) return;

      await ctx.state.set(
        { scopeKind: "company", scopeId: event.companyId, stateKey: key },
        true,
      );
      await notify(event, formatBudgetThreshold, live.pipelineChannelId);
      await ctx.metrics.write("slack.budget_alerts.sent", 1, { threshold: String(bucket) });
    });

    // =========================================================================
    // Per-company channel overrides
    // =========================================================================

    ctx.data.register("channel-mapping", async (params) => {
      const companyId = String(params.companyId);
      const saved = await ctx.state.get({
        scopeKind: "company",
        scopeId: companyId,
        stateKey: STATE_KEYS.slackChannel,
      });
      return { channelId: saved ?? config.defaultChannelId };
    });

    ctx.actions.register("set-channel", async (params) => {
      const companyId = String(params.companyId);
      const channelId = String(params.channelId);
      await ctx.state.set(
        { scopeKind: "company", scopeId: companyId, stateKey: STATE_KEYS.slackChannel },
        channelId,
      );
      ctx.logger.info("Updated Slack channel mapping", { companyId, channelId });
      return { ok: true };
    });

    // =========================================================================
    // Jobs
    // =========================================================================

    ctx.jobs.register("check-pending-plan-approvals", async () => {
      // Scheduled jobs have no company invocation scope. Use the already-paired
      // board credential and instance-scoped plugin state; the Paperclip routes
      // still authenticate and attribute every decision to that board user.
      if (!pluginCompanyId || !paperclipApiKey || !pluginConfig.paperclipBaseUrl) return;
      if (pluginConfig.notifyOnPlanApproval === false) return;

      type ReviewIssue = { id: string; identifier?: string | null; title?: string | null };
      const statePrefix = `${pluginCompanyId}:`;
      const storedRegistry = await ctx.state.get({
        scopeKind: "instance",
        stateKey: `${statePrefix}${STATE_KEYS.planApprovalRegistry}`,
      });
      const registry = Array.isArray(storedRegistry)
        ? storedRegistry as PlanApprovalMessageRef[]
        : [];

      // First converge cards that were resolved in Paperclip instead of Slack.
      for (const ref of registry) {
        const alreadyResolved = await ctx.state.get({
          scopeKind: "instance",
          stateKey: `${statePrefix}${STATE_KEYS.planApprovalResolved(ref.interactionId)}`,
        });
        if (alreadyResolved) continue;
        try {
          const [issue, interactions] = await Promise.all([
            paperclipRequest<ReviewIssue>(ctx, `/api/issues/${ref.issueId}`),
            paperclipRequest<PlanApprovalInteraction[]>(ctx, `/api/issues/${ref.issueId}/interactions`),
          ]);
          const interaction = interactions.find((candidate) => candidate.id === ref.interactionId);
          if (
            !interaction
            || interaction.status === "pending"
            || !isPlanApprovalInteraction(interaction)
          ) continue;
          const updated = await updateMessage(
            ctx,
            token,
            ref.channelId,
            ref.messageTs,
            buildResolvedPlanApprovalMessage(
              issue,
              interaction,
              pluginConfig.paperclipBaseUrl,
            ),
          );
          if (updated.ok) {
            await ctx.state.set(
              {
                scopeKind: "instance",
                stateKey: `${statePrefix}${STATE_KEYS.planApprovalResolved(ref.interactionId)}`,
              },
              true,
            );
          }
        } catch (err) {
          ctx.logger.warn("Could not synchronize a resolved Plan approval card", {
            error: String(err),
            interactionId: ref.interactionId,
          });
        }
      }

      let offset = 0;
      while (true) {
        const issues = await paperclipRequest<ReviewIssue[]>(
          ctx,
          `/api/companies/${pluginCompanyId}/issues?status=in_review&limit=100&offset=${offset}`,
        );
        for (const issue of issues) {
          try {
            const interactions = await paperclipRequest<PlanApprovalInteraction[]>(
              ctx,
              `/api/issues/${issue.id}/interactions`,
            );
            for (const interaction of interactions) {
              if (
                interaction.status !== "pending"
                || !isPlanApprovalInteraction(interaction)
              ) continue;

              const storedMessage = await ctx.state.get({
                scopeKind: "instance",
                stateKey: `${statePrefix}${STATE_KEYS.planApprovalMessage(interaction.id)}`,
              }) as PlanApprovalMessageRef | null;
              if (storedMessage) {
                if (!registry.some((entry) => entry.interactionId === interaction.id)) {
                  registry.push(storedMessage);
                }
                continue;
              }

              const linkedThread = await findSlackThreadForIssue(
                ctx,
                issue.id,
                issue.identifier,
              );
              if (!linkedThread) continue;

              const sent = await postMessage(
                ctx,
                token,
                linkedThread.channelId,
                buildPlanApprovalMessage(issue, interaction, pluginConfig.paperclipBaseUrl),
                { threadTs: linkedThread.threadTs },
              );
              if (!sent.ok || !sent.ts) continue;

              const messageRef: PlanApprovalMessageRef = {
                issueId: issue.id,
                interactionId: interaction.id,
                channelId: sent.channel ?? linkedThread.channelId,
                messageTs: sent.ts,
              };
              await ctx.state.set(
                {
                  scopeKind: "instance",
                  stateKey: `${statePrefix}${STATE_KEYS.planApprovalMessage(interaction.id)}`,
                },
                messageRef,
              );
              registry.push(messageRef);
              await ctx.metrics.write("slack.plan_approvals.sent", 1);
            }
          } catch (err) {
            ctx.logger.warn("Could not mirror pending Plan approvals for an issue", {
              error: String(err),
              issueId: issue.id,
            });
          }
        }
        if (issues.length < 100) break;
        offset += issues.length;
      }

      await ctx.state.set(
        {
          scopeKind: "instance",
          stateKey: `${statePrefix}${STATE_KEYS.planApprovalRegistry}`,
        },
        registry.slice(-500),
      );
    });

    // Daily digest
    if (config.enableDailyDigest) {
      ctx.jobs.register("daily-digest", async () => {
        const companies = await ctx.companies.list({ limit: 100, offset: 0 });
        for (const company of companies) {
          const channelId = await resolveChannel(ctx, company.id, config.defaultChannelId);
          if (!channelId) continue;

          const issues = await ctx.issues.list({ companyId: company.id, limit: 200, offset: 0 });
          const now = new Date();
          const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

          let tasksCompleted = 0;
          let tasksCreated = 0;
          for (const issue of issues) {
            const updated = new Date(issue.updatedAt);
            const created = new Date(issue.createdAt);
            if (issue.status === "done" && updated >= dayAgo) tasksCompleted++;
            if (created >= dayAgo) tasksCreated++;
          }

          const agents = await ctx.agents.list({ companyId: company.id, limit: 100, offset: 0 });
          const agentsActive = agents.filter((a) =>
            a.status === "active" || a.status === "running"
          ).length;

          const dateKey = now.toISOString().slice(0, 10);
          const dailyCost = await ctx.state.get({
            scopeKind: "company",
            scopeId: company.id,
            stateKey: STATE_KEYS.dailyCost(dateKey),
          });
          const totalCost = dailyCost ? String((dailyCost as number).toFixed(2)) : "0.00";

          const topAgentCosts = await ctx.state.get({
            scopeKind: "company",
            scopeId: company.id,
            stateKey: STATE_KEYS.dailyAgentCosts(dateKey),
          });
          let topAgent = "";
          if (topAgentCosts && typeof topAgentCosts === "object") {
            const costs = topAgentCosts as Record<string, number>;
            let maxCost = 0;
            for (const [name, cost] of Object.entries(costs)) {
              if (cost > maxCost) { maxCost = cost; topAgent = name; }
            }
          }

          await postMessage(ctx, token, channelId, formatDailyDigest({
            tasksCompleted,
            tasksCreated,
            agentsActive,
            totalCost,
            topAgent,
          }));

          // Clean up previous day's cost state
          const yesterday = new Date(now.getTime() - 86400000).toISOString().slice(0, 10);
          await ctx.state.delete({
            scopeKind: "company",
            scopeId: company.id,
            stateKey: STATE_KEYS.dailyCost(yesterday),
          });
          await ctx.state.delete({
            scopeKind: "company",
            scopeId: company.id,
            stateKey: STATE_KEYS.dailyAgentCosts(yesterday),
          });
        }
        ctx.logger.info("Daily digest posted to Slack");
        await ctx.metrics.write("slack.digest.sent", 1);
      });

      // Accumulate costs
      ctx.events.on("cost_event.created", async (event: PluginEvent) => {
        const payload = event.payload as Record<string, unknown>;
        const cost = Number(payload.cost ?? 0);
        if (cost <= 0) return;

        const dateKey = new Date().toISOString().slice(0, 10);
        const currentTotal = await ctx.state.get({
          scopeKind: "company",
          scopeId: event.companyId,
          stateKey: STATE_KEYS.dailyCost(dateKey),
        });
        await ctx.state.set(
          { scopeKind: "company", scopeId: event.companyId, stateKey: STATE_KEYS.dailyCost(dateKey) },
          ((currentTotal as number) ?? 0) + cost,
        );

        const agentName = String(payload.agentName ?? payload.name ?? event.entityId);
        const agentCosts = await ctx.state.get({
          scopeKind: "company",
          scopeId: event.companyId,
          stateKey: STATE_KEYS.dailyAgentCosts(dateKey),
        });
        const costs = (agentCosts as Record<string, number>) ?? {};
        costs[agentName] = (costs[agentName] ?? 0) + cost;
        await ctx.state.set(
          { scopeKind: "company", scopeId: event.companyId, stateKey: STATE_KEYS.dailyAgentCosts(dateKey) },
          costs,
        );
      });

      ctx.logger.info("Daily digest job registered (9am daily)");
    }

    // Escalation timeout job
    ctx.jobs.register("check-escalation-timeouts", async () => {
      const companies = await ctx.companies.list({ limit: 100, offset: 0 });
      const timeoutMs = config.escalationTimeoutMs ?? 900000;
      const now = Date.now();

      for (const company of companies) {
        const openEscalationsRaw = await ctx.state.get({
          scopeKind: "company",
          scopeId: company.id,
          stateKey: "escalation-records-index",
        });
        const escalationIds = Array.isArray(openEscalationsRaw) ? openEscalationsRaw as string[] : [];

        for (const escalationKey of escalationIds) {
          const record = await ctx.state.get({
            scopeKind: "company",
            scopeId: company.id,
            stateKey: STATE_KEYS.escalationRecord(escalationKey),
          }) as Record<string, unknown> | null;
          if (!record || record.status !== "open") continue;

          const createdAt = new Date(String(record.createdAt)).getTime();
          if (now - createdAt < timeoutMs) continue;

          const escalationId = String(record.id);
          const defaultAction = config.escalationDefaultAction ?? "defer";

          await ctx.state.set(
            { scopeKind: "company", scopeId: company.id, stateKey: STATE_KEYS.escalationRecord(escalationId) },
            { ...record, status: "timed_out", resolvedAt: new Date().toISOString(), resolvedBy: "system:timeout" },
          );

          const channelId = await ctx.state.get({
            scopeKind: "company",
            scopeId: company.id,
            stateKey: STATE_KEYS.escalationChannel(escalationId),
          }) as string | null;

          const threadTs = await ctx.state.get({
            scopeKind: "company",
            scopeId: company.id,
            stateKey: STATE_KEYS.escalationTs(escalationId),
          }) as string | null;

          if (channelId && threadTs) {
            await postMessage(ctx, token, channelId, {
              text: `Escalation timed out - default action: ${defaultAction}`,
              blocks: [
                {
                  type: "section",
                  text: {
                    type: "mrkdwn",
                    text: `:hourglass: *Escalation timed out*\nDefault action applied: \`${defaultAction}\``,
                  },
                },
              ],
            }, { threadTs });
          }

          await ctx.metrics.write("slack.escalations.timed_out", 1, { action: defaultAction });
          ctx.logger.info("Escalation timed out", { escalationId, defaultAction });
        }
      }
    });

    // Phase 5: Check watches job
    ctx.jobs.register("check-watches", async () => {
      const companies = await ctx.companies.list({ limit: 100, offset: 0 });
      for (const company of companies) {
        // Get recent events from state (populated by event listeners below)
        const recentEventsRaw = await ctx.state.get({
          scopeKind: "company",
          scopeId: company.id,
          stateKey: "recent-watch-events",
        });
        const recentEvents = Array.isArray(recentEventsRaw)
          ? (recentEventsRaw as Array<{ eventType: string; payload: Record<string, unknown> }>)
          : [];

        if (recentEvents.length > 0) {
          await checkWatches(ctx, token, company.id, recentEvents);
          // Clear after processing
          await ctx.state.set(
            { scopeKind: "company", scopeId: company.id, stateKey: "recent-watch-events" },
            [],
          );
        }
      }
    });

    // =========================================================================
    // Agent output listeners (native streaming + ACP events)
    // =========================================================================

    // Native agent streaming output
    ctx.events.on("plugin.slack.agent-stream-chunk", async (event: PluginEvent) => {
      const p = event.payload as Record<string, unknown>;
      await handleAgentOutput(ctx, token, event.companyId, {
        channel: String(p.channel ?? ""),
        threadTs: String(p.threadTs ?? ""),
        text: String(p.text ?? ""),
        agentName: p.agentName != null ? String(p.agentName) : undefined,
        agentDisplayName: p.agentDisplayName != null ? String(p.agentDisplayName) : undefined,
        toolName: p.toolName != null ? String(p.toolName) : undefined,
      });
    });

    // ACP output events (from cross-plugin)
    ctx.events.on(`plugin.paperclip-plugin-acp.output`, async (event: PluginEvent) => {
      const p = event.payload as Record<string, unknown>;
      await handleAgentOutput(ctx, token, event.companyId, {
        channel: String(p.channel ?? ""),
        threadTs: String(p.threadTs ?? ""),
        text: String(p.text ?? ""),
        agentName: p.agentName != null ? String(p.agentName) : undefined,
        agentDisplayName: p.agentDisplayName != null ? String(p.agentDisplayName) : undefined,
        toolName: p.toolName != null ? String(p.toolName) : undefined,
      });
    });

    // Escalation thread reply routing (from Slack Events API)
    ctx.events.on("plugin.slack.thread_reply_escalation", async (event: PluginEvent) => {
      const p = event.payload as Record<string, unknown>;
      const escalationId = String(p.escalationId ?? "");
      const replyText = String(p.text ?? "");
      const userId = String(p.userId ?? "unknown");
      if (!escalationId || !replyText) return;

      const record = await ctx.state.get({
        scopeKind: "company",
        scopeId: event.companyId,
        stateKey: STATE_KEYS.escalationRecord(escalationId),
      }) as Record<string, unknown> | null;

      if (record) {
        await ctx.state.set(
          { scopeKind: "company", scopeId: event.companyId, stateKey: STATE_KEYS.escalationRecord(escalationId) },
          { ...record, status: "resolved", resolvedAt: new Date().toISOString(), resolvedBy: `slack:${userId}` },
        );
      }

      // Route reply to agent session if we have one
      if (record?.sessionId && record?.agentName) {
        const sessions = await ctx.state.get({
          scopeKind: "company",
          scopeId: event.companyId,
          stateKey: STATE_KEYS.sessionRegistry(
            String(record.channelId ?? ""),
            String(record.threadTs ?? ""),
          ),
        });
        // Find session and send reply back
        if (Array.isArray(sessions)) {
          const session = (sessions as SessionEntry[]).find(
            (s) => s.agentName === String(record.agentName) && s.status === "active",
          );
          if (session && session.transport === "native") {
            await ctx.agents.sessions.sendMessage(session.sessionId, event.companyId, {
              prompt: `Human reply to escalation: ${replyText}`,
              reason: "Escalation reply from Slack",
            });
          }
        }
      }

      await ctx.metrics.write("slack.escalations.resolved", 1, { action: "human_reply" });
    });

    // Thread message routing (multi-agent + custom commands + media)
    ctx.events.on("plugin.slack.thread_message", async (event: PluginEvent) => {
      const p = event.payload as Record<string, unknown>;
      const channel = String(p.channel ?? "");
      const threadTs = String(p.threadTs ?? "");
      const text = String(p.text ?? "");
      const replyToMessageTs = p.replyToMessageTs != null ? String(p.replyToMessageTs) : undefined;
      const files = Array.isArray(p.files) ? p.files as Array<Record<string, unknown>> : [];
      if (!channel || !threadTs) return;

      // Phase 3: Check for media files
      for (const file of files) {
        const fileId = String(file.id ?? "");
        const mimetype = String(file.mimetype ?? "");
        if (fileId && isMediaFile(mimetype)) {
          await processMediaFile(ctx, token, event.companyId, fileId, channel, threadTs);
        }
      }

      // Phase 4: Check for custom commands
      if (text) {
        const handled = await tryCustomCommand(ctx, token, event.companyId, channel, threadTs, text);
        if (handled) return;
      }

      // Phase 2: Route to agent sessions
      if (text) {
        await routeMessageToAgent(ctx, event.companyId, channel, threadTs, text, replyToMessageTs);
      }
    });

    // Collect events for watch checking (Phase 5)
    const watchableEvents: Array<"issue.created" | "issue.updated" | "agent.run.failed" | "agent.run.finished" | "agent.status_changed" | "cost_event.created" | "approval.created"> = [
      "issue.created", "issue.updated",
      "agent.run.failed", "agent.run.finished", "agent.status_changed",
      "cost_event.created", "approval.created",
    ];
    for (const eventType of watchableEvents) {
      ctx.events.on(eventType, async (event: PluginEvent) => {
        const recentEventsRaw = await ctx.state.get({
          scopeKind: "company",
          scopeId: event.companyId,
          stateKey: "recent-watch-events",
        });
        const recentEvents = Array.isArray(recentEventsRaw)
          ? (recentEventsRaw as Array<{ eventType: string; payload: Record<string, unknown> }>)
          : [];

        // Keep last 100 events
        recentEvents.push({
          eventType: event.eventType,
          payload: event.payload as Record<string, unknown>,
        });
        if (recentEvents.length > 100) {
          recentEvents.splice(0, recentEvents.length - 100);
        }

        await ctx.state.set(
          { scopeKind: "company", scopeId: event.companyId, stateKey: "recent-watch-events" },
          recentEvents,
        );
      });
    }

    ctx.logger.info("Slack Chat OS plugin started");
  },

  // =========================================================================
  // Webhook handler (Slack Events, Slash Commands, Interactivity)
  // =========================================================================

  async onWebhook(input: PluginWebhookInput): Promise<void> {
    // Verify Slack request signature (skip for url_verification challenge)
    const body = input.parsedBody as Record<string, unknown> | undefined;
    const isVerificationChallenge = body?.type === "url_verification";

    if (!isVerificationChallenge && !verifySlackSignature(input.headers, input.rawBody)) {
      pluginCtx.logger.warn("Rejected webhook: invalid Slack signature");
      return;
    }

    // Slack Events API (url_verification + event callbacks)
    if (input.endpointKey === WEBHOOK_KEYS.slackEvents) {
      if (body?.type === "url_verification") {
        return;
      }
      if (body) await handleSlackEventCallback(pluginCtx, body);
      return;
    }

    // Slash commands
    if (input.endpointKey === WEBHOOK_KEYS.slashCommand) {
      await handleSlashCommand(pluginCtx, input.rawBody);
      return;
    }

    // Interactivity (button clicks)
    if (input.endpointKey === WEBHOOK_KEYS.interactivity) {
      const payload = body?.payload
        ? JSON.parse(String(body.payload)) as Record<string, unknown>
        : body;
      if (!payload) return;

      const planAction = payload.type === "block_actions"
        && Array.isArray(payload.actions)
        && [PLAN_APPROVE_ACTION_ID, PLAN_REJECT_ACTION_ID].includes(
          String((payload.actions as Array<Record<string, unknown>>)[0]?.action_id ?? ""),
        );
      const view = payload.view as Record<string, unknown> | undefined;
      const planRejectionSubmission = payload.type === "view_submission"
        && view?.callback_id === PLAN_REJECT_MODAL_CALLBACK_ID;
      if (planAction || planRejectionSubmission) {
        // Socket Mode is the configured transport. Never let an unsigned HTTP
        // webhook synthesize a plan decision when no signing secret is bound.
        if (!slackSigningSecret) {
          pluginCtx.logger.warn("Rejected unsigned Slack Plan approval webhook");
          return;
        }
        await handleSlackInteractivePayload(pluginCtx, payload);
        return;
      }

      if (payload.type !== "block_actions") return;

      const actions = payload.actions as Array<Record<string, unknown>>;
      const responseUrl = String(payload.response_url ?? "");
      const user = payload.user as Record<string, unknown> | undefined;
      const userId = user ? String(user.id ?? user.username ?? "unknown") : "unknown";

      if (!actions?.length || !responseUrl) return;

      const action = actions[0];
      const actionId = String(action.action_id ?? "");
      const actionValue = String(action.value ?? "");

      if (!actionValue) return;

      const companies = await pluginCtx.companies.list({ limit: 1, offset: 0 });
      const companyId = companies[0]?.id ?? "";

      // --- Approval buttons ---
      if (actionId === "approval_approve" || actionId === "approval_reject") {
        const approved = actionId === "approval_approve";
        const endpoint = approved ? "approve" : "reject";
        try {
          await pluginCtx.http.fetch(
            `${pluginConfig.paperclipBaseUrl}/api/approvals/${actionValue}/${endpoint}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ decidedByUserId: `slack:${userId}` }),
            },
          );

          await respondToAction(
            pluginCtx,
            pluginToken,
            responseUrl,
            formatApprovalResolved(actionValue, approved, userId),
          );
          await pluginCtx.metrics.write("slack.approvals.decided", 1, { decision: endpoint });
        } catch (err) {
          pluginCtx.logger.warn("Failed to handle approval action", { err, approvalId: actionValue });
        }
        return;
      }

      // --- Escalation buttons ---
      if (
        actionId === "escalation_use_suggested" ||
        actionId === "escalation_reply" ||
        actionId === "escalation_override" ||
        actionId === "escalation_dismiss"
      ) {
        try {
          const record = await pluginCtx.state.get({
            scopeKind: "company",
            scopeId: companyId,
            stateKey: STATE_KEYS.escalationRecord(actionValue),
          }) as Record<string, unknown> | null;

          if (record) {
            await pluginCtx.state.set(
              { scopeKind: "company", scopeId: companyId, stateKey: STATE_KEYS.escalationRecord(actionValue) },
              { ...record, status: "resolved", resolvedAt: new Date().toISOString(), resolvedBy: `slack:${userId}` },
            );
          }

          await respondToAction(
            pluginCtx,
            pluginToken,
            responseUrl,
            formatEscalationResolved(actionValue, actionId, userId),
          );
          await pluginCtx.metrics.write("slack.escalations.resolved", 1, { action: actionId });
        } catch (err) {
          pluginCtx.logger.warn("Failed to handle escalation action", { err, escalationId: actionValue });
        }
        return;
      }

      // --- Handoff buttons ---
      if (actionId === "handoff_approve" || actionId === "handoff_reject") {
        try {
          const approved = actionId === "handoff_approve";
          await handleHandoffAction(pluginCtx, pluginToken, companyId, actionValue, approved, userId);

          const emoji = approved ? ":white_check_mark:" : ":x:";
          const label = approved ? "Approved" : "Rejected";
          await respondToAction(pluginCtx, pluginToken, responseUrl, {
            text: `Handoff ${label} by ${userId}`,
            blocks: [
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: `${emoji} *Handoff ${label}* by <@${userId}>`,
                },
              },
            ],
          });
        } catch (err) {
          pluginCtx.logger.warn("Failed to handle handoff action", { err, handoffId: actionValue });
        }
        return;
      }

      // --- Discussion loop buttons ---
      if (actionId === "discussion_continue" || actionId === "discussion_stop") {
        try {
          const discAction = actionId === "discussion_continue" ? "continue" as const : "stop" as const;
          await handleDiscussionAction(pluginCtx, pluginToken, companyId, actionValue, discAction, userId);

          const emoji = discAction === "continue" ? ":arrow_forward:" : ":stop_button:";
          const label = discAction === "continue" ? "Resumed" : "Stopped";
          await respondToAction(pluginCtx, pluginToken, responseUrl, {
            text: `Discussion ${label} by ${userId}`,
            blocks: [
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: `${emoji} *Discussion ${label}* by <@${userId}>`,
                },
              },
            ],
          });
        } catch (err) {
          pluginCtx.logger.warn("Failed to handle discussion action", { err, discussionId: actionValue });
        }
        return;
      }

      // --- Command step approval buttons (Phase 4) ---
      if (actionId === "command_step_approve" || actionId === "command_step_reject") {
        const approved = actionId === "command_step_approve";
        const emoji = approved ? ":white_check_mark:" : ":x:";
        const label = approved ? "Approved" : "Rejected";
        await respondToAction(pluginCtx, pluginToken, responseUrl, {
          text: `Step ${label} by ${userId}`,
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `${emoji} *Step ${label}* by <@${userId}>`,
              },
            },
          ],
        });
        return;
      }
    }
  },

  async onValidateConfig(config) {
    if (!config.slackTokenRef) {
      return { ok: false, errors: ["slackTokenRef is required"] };
    }
    if (!config.defaultChannelId || typeof config.defaultChannelId !== "string") {
      return { ok: false, errors: ["defaultChannelId is required"] };
    }
    if (!config.slackAppTokenRef) {
      return { ok: false, errors: ["slackAppTokenRef is required for bidirectional Socket Mode"] };
    }
    if (!config.paperclipApiKeyRef) {
      return { ok: false, errors: ["paperclipApiKeyRef is required for Slack reply relay"] };
    }
    if (!config.slackUserId || typeof config.slackUserId !== "string") {
      return { ok: false, errors: ["slackUserId is required"] };
    }
    if (!config.paperclipUserId || typeof config.paperclipUserId !== "string") {
      return { ok: false, errors: ["paperclipUserId is required"] };
    }
    return { ok: true };
  },

  async onShutdown() {
    await socketModeClient?.stop();
    socketModeClient = null;
  },

  async onConfigChanged(config, context) {
    if (!context?.companyId || !applyRuntimeConfig) return;
    await applyRuntimeConfig(config as unknown as SlackConfig, context.companyId);
  },

  async onHealth(): Promise<PluginHealthDiagnostics> {
    return runtimeHealth;
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
