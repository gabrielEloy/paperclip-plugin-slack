import type { SlackMessage } from "./slack-api.js";

export const PLAN_APPROVE_ACTION_ID = "paperclip_plan_approve";
export const PLAN_REJECT_ACTION_ID = "paperclip_plan_reject";
export const PLAN_REJECT_MODAL_CALLBACK_ID = "paperclip_plan_reject_modal";

export type PlanApprovalActionRef = {
  issueId: string;
  interactionId: string;
};

export type PlanApprovalMessageRef = PlanApprovalActionRef & {
  channelId: string;
  messageTs: string;
};

export type PlanApprovalIssue = {
  id: string;
  identifier?: string | null;
  title?: string | null;
};

export type PlanApprovalInteraction = {
  id: string;
  issueId: string;
  kind: string;
  status: string;
  title?: string | null;
  summary?: string | null;
  payload?: {
    prompt?: string | null;
    acceptLabel?: string | null;
    rejectLabel?: string | null;
    rejectRequiresReason?: boolean;
    rejectReasonLabel?: string | null;
    declineReasonPlaceholder?: string | null;
    detailsMarkdown?: string | null;
    target?: {
      type?: string | null;
      key?: string | null;
      label?: string | null;
    } | null;
  } | null;
  result?: {
    outcome?: string | null;
    reason?: string | null;
  } | null;
};

type SlackViewState = {
  values?: Record<string, Record<string, { value?: string }>>;
};

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function issueLabel(issue: PlanApprovalIssue): string {
  const identifier = issue.identifier?.trim();
  const title = issue.title?.trim();
  if (identifier && title) return `${identifier} · ${title}`;
  return identifier || title || "Task do Paperclip";
}

export function isPlanApprovalInteraction(
  interaction: { kind: string; payload?: unknown },
): interaction is PlanApprovalInteraction {
  const payload = interaction.payload && typeof interaction.payload === "object"
    ? interaction.payload as PlanApprovalInteraction["payload"]
    : null;
  return interaction.kind === "request_confirmation"
    && payload?.target?.type === "issue_document"
    && payload.target.key === "plan";
}

export function encodePlanApprovalActionRef(ref: PlanApprovalActionRef): string {
  return JSON.stringify(ref);
}

export function decodePlanApprovalActionRef(value: string): PlanApprovalActionRef | null {
  try {
    const parsed = JSON.parse(value) as Partial<PlanApprovalActionRef>;
    if (typeof parsed.issueId !== "string" || typeof parsed.interactionId !== "string") return null;
    if (!parsed.issueId.trim() || !parsed.interactionId.trim()) return null;
    return { issueId: parsed.issueId, interactionId: parsed.interactionId };
  } catch {
    return null;
  }
}

