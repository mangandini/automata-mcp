<script setup lang="ts">
import { PlusIcon } from '@lucide/vue'
import { assertNever, connectionFamily } from '#shared/connection'

const props = withDefaults(defineProps<{
  instanceId: string
  kind: InstanceKind
  connected?: boolean
  /**
   * Whether this viewer administers the connection.
   *
   * An admin mints tokens, edits their scope, and sees every token on the
   * connection with who holds it. A member sees only their own and may revoke or
   * rotate them — destroying or replacing your own credential must never need
   * someone else's approval, and widening one must always be theirs.
   *
   * Presentation only: the server refuses each of these independently.
   */
  canManage?: boolean
}>(), { canManage: false })

const { user } = useSession()

/**
 * Asked as a family, not as `kind === 'postgres'`.
 *
 * This boolean decides whether the tool catalogue is fetched at all, and a new
 * database kind falling off the wrong side of it is not a cosmetic miss: the
 * catalogue never loads, `initialScope()` returns no tool names, and
 * `scopeSchema` then refuses Create with "Select at least one action" — a
 * validation error the user did nothing to cause.
 */
const isDatabase = computed(() => connectionFamily(props.kind) === 'database')

/**
 * A new token's starting scope depends on the kind.
 *
 * A WhatsApp token starts open, as it always has. A Postgres token starts
 * read-only — every read tool, no write tool — because the two mistakes do not
 * cost the same: a token that turns out to need writes is one edit away, and one
 * that turns out not to have needed them may already have made some.
 *
 * The read tools come from the server, since only it knows which exist.
 */
// Only a database token needs this, and only to seed its default scope — a
// WhatsApp dashboard was fetching it on every load and discarding the answer.
// The explicit key is shared with TokenScopeFields, which renders the same list:
// Nuxt keys per call site by default, so the two were fetching it twice.
const { data: toolCatalogue } = await useFetch<{ tools: McpToolInfo[] }>(
  () => `/api/instances/${props.instanceId}/mcp-tools`,
  { key: `mcp-tools-${props.instanceId}`, lazy: true, immediate: isDatabase.value },
)

function initialScope(): TokenScope {
  switch (props.kind) {
    case 'whatsapp':
    case 'telegram':
    // Every mail tool reads; there is nothing to hold back by default.
    case 'imap':
      return openScope()
    case 'postgres': {
      return readOnlyScope(toolCatalogue.value?.tools ?? [])
    }
    default:
      return assertNever(props.kind, 'connection kind')
  }
}

/**
 * Seed the default selection when the catalogue lands.
 *
 * Without this, opening the dialog before the fetch settles produced
 * `{ all_tools: false, tool_names: [] }` — which `scopeSchema` refuses with
 * "Select at least one action", so Create failed with a validation error the
 * user did nothing to cause.
 */
watch(toolCatalogue, (catalogue) => {
  if (!createOpen.value || !isDatabase.value || !catalogue) return
  if (newScope.value.all_tools || newScope.value.tool_names.length > 0) return
  newScope.value = initialScope()
})

interface TokenRow {
  id: string
  label: string
  created?: string
  last_used_at?: string
  expires_at?: string
  revoked: boolean
  expired: boolean
  /** The email is present only for an admin; a member's own list carries none. */
  assignedTo: { id: string, email?: string }
  scope: TokenScope
}

const { data, refresh, status } = await useFetch<{ tokens: TokenRow[] }>(
  () => `/api/instances/${props.instanceId}/tokens`,
)

const createOpen = ref(false)
const newLabel = ref('')
const newExpiry = ref<'30d' | '90d' | '1y' | 'never'>('90d')
const newScope = ref<TokenScope>(openScope())
const revealed = ref<string | null>(null)
const revealedScope = ref<TokenScope>(openScope())
/** Which token is mid-revoke, so only that row's button is disabled. */
const revoking = ref<string | null>(null)

const editing = ref<TokenRow | null>(null)
const editScope = ref<TokenScope>(openScope())

const { busy: creating, run: runCreate } = useApiAction()
const { busy: savingScope, run: runSaveScope } = useApiAction()
const { run: runRevoke } = useApiAction()
const { run: runRotate } = useApiAction()

/** Which token is mid-rotate, so only that row's button is disabled. */
const rotating = ref<string | null>(null)

