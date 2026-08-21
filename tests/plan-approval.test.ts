import { describe, expect, it } from "vitest";
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
} from "../src/plan-approval.js";
import manifest from "../src/manifest.js";

const issue = {
  id: "issue-1",
  identifier: "CONAAAA-10",
  title: "Detecção de entrega",
};

const interaction: PlanApprovalInteraction = {
  id: "interaction-1",
  issueId: issue.id,
  kind: "request_confirmation",
  status: "pending",
  title: "Aprovar escopo da V1",
  payload: {
    prompt: "Você aprova este fluxo?",
    acceptLabel: "Aprovar fluxo",
    rejectLabel: "Solicitar alterações",
    rejectRequiresReason: true,
    detailsMarkdown: "Revise o documento Plan antes de decidir.",
    target: { type: "issue_document", key: "plan" },
  },
};

describe("Slack Plan approval", () => {
  it("declares the managed polling job", () => {
    expect(manifest.jobs?.find((job) => job.jobKey === "check-pending-plan-approvals"))
      .toMatchObject({ schedule: "*/1 * * * *" });
  });

  it("recognizes only Plan document confirmations", () => {
    expect(isPlanApprovalInteraction(interaction)).toBe(true);
    expect(isPlanApprovalInteraction({
      ...interaction,
      payload: { ...interaction.payload, target: { type: "custom", key: "plan" } },
    })).toBe(false);
    expect(isPlanApprovalInteraction({ ...interaction, kind: "ask_user_questions" })).toBe(false);
  });

  it("renders approve and request-changes actions in the issue thread card", () => {
    const message = buildPlanApprovalMessage(issue, interaction, "https://paperclip.example.com");
    const actions = (message.blocks as Array<Record<string, unknown>>)
      .find((block) => block.type === "actions") as { elements: Array<Record<string, unknown>> };

    expect(message.text).toContain("CONAAAA-10");
    expect(actions.elements[0]).toMatchObject({
      action_id: PLAN_APPROVE_ACTION_ID,
      style: "primary",
    });
    expect(actions.elements[1]).toMatchObject({ action_id: PLAN_REJECT_ACTION_ID });
    expect(decodePlanApprovalActionRef(String(actions.elements[0].value))).toEqual({
      issueId: issue.id,
      interactionId: interaction.id,
    });
  });

  it("requires a reason in the request-changes modal and preserves message coordinates", () => {
    const ref = {
      issueId: issue.id,
      interactionId: interaction.id,
      channelId: "D123",
      messageTs: "123.456",
    };
    const modal = buildPlanRejectionModal(ref);

    expect(modal.callback_id).toBe(PLAN_REJECT_MODAL_CALLBACK_ID);
    expect(parsePlanRejectionSubmission({
      privateMetadata: String(modal.private_metadata),
      state: {
        values: {
          plan_rejection_reason: { value: { value: "  Ajustar o prazo  " } },
        },
      },
    })).toEqual({ ...ref, reason: "Ajustar o prazo" });
    expect(() => parsePlanRejectionSubmission({
      privateMetadata: String(modal.private_metadata),
      state: { values: { plan_rejection_reason: { value: { value: " " } } } },
    })).toThrow("Invalid plan rejection submission");
  });

  it("removes decision buttons after the interaction is resolved", () => {
    const message = buildResolvedPlanApprovalMessage(issue, {
      ...interaction,
      status: "rejected",
      result: { outcome: "rejected", reason: "Rever sequência operacional" },
    }, "https://paperclip.example.com", "U123");

    expect(message.text).toContain("Alterações solicitadas");
    expect(JSON.stringify(message.blocks)).toContain("Rever sequência operacional");
    expect((message.blocks as Array<Record<string, unknown>>).some((block) => block.type === "actions")).toBe(false);
  });
});