export function buildPlanApprovalMessage(
  issue: PlanApprovalIssue,
  interaction: PlanApprovalInteraction,
  paperclipBaseUrl: string,
): SlackMessage {
  const prompt = interaction.payload?.prompt?.trim() || interaction.summary?.trim() || "Revise e aprove o plano desta task.";
  const details = interaction.payload?.detailsMarkdown?.trim();
  const acceptLabel = truncate(interaction.payload?.acceptLabel?.trim() || "Aprovar fluxo", 75);
  const rejectLabel = truncate(interaction.payload?.rejectLabel?.trim() || "Solicitar alterações", 75);
  const actionValue = encodePlanApprovalActionRef({
    issueId: issue.id,
    interactionId: interaction.id,
  });
  const issueUrl = `${paperclipBaseUrl.replace(/\/$/, "")}/issues/${issue.id}#interaction-${interaction.id}`;

  const blocks: Array<Record<string, unknown>> = [
    {
      type: "header",
      text: { type: "plain_text", text: "Plano aguardando aprovação", emoji: true },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${truncate(issueLabel(issue), 240)}*${interaction.title ? `\n${truncate(interaction.title, 240)}` : ""}`,
      },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: truncate(prompt, 2_900) },
    },
  ];

  if (details) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: truncate(details, 2_900) },
    });
  }

  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: acceptLabel, emoji: true },
        style: "primary",
        action_id: PLAN_APPROVE_ACTION_ID,
        value: actionValue,
      },
      {
        type: "button",
        text: { type: "plain_text", text: rejectLabel, emoji: true },
        action_id: PLAN_REJECT_ACTION_ID,
        value: actionValue,
      },
      {
        type: "button",
        text: { type: "plain_text", text: "Ver plano", emoji: true },
        action_id: "paperclip_plan_view",
        url: issueUrl,
      },
    ],
  });

  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: "A decisão será registrada na task e retomará o agente responsável." }],
  });

  return {
    text: `Plano aguardando aprovação: ${issueLabel(issue)}`,
    blocks,
  };
}

export function buildResolvedPlanApprovalMessage(
  issue: PlanApprovalIssue,
  interaction: PlanApprovalInteraction,
  paperclipBaseUrl: string,
  slackUserId?: string,
): SlackMessage {
  const accepted = interaction.status === "accepted" || interaction.result?.outcome === "accepted";
  const rejected = interaction.status === "rejected" || interaction.result?.outcome === "rejected";
  const label = accepted ? "Fluxo aprovado" : rejected ? "Alterações solicitadas" : "Aprovação encerrada";
  const emoji = accepted ? ":white_check_mark:" : rejected ? ":memo:" : ":information_source:";
  const actor = slackUserId ? ` por <@${slackUserId}>` : " no Paperclip";
  const reason = interaction.result?.reason?.trim();
  const issueUrl = `${paperclipBaseUrl.replace(/\/$/, "")}/issues/${issue.id}#interaction-${interaction.id}`;

  return {
    text: `${label}: ${issueLabel(issue)}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `${emoji} *${label}*${actor}\n*${truncate(issueLabel(issue), 240)}*${reason ? `\n> ${truncate(reason, 2_700)}` : ""}`,
        },
        accessory: {
          type: "button",
          text: { type: "plain_text", text: "Ver task", emoji: true },
          action_id: "paperclip_plan_view_resolved",
          url: issueUrl,
        },
      },
    ],
  };
}

export function buildPlanRejectionModal(
  ref: PlanApprovalMessageRef,
): Record<string, unknown> {
  return {
    type: "modal",
    callback_id: PLAN_REJECT_MODAL_CALLBACK_ID,
    private_metadata: JSON.stringify(ref),
    title: { type: "plain_text", text: "Solicitar alterações" },
    submit: { type: "plain_text", text: "Enviar" },
    close: { type: "plain_text", text: "Cancelar" },
    blocks: [
      {
        type: "input",
        block_id: "plan_rejection_reason",
        label: { type: "plain_text", text: "O que precisa mudar?" },
        element: {
          type: "plain_text_input",
          action_id: "value",
          multiline: true,
          min_length: 1,
          max_length: 3000,
          placeholder: {
            type: "plain_text",
            text: "Descreva os ajustes necessários para o agente revisar o plano.",
          },
        },
      },
    ],
  };
}

export function parsePlanRejectionSubmission(input: {
  privateMetadata?: string;
  state?: SlackViewState;
}): PlanApprovalMessageRef & { reason: string } {
  const ref = input.privateMetadata
    ? JSON.parse(input.privateMetadata) as Partial<PlanApprovalMessageRef>
    : {};
  const reason = String(
    input.state?.values?.plan_rejection_reason?.value?.value ?? "",
  ).trim();
  if (
    typeof ref.issueId !== "string"
    || typeof ref.interactionId !== "string"
    || typeof ref.channelId !== "string"
    || typeof ref.messageTs !== "string"
    || !reason
  ) {
    throw new Error("Invalid plan rejection submission");
  }
  return {
    issueId: ref.issueId,
    interactionId: ref.interactionId,
    channelId: ref.channelId,
    messageTs: ref.messageTs,
    reason,
  };
}