/**
 * Who an admin may issue a token to.
 *
 * Fetched only for an admin, and only for the create dialog. The server refuses
 * a token for someone who cannot reach the connection — it would be born dead —
 * so the picker offers exactly the people who can.
 */
const { data: assignable, refresh: refreshAssignable } = await useFetch<{
  members: { userId: string, email: string, role: OrgRole, assigned: boolean, implicit: boolean }[]
}>(() => `/api/instances/${props.instanceId}/assignments`, { immediate: false })

const newAssignee = ref<string>('')

const assigneeOptions = computed(() =>
  (assignable.value?.members ?? []).filter(m => m.implicit || m.assigned),
)

const howTo = ref<TokenRow | null>(null)

/**
 * The how-to can only show a masked URL — the plaintext is gone after minting.
 * Hand off to the create flow, which is the one path that reveals a real one.
 */
function createFromHowTo() {
  howTo.value = null
  openCreate()
}

/**
 * Reset the form every time the dialog opens. Without this, a scope abandoned on
 * a previous open is what the next token is minted with.
 */
function openCreate() {
  newLabel.value = ''
  newExpiry.value = '90d'
  newScope.value = initialScope()
  newAssignee.value = user.value?.id ?? ''
  createOpen.value = true
  if (props.canManage) refreshAssignable()
}

function startEdit(token: TokenRow) {
  editing.value = token
  // Copied, not referenced — cancelling must not leave the table showing edits
  // that were never saved. Deep, and without naming the array fields: a fifth
  // scope axis would otherwise be shared by reference and silently editable.
  editScope.value = structuredClone(token.scope)
}

async function saveScope() {
  const token = editing.value
  if (!token) return

  await runSaveScope(
    async () => {
      await $fetch(`/api/tokens/${token.id}`, { method: 'PATCH', body: editScope.value })
      editing.value = null
      await refresh()
    },
    {
      success: 'Scope updated. The connector keeps working with its existing token.',
      // The server rejects an empty allowlist by name — "Select at least one
      // action" — which is the whole point of showing its message here.
      failure: 'Could not update the scope',
    },
  )
}

async function create() {
  const scope = newScope.value

  const result = await runCreate(
    () => $fetch<{ token: string }>(`/api/instances/${props.instanceId}/tokens`, {
      method: 'POST',
      body: {
        label: newLabel.value,
        expiry: newExpiry.value,
        assignedTo: newAssignee.value || undefined,
        ...scope,
      },
    }),
    { failure: 'Could not create the token' },
  )
  if (!result) return

  // The plaintext exists only in this response, so the reveal dialog is opened
  // from the value in hand rather than from a refetch.
  revealed.value = result.token
  revealedScope.value = scope
  createOpen.value = false
  newLabel.value = ''
  newScope.value = openScope()
  await refresh()
}

async function revoke(id: string) {
  revoking.value = id
  await runRevoke(
    async () => {
      await $fetch(`/api/tokens/${id}`, { method: 'DELETE' })
      await refresh()
    },
    {
      success: 'Token revoked',
      // A generic: this answers 404 for a token that is already gone, and
      // "Not found" is not a useful thing to show someone.
      failure: 'Could not revoke the token',
      preferServerMessage: false,
    },
  )
  revoking.value = null
}

/**
 * Replace a token's secret, keeping its scope.
 *
 * The one write a member may make to their own token: responding to a leak must
 * not queue behind an admin. The new plaintext is in the response and nowhere
 * else, so it goes straight into the reveal dialog rather than through a
 * refetch — the same rule as minting.
 */
async function rotate(token: TokenRow) {
  rotating.value = token.id
  const result = await runRotate(
    () => $fetch<{ token: string }>(`/api/tokens/${token.id}/rotate`, { method: 'POST' }),
    { failure: 'Could not issue a new secret' },
  )
  rotating.value = null
  if (!result) return

  revealed.value = result.token
  revealedScope.value = token.scope
  await refresh()
}

