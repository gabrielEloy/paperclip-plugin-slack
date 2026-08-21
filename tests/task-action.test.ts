import { describe, expect, it } from "vitest";
import {
  CREATE_TASK_MODAL_CALLBACK_ID,
  buildCreateTaskModal,
  parseCreateTaskSubmission,
} from "../src/task-action.js";

describe("Slack create task action", () => {
  it("builds a managed modal with optional Paperclip selectors", () => {
    const modal = buildCreateTaskModal({
      agents: [{ id: "agent-1", label: "Product Manager" }],
      projects: [{ id: "project-1", label: "Paperclip" }],
    });

    expect(modal.callback_id).toBe(CREATE_TASK_MODAL_CALLBACK_ID);
    expect(modal.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ block_id: "task_title" }),
      expect.objectContaining({ block_id: "task_assignee" }),
      expect.objectContaining({ block_id: "task_project" }),
    ]));
  });

  it("omits empty optional selectors", () => {
    const modal = buildCreateTaskModal();
    const blockIds = (modal.blocks as Array<{ block_id: string }>).map((block) => block.block_id);
    expect(blockIds).not.toContain("task_assignee");
    expect(blockIds).not.toContain("task_project");
  });

  it("parses the submitted task fields", () => {
    const input = parseCreateTaskSubmission({
      values: {
        task_title: { value: { value: "  Corrigir login  " } },
        task_description: { value: { value: "  Reproduzir e validar  " } },
        task_priority: { value: { selected_option: { value: "high" } } },
        task_assignee: { value: { selected_option: { value: "agent-1" } } },
        task_project: { value: { selected_option: { value: "project-1" } } },
      },
    });

    expect(input).toEqual({
      title: "Corrigir login",
      description: "Reproduzir e validar",
      priority: "high",
      assigneeAgentId: "agent-1",
      projectId: "project-1",
    });
  });

  it("uses medium priority for an unknown value", () => {
    const input = parseCreateTaskSubmission({
      values: {
        task_title: { value: { value: "Task" } },
        task_priority: { value: { selected_option: { value: "urgent" } } },
      },
    });
    expect(input.priority).toBe("medium");
  });

  it("rejects an empty title", () => {
    expect(() => parseCreateTaskSubmission({
      values: { task_title: { value: { value: "  " } } },
    })).toThrow("Task title is required");
  });
});
