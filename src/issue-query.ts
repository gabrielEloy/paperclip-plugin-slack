import type { Issue } from "@paperclipai/shared";
import type { SlackMessage } from "./slack-api.js";

export type IssueQueueStatus = "blocked" | "in_review";

const PRIORITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const PRIORITY_LABELS: Record<string, string> = {
  critical: "crítica",
  high: "alta",
  medium: "média",
  low: "baixa",
};

const QUEUE_COPY: Record<IssueQueueStatus, {
  title: string;
  empty: string;
  emoji: string;
}> = {
  blocked: {
    title: "Tasks bloqueadas",
    empty: "Nenhuma task está bloqueada.",
    emoji: ":no_entry:",
  },
  in_review: {
    title: "Tasks pendentes de revisão",
    empty: "Nenhuma task está pendente de revisão.",
    emoji: ":mag:",
  },
};

function escapeSlackText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("|", "¦");
}

function issueUrl(baseUrl: string, issueId: string): string {
  return `${baseUrl.replace(/\/$/, "")}/issues/${encodeURIComponent(issueId)}`;
}

function issueLine(issue: Issue, status: IssueQueueStatus, baseUrl: string): string {
  const copy = QUEUE_COPY[status];
  const identifier = escapeSlackText(issue.identifier?.trim() || `#${issue.issueNumber ?? "?"}`);
  const title = escapeSlackText(issue.title.trim());
  const priority = PRIORITY_LABELS[issue.priority] ?? escapeSlackText(issue.priority);
  return `${copy.emoji} <${issueUrl(baseUrl, issue.id)}|${identifier}> — ${title} · prioridade ${priority}`;
}

function sortedIssues(issues: Issue[]): Issue[] {
  return [...issues].sort((left, right) => {
    const priority = (PRIORITY_ORDER[left.priority] ?? 99) - (PRIORITY_ORDER[right.priority] ?? 99);
    if (priority !== 0) return priority;
    return (left.identifier ?? left.title).localeCompare(right.identifier ?? right.title, "pt-BR");
  });
}

function chunkLines(lines: string[], maxLength = 2_900): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > maxLength && current) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export function buildIssueQueueMessage(
  issues: Issue[],
  status: IssueQueueStatus,
  baseUrl: string,
): SlackMessage {
  const copy = QUEUE_COPY[status];
  if (issues.length === 0) {
    return {
      text: copy.empty,
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: `:white_check_mark: ${copy.empty}` },
        },
      ],
    };
  }

  const lines = sortedIssues(issues).map((issue) => issueLine(issue, status, baseUrl));
  const allChunks = chunkLines(lines);
  const displayedChunks = allChunks.slice(0, 47);
  const truncated = displayedChunks.length < allChunks.length;
  const blocks: Array<Record<string, unknown>> = [
    {
      type: "header",
      text: { type: "plain_text", text: `${copy.title} (${issues.length})`, emoji: true },
    },
    ...displayedChunks.map((text) => ({
      type: "section",
      text: { type: "mrkdwn", text },
    })),
  ];

  if (truncated) {
    blocks.push({
      type: "context",
      elements: [{
        type: "mrkdwn",
        text: `<${baseUrl.replace(/\/$/, "")}/issues|Abra o Paperclip para ver a lista completa.>`,
      }],
    });
  }

  return {
    text: `${copy.title}: ${issues.length}`,
    blocks,
  };
}
