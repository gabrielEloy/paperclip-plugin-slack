export const CREATE_TASK_SHORTCUT_CALLBACK_ID = "paperclip_create_task";
export const CREATE_TASK_MODAL_CALLBACK_ID = "paperclip_create_task_modal";

export type TaskFormOption = {
  id: string;
  label: string;
};

export type CreateTaskInput = {
  title: string;
  description: string;
  priority: "critical" | "high" | "medium" | "low";
  assigneeAgentId?: string;
  projectId?: string;
};

type SlackViewState = {
  values?: Record<string, Record<string, {
    value?: string;
    selected_option?: { value?: string };
  }>>;
};

function option(label: string, value: string): Record<string, unknown> {
  return {
    text: { type: "plain_text", text: label.slice(0, 75), emoji: true },
    value,
  };
}

export function buildCreateTaskModal(input: {
  agents?: TaskFormOption[];
  projects?: TaskFormOption[];
} = {}): Record<string, unknown> {
  const blocks: Array<Record<string, unknown>> = [
    {
      type: "input",
      block_id: "task_title",
      label: { type: "plain_text", text: "Título" },
      element: {
        type: "plain_text_input",
        action_id: "value",
        placeholder: { type: "plain_text", text: "O que precisa ser feito?" },
        min_length: 1,
        max_length: 150,
      },
    },
    {
      type: "input",
      block_id: "task_description",
      optional: true,
      label: { type: "plain_text", text: "Descrição" },
      element: {
        type: "plain_text_input",
        action_id: "value",
        multiline: true,
        placeholder: { type: "plain_text", text: "Contexto, resultado esperado e critérios de aceite" },
        max_length: 3000,
      },
    },
    {
      type: "input",
      block_id: "task_priority",
      label: { type: "plain_text", text: "Prioridade" },
      element: {
        type: "static_select",
        action_id: "value",
        initial_option: option("Média", "medium"),
        options: [
          option("Crítica", "critical"),
          option("Alta", "high"),
          option("Média", "medium"),
          option("Baixa", "low"),
        ],
      },
    },
  ];

  const agents = (input.agents ?? []).slice(0, 100);
  if (agents.length > 0) {
    blocks.push({
      type: "input",
      block_id: "task_assignee",
      optional: true,
      label: { type: "plain_text", text: "Agente responsável" },
      element: {
        type: "static_select",
        action_id: "value",
        placeholder: { type: "plain_text", text: "Selecionar agente" },
        options: agents.map((agent) => option(agent.label, agent.id)),
      },
    });
  }

  const projects = (input.projects ?? []).slice(0, 100);
  if (projects.length > 0) {
    blocks.push({
      type: "input",
      block_id: "task_project",
      optional: true,
      label: { type: "plain_text", text: "Projeto" },
      element: {
        type: "static_select",
        action_id: "value",
        placeholder: { type: "plain_text", text: "Selecionar projeto" },
        options: projects.map((project) => option(project.label, project.id)),
      },
    });
  }

  return {
    type: "modal",
    callback_id: CREATE_TASK_MODAL_CALLBACK_ID,
    title: { type: "plain_text", text: "Criar task" },
    submit: { type: "plain_text", text: "Criar" },
    close: { type: "plain_text", text: "Cancelar" },
    notify_on_close: false,
    blocks,
  };
}

function field(
  state: SlackViewState,
  blockId: string,
): { value?: string; selected_option?: { value?: string } } | undefined {
  return state.values?.[blockId]?.value;
}

export function parseCreateTaskSubmission(state: SlackViewState): CreateTaskInput {
  const title = String(field(state, "task_title")?.value ?? "").trim();
  if (!title) throw new Error("Task title is required");

  const rawPriority = String(
    field(state, "task_priority")?.selected_option?.value ?? "medium",
  );
  const priority = ["critical", "high", "medium", "low"].includes(rawPriority)
    ? rawPriority as CreateTaskInput["priority"]
    : "medium";

  const assigneeAgentId = field(state, "task_assignee")?.selected_option?.value;
  const projectId = field(state, "task_project")?.selected_option?.value;

  return {
    title,
    description: String(field(state, "task_description")?.value ?? "").trim(),
    priority,
    ...(assigneeAgentId ? { assigneeAgentId } : {}),
    ...(projectId ? { projectId } : {}),
  };
}
