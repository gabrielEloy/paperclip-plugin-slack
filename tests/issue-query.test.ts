import { describe, expect, it } from "vitest";
import type { Issue } from "@paperclipai/shared";
import { buildIssueQueueMessage } from "../src/issue-query.js";

function issue(input: Partial<Issue> & Pick<Issue, "id" | "title" | "status">): Issue {
  return {
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    description: null,
    workMode: "execution",
    priority: "medium",
    reviewPolicy: null,
    assigneeAgentId: null,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    responsibleUserId: null,
    issueNumber: null,
    identifier: null,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: new Date("2026-08-21T00:00:00Z"),
    updatedAt: new Date("2026-08-21T00:00:00Z"),
    ...input,
  } as Issue;
}

describe("buildIssueQueueMessage", () => {
  it("builds a linked blocked-task list ordered by priority", () => {
    const message = buildIssueQueueMessage([
      issue({ id: "medium", identifier: "DEV-2", title: "Segundo", status: "blocked" }),
      issue({ id: "critical", identifier: "DEV-1", title: "Primeiro", status: "blocked", priority: "critical" }),
    ], "blocked", "https://paperclip.example/");

    expect(message.text).toBe("Tasks bloqueadas: 2");
    expect(message.blocks?.[0]).toMatchObject({
      type: "header",
      text: { text: "Tasks bloqueadas (2)" },
    });
    const list = JSON.stringify(message.blocks?.[1]);
    expect(list.indexOf("DEV-1")).toBeLessThan(list.indexOf("DEV-2"));
    expect(list).toContain("https://paperclip.example/issues/critical");
  });

  it("returns an empty review queue message", () => {
    const message = buildIssueQueueMessage([], "in_review", "https://paperclip.example");
    expect(message.text).toBe("Nenhuma task está pendente de revisão.");
  });

  it("escapes Slack control characters from issue titles", () => {
    const message = buildIssueQueueMessage([
      issue({ id: "unsafe", title: "<script> & <!channel> | teste", status: "in_review" }),
    ], "in_review", "https://paperclip.example");
    const rendered = JSON.stringify(message.blocks);
    expect(rendered).not.toContain("<!channel>");
    expect(rendered).toContain("&amp;");
    expect(rendered).toContain("¦");
  });
});
