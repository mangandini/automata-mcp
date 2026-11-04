/**
 * Tools a token gets only when someone ticks them by name.
 *
 * "All actions" has always meant every tool the connection has, which is the
 * right reading for a tool that reads what the token could already read. It is
 * the wrong one for a tool that reaches further — `get-message-media` downloads
 * attachments and mints download links — because every token minted before the
 * tool existed would gain it the day it shipped, and every "all actions" token
 * minted since would hold it without anyone having decided so. An opt-in tool is
 * therefore granted only when its own name is in `tool_names`, whatever
 * `all_tools` says.
 *
 * **A static list, not a registry filled in as tool modules load.** Scope is
 * written (`scopeFields()`, `scopeFromInput()`) from routes that do not import
 * any tool module, so a registry populated by `defineKindTool` would answer
 * differently depending on what had been evaluated. `defineKindTool` instead
 * asserts that its `optIn` flag agrees with this list at definition time, so the
 * two cannot drift.
 *
 * Plain TypeScript with no imports, so the server, the app and a bare `node`
 * check script can all load it.
 */
export const OPT_IN_TOOLS: readonly string[] = ['get-message-media']

export function isOptInTool(name: string): boolean {
  return OPT_IN_TOOLS.includes(name)
}

/**
 * Whether a token's scope reaches a tool, as far as the tool allowlist goes.
 * Synchronous: it runs inside `enabled`, which the toolkit evaluates twice per
 * request per tool.
 */
export function toolGranted(
  scope: { allTools: boolean, toolNames: readonly string[] },
  toolName: string,
): boolean {
  if (scope.allTools && !isOptInTool(toolName)) return true
  return scope.toolNames.includes(toolName)
}

/**
 * The names an "all actions" token still has to store: only the opt-in ones,
 * once each. Everything else is implied by `all_tools` and stays out of the
 * column, exactly as before.
 */
export function keepOptInNames(names: readonly string[]): string[] {
  return [...new Set(names.filter(isOptInTool))]
}
