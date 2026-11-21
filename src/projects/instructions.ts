import type { ToolSandboxSession } from '../tools/types.ts';

/** Read the root instructions through the same boundary as the Agent's files. */
export async function projectInstructions(session: ToolSandboxSession | null): Promise<string> {
  if (!session?.workspace.readBytes) return '';
  try {
    const bytes = await session.workspace.readBytes('AGENTS.md', 16 * 1024);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim();
    return text ? '当前项目 AGENTS.md（仅在现有工具权限范围内适用）：\n' + text : '';
  } catch {
    return '';
  }
}
