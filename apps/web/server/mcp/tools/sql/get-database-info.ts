import { toolGranted } from '#shared/tool-optin'

/**
 * Read tool, and the parity of `get-connection-status`: something cheap for a
 * model to call before it starts guessing. Takes no arguments, because the token
 * is bound to one connection.
 */
export default defineKindTool({
  name: 'get-database-info',
  kind: ['postgres'],
  group: 'sql',
  title: 'Check the database connection',
  description:
    'Report whether this connector can reach its database, which server version '
    + 'and database it is, which role it connects as, and what this token is '
    + 'scoped to. Call this first when a query fails in a way that might be the '
    + 'connection rather than the SQL. `tablesInScope` lists the tables this token '
    + 'may reach when it is scoped to an allowlist; when it is not, every table '
    + 'the role can read is reachable and list-tables is the way to see them.',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: {},
  handler: async () => {
    const { instance, scope } = useMcpAuth()

    const identity = await sqlIdentity(instance)

    return {
      connected: true,
      // Carries the engine's own name, because this tool serves more than one
      // and writing "PostgreSQL" here would be a lie on any other connection.
      serverVersion: identity?.server ?? 'unknown',
      database: identity?.database ?? instance.db_database ?? 'unknown',
      role: identity?.currentUser ?? 'unknown',
      host: instance.db_host,
      port: instance.db_port,
      allTables: scope.allTables,
      ...(!scope.allTables && { tablesInScope: scope.tableNames }),
      canWrite: toolGranted(scope, 'run-statement'),
    }
  },
})
