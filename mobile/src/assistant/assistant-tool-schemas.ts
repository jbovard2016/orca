// JSON schemas for the five voice tools, sent to the Realtime session in
// session.update. Kept apart from the executor so each file stays small.

export type ToolDefinition = {
  type: 'function'
  name: string
  description: string
  parameters: Record<string, unknown>
}

export const ASSISTANT_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    name: 'list_agents',
    description:
      'List every Orca worktree that has a coding agent, with agent type and state (working, blocked, waiting, done) and the last assistant message when known.',
    parameters: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    type: 'function',
    name: 'read_agent',
    description:
      "Read what an agent's terminal currently shows. mode=screen (default) reads the visible screen; mode=history pages back through earlier output using the cursor from a previous call.",
    parameters: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'Worktree name, repo, or branch as the user said it'
        },
        terminal: { type: 'string', description: 'Terminal title, only if the user named one' },
        mode: { type: 'string', enum: ['screen', 'history'] },
        cursor: { type: 'string', description: 'oldestCursor from a previous history read' }
      },
      required: ['target'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'send_agent',
    description:
      'Prepare to type text into an agent terminal and press Enter. This only stages the action and returns the read-back text; the app asks the user for a spoken yes before anything is sent.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string' },
        terminal: { type: 'string' },
        text: {
          type: 'string',
          description: 'Exact text to send, e.g. "run the tests" or "/model fable"'
        },
        enter: { type: 'boolean', description: 'Press Enter after the text. Default true.' }
      },
      required: ['target', 'text'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'activate_agent',
    description:
      'Prepare to switch the desktop to a worktree and focus its agent terminal. Staged until the user confirms.',
    parameters: {
      type: 'object',
      properties: { target: { type: 'string' }, terminal: { type: 'string' } },
      required: ['target'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'create_agent',
    description:
      'Prepare to create a new worktree with a coding agent in its first terminal. Never choose repo, base branch, agent or prompt yourself; ask the user for anything missing. Staged until the user confirms.',
    parameters: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository name as the user said it' },
        name: { type: 'string', description: 'Worktree / branch name' },
        baseBranch: { type: 'string' },
        agent: { type: 'string', enum: ['claude', 'codex', 'gemini', 'omp', 'pi', 'grok'] },
        prompt: { type: 'string', description: 'First instruction for the agent' }
      },
      required: ['repo', 'name', 'agent', 'prompt'],
      additionalProperties: false
    }
  }
]