function formatDate(value?: string) {
  if (!value) return '—'
  return new Date(value).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

function statusOf(token: TokenRow) {
  if (token.revoked) return { label: 'Revoked', variant: 'outline' as const }
  if (token.expired) return { label: 'Expired', variant: 'outline' as const }
  return { label: 'Active', variant: 'default' as const }
}
</script>

<template>
  <section class="space-y-4">
    <div class="flex items-end justify-between gap-4">
      <div>
        <h2 class="font-heading text-lg font-semibold">
          Connector tokens
        </h2>
        <p class="text-sm text-muted-foreground">
          Each token gives Claude access to this {{ describeKind(kind) }} and no other.
        </p>
        <p v-if="connected === false" class="mt-1 text-sm text-muted-foreground">
          <template v-if="kind === 'postgres'">
            This database is not reachable, so tokens cannot read or write
            anything until it is. You can still revoke them.
          </template>
          <template v-else-if="kind === 'whatsapp'">
            This account is not connected, so tokens cannot send or read anything
            until you pair it again. You can still revoke them.
          </template>
          <template v-else-if="kind === 'telegram'">
            This account is not connected, so tokens cannot send or read anything
            until it is linked again. You can still revoke them.
          </template>
          <template v-else-if="kind === 'imap'">
            This mailbox is not syncing, so tokens see only what was synced
            before and cannot fetch bodies or attachments until it works again.
            You can still revoke them.
          </template>
        </p>
      </div>

      <!-- Minting is admin-only: what a token reaches is an organization
           decision, and a member who could mint could grant themselves any scope
           the connection has. -->
      <Button v-if="canManage" size="sm" @click="openCreate()">
        <PlusIcon class="size-4" />
        New token
      </Button>
    </div>

    <Card>
      <CardContent class="p-0">
        <div v-if="status === 'pending'" class="space-y-2 p-6">
          <Skeleton class="h-5 w-full" />
          <Skeleton class="h-5 w-2/3" />
        </div>

        <p v-else-if="!data?.tokens?.length" class="p-6 text-sm text-muted-foreground">
          <template v-if="canManage">
            No tokens yet. Create one, then paste its URL into Claude as a custom connector.
          </template>
          <template v-else>
            You have no connector tokens for this connection yet. An admin of your
            organization can issue you one.
          </template>
        </p>

        <Table v-else>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Last used</TableHead>
              <TableHead>Expires</TableHead>
              <TableHead>Scope</TableHead>
              <TableHead>Status</TableHead>
              <TableHead class="w-0" />
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="token in data.tokens" :key="token.id">
              <TableCell class="font-medium">
                {{ token.label }}
                <!-- Whose it is, for an admin looking at the whole
                     organization's tokens. Under the name rather than in its own
                     column: a seventh column pushes the row actions off the
                     edge at ordinary widths. -->
                <div v-if="canManage" class="text-xs font-normal text-muted-foreground">
                  {{ token.assignedTo.id === user?.id ? 'You' : (token.assignedTo.email || 'Unknown holder') }}
                </div>
              </TableCell>
              <TableCell class="text-muted-foreground">
                {{ formatDate(token.created) }}
              </TableCell>
              <TableCell class="text-muted-foreground">
                {{ token.last_used_at ? formatDate(token.last_used_at) : 'Never' }}
              </TableCell>
              <TableCell class="text-muted-foreground">
                {{ token.expires_at ? formatDate(token.expires_at) : 'Never' }}
              </TableCell>
              <TableCell>
                <span class="text-sm text-muted-foreground">{{ describeScope(token.scope, kind) }}</span>
              </TableCell>
              <TableCell>
                <Badge :variant="statusOf(token).variant">
                  {{ statusOf(token).label }}
                </Badge>
              </TableCell>
              <TableCell class="whitespace-nowrap">
                <Button
                  v-if="!token.revoked"
                  variant="ghost"
                  size="sm"
                  @click="howTo = token"
                >
                  How to
                </Button>
                <!-- Scope is admin-only. A member may replace the secret, never
                     widen what it reaches. -->
                <Button
                  v-if="canManage && !token.revoked"
                  variant="ghost"
                  size="sm"
                  @click="startEdit(token)"
                >
                  Edit
                </Button>
                <AlertDialog v-if="!token.revoked && !token.expired">
                  <AlertDialogTrigger as-child>
                    <Button variant="ghost" size="sm" :disabled="rotating === token.id">
                      New secret
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Issue a new secret for “{{ token.label }}”?</AlertDialogTitle>
                      <AlertDialogDescription>
                        The current one stops working immediately and every Claude
                        connector using it has to be updated. What the token can
                        reach does not change. Use this if the token may have
                        leaked.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction @click="rotate(token)">
                        Issue a new secret
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
                <AlertDialog v-if="!token.revoked">
                  <AlertDialogTrigger as-child>
                    <Button variant="ghost" size="sm" :disabled="revoking === token.id">
                      Revoke
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Revoke “{{ token.label }}”?</AlertDialogTitle>
                      <AlertDialogDescription>
                        Any Claude connector using this token stops working immediately.
                        This cannot be undone — you would need to create a new token.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction @click="revoke(token.id)">
                        Revoke
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </CardContent>
    </Card>

    <Dialog v-model:open="createOpen">
      <DialogContent class="flex max-h-[90vh] flex-col overflow-hidden sm:max-w-2xl md:max-w-5xl">
        <DialogHeader class="shrink-0">
          <DialogTitle>New connector token</DialogTitle>
          <DialogDescription>
            Name it after where you will use it, so you know which to revoke later.
          </DialogDescription>
        </DialogHeader>

        <!--
          The body takes the height left between header and footer, and the
          scope list inside it absorbs the slack — so the dialog itself does
          not scroll. overflow-y-auto here only bites on a very short viewport.
        -->
        <div class="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto">
          <div class="shrink-0 space-y-2">
            <Label for="token-label">Name</Label>
            <Input id="token-label" v-model="newLabel" placeholder="Claude desktop" />
          </div>

          <!--
            Only people who already reach this connection are offered: the
            server refuses a token for anyone else, because it would authenticate
            as nobody and answer 401 on every call while still rendering as
            "Active". Assigning the connection is a separate, deliberate act —
            see AssignConnectionDialog.
          -->
          <div v-if="assigneeOptions.length > 1" class="shrink-0 space-y-2">
            <Label for="token-assignee">Issue to</Label>
            <Select v-model="newAssignee">
              <SelectTrigger id="token-assignee">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem
                  v-for="member in assigneeOptions"
                  :key="member.userId"
                  :value="member.userId"
                >
                  {{ member.email }}{{ member.userId === user?.id ? ' (you)' : '' }}
                </SelectItem>
              </SelectContent>
            </Select>
            <p class="text-xs text-muted-foreground">
              They can revoke it or issue themselves a new secret for it, but not
              change what it reaches.
            </p>
          </div>

          <div class="shrink-0 space-y-2">
            <Label for="token-expiry">Expires</Label>
            <Select v-model="newExpiry">
              <SelectTrigger id="token-expiry">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="30d">
                  In 30 days
                </SelectItem>
                <SelectItem value="90d">
                  In 90 days
                </SelectItem>
                <SelectItem value="1y">
                  In 1 year
                </SelectItem>
                <SelectItem value="never">
                  Never
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <Separator class="shrink-0" />

          <TokenScopeFields v-model="newScope" :instance-id="instanceId" :kind="kind" />
        </div>

        <DialogFooter class="shrink-0">
          <Button variant="ghost" @click="createOpen = false">
            Cancel
          </Button>
          <Button :disabled="creating" @click="create">
            {{ creating ? 'Creating…' : 'Create token' }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog :open="Boolean(editing)" @update:open="value => { if (!value) editing = null }">
      <DialogContent class="flex max-h-[90vh] flex-col overflow-hidden sm:max-w-2xl md:max-w-5xl">
        <DialogHeader class="shrink-0">
          <DialogTitle>Edit “{{ editing?.label }}”</DialogTitle>
          <DialogDescription>
            Changes apply from the next request. The connector already set up in
            Claude keeps working — the token itself does not change.
          </DialogDescription>
        </DialogHeader>

        <div class="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
          <TokenScopeFields v-model="editScope" :instance-id="instanceId" :kind="kind" />
        </div>

        <DialogFooter class="shrink-0">
          <Button variant="ghost" @click="editing = null">
            Cancel
          </Button>
          <Button :disabled="savingScope" @click="saveScope">
            {{ savingScope ? 'Saving…' : 'Save scope' }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <HowToConnectDialog
      :open="Boolean(howTo)"
      :kind="kind"
      :label="howTo?.label"
      :scope="howTo?.scope"
      @update:open="value => { if (!value) howTo = null }"
      @create="createFromHowTo"
    />

    <RevealTokenDialog :token="revealed" :kind="kind" :scope="revealedScope" @close="revealed = null" />
  </section>
</template>
