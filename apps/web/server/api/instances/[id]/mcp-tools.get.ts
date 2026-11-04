import { tools } from '#nuxt-mcp-toolkit/tools.mjs'
import { isOptInTool } from '#shared/tool-optin'

/**
 * The tool catalogue the scope editor renders checkboxes from, for one
 * connection.
 *
 * Read from the toolkit's own registry rather than a hand-kept list, so the
 * options a user sees are exactly the tools that exist. A separate registry
 * would drift the first time someone adds a tool and forgets it.
 *
 * Instance-scoped rather than global: a connection only ever sees the tools of
 * its own kind, because the kind gate in `isToolAllowed` refuses the rest — so
 * offering a Postgres token a `send-text-message` checkbox would grant nothing
 * and invite a misunderstanding.
 *
 * **Which kinds a tool serves comes from `kindsForTool()`, not from `group`.**
 * The two were the same string only while every group was a kind, and the SQL
 * tools broke that: they sit in `tools/sql/` and serve every SQL kind. Reading
 * `group` here would have matched nothing and returned an empty catalogue —
 * which is not a cosmetic failure, because a scope picker offering no tools
 * mints a token that can call none. The registry in `mcp-kind-tool.ts` is
 * populated by the same call that sets the tool's `enabled` gate, so the picker
 * and the gate cannot disagree about which kinds a tool belongs to.
 *
 * It deliberately does NOT filter on a tool's runtime prerequisites. Both
 * WhatsApp read tools need `NUXT_EVOLUTION_DATABASE_URL`, and they stay
 * registered and fail loudly when it is missing rather than disappearing — see
 * plugins/evolution-db-check.ts. Hiding one of the two here would be the worst
 * of both: a scope editor that disagrees with the tool list a client sees.
 *
 * `readOnly` drives the default selection for a new Postgres token, so it has to
 * be right — it comes from the tool's own `readOnlyHint`.
 */
export default defineEventHandler(async (event) => {
  const { instance } = await requireReadableInstance(event, getRouterParam(event, 'id'))
  const kind = instanceKind(instance)

  const available = tools
    .filter(tool => typeof tool.name === 'string' && tool.name.length > 0)
    .filter(tool => toolServesKind(tool.name!, kind))

  return {
    tools: available
      .map(tool => ({
        name: tool.name!,
        title: tool.title || tool.name!,
        description: tool.description || '',
        readOnly: tool.annotations?.readOnlyHint === true,
        // Not part of "all actions"; the picker lists it apart, unticked.
        optIn: isOptInTool(tool.name!),
      }))
      .sort((a, b) => Number(b.readOnly) - Number(a.readOnly) || a.title.localeCompare(b.title)),
  }
})
