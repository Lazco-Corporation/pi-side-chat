import type { Api, Model } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionFactory,
  getAgentDir,
  type ModelRegistry,
  type SessionManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

/**
 * Builds the agent session of a side chat inside the pi process.
 *
 * The child reads the main session's live system prompt, so it follows the same instructions, and
 * it loads no extensions, skills, or context files of its own: those already shaped that prompt,
 * and their tools belong to the main session. The only extension is the side chat's own gate.
 */

/** The built-in tools of a side chat. */
export const BUILTIN_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;

/** Pi's own thinking levels, which `createAgentSession` accepts. */
export type ThinkingLevel = NonNullable<Parameters<typeof createAgentSession>[0]>["thinkingLevel"];

export interface ChildSessionInput {
  cwd: string;
  systemPrompt: string;
  sessionManager: SessionManager;
  model: Model<Api> | undefined;
  thinkingLevel: ThinkingLevel | undefined;
  modelRegistry: ModelRegistry;
  gate: ExtensionFactory;
  customTools: ToolDefinition[];
}

export async function createChildSession(input: ChildSessionInput): Promise<AgentSession> {
  const loader = new DefaultResourceLoader({
    cwd: input.cwd,
    agentDir: getAgentDir(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => input.systemPrompt,
    appendSystemPromptOverride: () => [],
    extensionFactories: [input.gate],
  });
  await loader.reload();
  // Since Pi 0.80.8 the session takes the model runtime, while an extension context exposes only the
  // registry. Passing the runtime behind the registry keeps the main session's providers and logins.
  const modelRuntime = (input.modelRegistry as unknown as { runtime?: unknown }).runtime;
  const { session } = await createAgentSession({
    cwd: input.cwd,
    sessionManager: input.sessionManager,
    resourceLoader: loader,
    ...(input.model ? { model: input.model } : {}),
    ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
    ...(modelRuntime !== undefined ? { modelRuntime } : {}),
    // An allowlist, not `noTools`: `noTools: "all"` also drops the custom tools.
    tools: [...BUILTIN_TOOL_NAMES, ...input.customTools.map((tool) => tool.name)],
    customTools: input.customTools,
  } as Parameters<typeof createAgentSession>[0]);
  return session;
}
