import { z } from 'zod'
import type { ZodRawShape } from 'zod'
import { isOptInTool } from '#shared/tool-optin'
import type { InstanceKind } from './mcp-scope'

/**
 * The toolkit's tool definition, taken from `defineMcpTool` itself rather than
 * imported: the type lives at a deep path that is not in the package's
 * `exports` map, and naming that path here would be a second fragile dependency
 * on the toolkit's internal layout (see `modules/mcp-token-route.ts`).
 */
type ToolDefinition<I extends ZodRawShape | undefined, O extends ZodRawShape>
  = Parameters<typeof defineMcpTool<I, O>>[0]

/**
 * Which connection kinds each tool serves, by tool name.
 *
 * **This registry is the answer to a question the toolkit cannot answer for
 * us.** A tool's `group` used to double as "which kind this belongs to", which
 * worked only while the two were the same string. They are not any more: the
 * SQL tools sit in `tools/sql/` and serve every SQL kind, so `group` is `'sql'`
 * and names no kind at all.
 *
 * `api/instances/[id]/mcp-tools.get.ts` needs the mapping to render the scope
 * picker, and reading it off the toolkit's own definition meant an untyped cast
 * through `group ?? _meta.group` — which did not typecheck, and which would
 * have silently returned an empty catalogue the moment `group` stopped being a
 * kind. A picker that offers no tools mints a token that can call nothing.
 *
 * Populated as each tool module evaluates. Every tool module is imported by the
 * toolkit's generated `tools.mjs`, and the route imports that, so by the time
 * any request is served every `defineKindTool` call has run.
 */
const TOOL_KINDS = new Map<string, readonly InstanceKind[]>()

/** The kinds a tool serves, or `undefined` for a tool this build does not know. */
export function kindsForTool(name: string): readonly InstanceKind[] | undefined {
  return TOOL_KINDS.get(name)
}

/** Whether a tool exists for a connection of this kind. */
export function toolServesKind(name: string, kind: InstanceKind): boolean {
  return TOOL_KINDS.get(name)?.includes(kind) ?? false
}

/**
 * Define an MCP tool that belongs to one or more kinds of connection.
 *
 * **Why this exists rather than three separate declarations.** A tool's kind was
 * being asserted three times per file — by the directory it sits in, by an
 * explicit `group`, and by the third argument to `isToolAllowed` — kept in step
 * by a comment. Only the third one enforces anything, and forgetting it is not a
 * cosmetic slip: a Postgres token minted with `all_tools` would register
 * `send-text-message`, whose handler calls `useEvolutionClient()` on a row that
 * has no Evolution credentials. Declaring the kind once makes the mismatch
 * unrepresentable.
 *
 * **`kinds` (plural) is for a tool whose meaning is genuinely identical across
 * engines**, which today means the SQL tools: `run-query` takes the same
 * argument and promises the same thing whether the connection is Postgres or
 * another SQL engine, and the differences live behind `sql-engine.ts` and in the
 * per-kind `instructions`. It is *not* the way to share a tool whose arguments
 * differ — that is why Telegram has `read-telegram-messages` rather than a
 * two-kind `read-messages`, and that reasoning still stands.
 *
 * Basenames must stay unique across groups regardless: the loader warns on a
 * collision and `McpServer.registerTool` throws on a duplicate registered name.
 * A single shared file satisfies that rule rather than straining it.
 *
 * `available` is the second half of the old `enabled` expression, kept for the
 * one tool that has a prerequisite beyond its kind. It takes no event because a
 * prerequisite is a property of the deployment, not of the caller.
 */
export function defineKindTool<
  const InputSchema extends ZodRawShape | undefined = ZodRawShape,
  const OutputSchema extends ZodRawShape = ZodRawShape,
>(
  definition: ToolDefinition<InputSchema, OutputSchema> & {
    name: string
    /** One kind, or several for a tool that means the same thing on each. */
    kind: InstanceKind | readonly [InstanceKind, ...InstanceKind[]]
    /**
     * The directory this tool sits in, when that is not simply its kind.
     * Required for a multi-kind tool, since there is no single kind to infer it
     * from; stated so a move cannot silently change what the listing reports.
     */
    group?: string
    available?: () => boolean
    /**
     * The tool reaches further than reading what the token already reads, so
     * "all actions" does not include it: a token has it only when its name is
     * ticked. Must agree with `OPT_IN_TOOLS` in `shared/tool-optin.ts`, which is
     * what scope writing consults without loading any tool module; a mismatch
     * throws when the tool is defined. A tool that omits the flag is not opt-in,
     * so every existing tool keeps loading.
     */
    optIn?: boolean
    /**
     * Refuse arguments the schema does not name.
     *
     * A plain shape is stripped silently by zod, so a caller who misspells or
     * invents an argument (`window`, `fromDate`) gets an answer to a question it
     * did not ask — a search that "ignored" the date it was given reads as a
     * result over that date. With this on, the MCP SDK answers an `isError`
     * result whose text names the key (`Unrecognized key: "window"`), and
     * `tools/list` advertises `additionalProperties: false`.
     */
    strictInput?: boolean
  },
): ToolDefinition<InputSchema, OutputSchema> {
  const { kind, group, available, strictInput, optIn, ...rest } = definition

  if ((optIn ?? false) !== isOptInTool(rest.name)) {
    throw new Error(
      `Tool "${rest.name}": optIn is ${optIn ?? false} but OPT_IN_TOOLS (shared/tool-optin.ts) says ${isOptInTool(rest.name)}; the two must agree.`,
    )
  }
  const kinds: readonly InstanceKind[] = Array.isArray(kind) ? kind : [kind as InstanceKind]

  TOOL_KINDS.set(rest.name, kinds)

  return defineMcpTool<InputSchema, OutputSchema>({
    ...rest,
    // The toolkit types `inputSchema` as a raw shape, but hands it to the MCP
    // SDK's `registerTool`, which uses an already-built zod object as it is
    // (verified against SDK 1.30 / zod 4). Passing the strict object through
    // that type is therefore sound; the cast is only the type system's view.
    ...(strictInput && rest.inputSchema && {
      inputSchema: z.strictObject(rest.inputSchema as ZodRawShape) as unknown as InputSchema,
    }),
    // Inferred from the directory too; stated so a move cannot silently change
    // which connections the tool belongs to. For a single-kind tool the group
    // *is* the kind, which is what every existing tool relies on.
    group: group ?? (kinds.length === 1 ? kinds[0]! : undefined),
    // Two gates, both fail closed — see `isToolAllowed`. `some` rather than a
    // single check because a multi-kind tool is allowed when the caller's kind
    // is any of its kinds; `isToolAllowed` still compares against the resolved
    // `auth.kind`, so exactly one of these can ever be true for a given request.
    // Kept synchronous: the toolkit evaluates `enabled` twice per request per
    // tool.
    enabled: event =>
      kinds.some(k => isToolAllowed(event, rest.name, k)) && (available?.() ?? true),
  })
}
