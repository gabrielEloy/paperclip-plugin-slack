export type ParsedSlashCommand = {
  command: string;
  text: string;
  responseUrl: string;
  userId: string;
  channelId: string;
  threadTs: string;
};

export function parseSlashCommand(rawBody: string): ParsedSlashCommand {
  const params = new URLSearchParams(rawBody);
  return {
    command: params.get("command") ?? "",
    text: params.get("text") ?? "",
    responseUrl: params.get("response_url") ?? "",
    userId: params.get("user_id") ?? "",
    channelId: params.get("channel_id") ?? "",
    threadTs: params.get("thread_ts") ?? "",
  };
}

export function encodeSlashCommandPayload(payload: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const key of [
    "command",
    "text",
    "response_url",
    "user_id",
    "channel_id",
    "thread_ts",
  ]) {
    const value = payload[key];
    if (typeof value === "string") params.set(key, value);
  }
  return params.toString();
}
