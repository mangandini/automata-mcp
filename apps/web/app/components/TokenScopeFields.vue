<script setup lang="ts">
import { FolderIcon, PlusIcon, SearchIcon, UsersIcon, XIcon } from '@lucide/vue'
import { assertNever, connectionFamily } from '#shared/connection'

/**
 * The scope editor, shared by the create and edit dialogs so the two cannot
 * drift into disagreeing about what a scope is.
 */
const props = defineProps<{ instanceId: string, kind: InstanceKind }>()
const scope = defineModel<TokenScope>({ required: true })

/**
 * Which axis this connection has, asked as a family rather than as
 * `kind === 'postgres'`.
 *
 * A kind check here is a boolean a new database kind falls off the wrong side
 * of: it would read as "not a database", fetch `/chats` (404), and render the
 * chat axis for something that has no chats. `connectionFamily` fails to
 * compile until the new kind has been placed, which is the whole point.
 */
const isDatabase = computed(() => connectionFamily(props.kind) === 'database')

/**
 * The chat axis's words. A mailbox scopes by folder on the same axis — its
 * token stores folder paths in `chat_jids` — so the section is shared and only
 * the vocabulary changes. A switch so a new messaging kind has to say what its
 * conversations are called rather than inheriting WhatsApp's.
 */
const chatAxis = computed(() => {
  switch (props.kind) {
    case 'whatsapp':
    case 'telegram':
    // A database never renders this section (it has the table axis instead).
    case 'postgres':
      return { title: 'Chats', blurb: 'Which conversations this token can read and reply in.', all: 'All chats', some: 'Only selected chats', search: 'Search conversations', addable: true }
    case 'imap':
      return { title: 'Folders', blurb: 'Which folders this token can list, search and read emails in.', all: 'All folders', some: 'Only selected folders', search: 'Search folders', addable: false }
    default:
      return assertNever(props.kind, 'connection kind')
  }
})

// Deliberately not awaited. A top-level await makes setup() async, and Vue then
// withholds the entire component until every fetch settles — so the chats call,
// which can spend eight seconds inside Evolution's group lookup, would keep the
// Actions section (whose data is in-process and instant) off the screen with it.
// The dialog mounts on click, so that stall reads as a click that did nothing.
const { data: toolData, status: toolStatus } = useFetch<{ tools: McpToolInfo[] }>(
  () => `/api/instances/${props.instanceId}/mcp-tools`,
  { key: `mcp-tools-${props.instanceId}`, lazy: true },
)
// Only the axis this kind actually has is fetched. `immediate: false` on the
// other one matters: asking a WhatsApp connection for its tables answers 404,
// and a 404 in the console on every open reads as a bug.
const { data: chatData, status: chatStatus } = useFetch<{ chats: ScopedChat[] }>(
  () => `/api/instances/${props.instanceId}/chats`,
  { lazy: true, immediate: !isDatabase.value },
)
const { data: tableData, status: tableStatus } = useFetch<{ tables: ScopedTable[], hasMore: boolean }>(
  () => `/api/instances/${props.instanceId}/tables`,
  { lazy: true, immediate: isDatabase.value, query: { limit: 500 } },
)

// Chats picked by JID may not be in the fetched list — a number added by hand,
// or one whose conversation has since aged out. Keep our own record of them so
// the selection can always be rendered with a name.
const extraChats = ref<ScopedChat[]>([])
const search = ref('')
const tableSearch = ref('')
const manualNumber = ref('')
const resolving = ref(false)
const manualError = ref('')

// 'idle' counts as loading: it is what status reads for the tick before the
// request is dispatched, and treating it as settled flashes the empty state.
const loading = (status: Ref<string>) => computed(() => status.value === 'idle' || status.value === 'pending')
const toolsLoading = loading(toolStatus)

/**
 * Opt-in tools are listed apart from the actions: "All actions" does not include
 * them, so a checkbox inside the "Only selected" list — which is hidden under
 * "All actions" — would read as part of that choice. Apart, and visible in both
 * modes, it reads as what it is: something to switch on deliberately.
 */
const actionTools = computed(() => (toolData.value?.tools ?? []).filter(t => !t.optIn))
const extraTools = computed(() => (toolData.value?.tools ?? []).filter(t => t.optIn))
const chatsLoading = loading(chatStatus)
const tablesLoading = loading(tableStatus)

const visibleTables = computed(() => {
  const rows = tableData.value?.tables ?? []
  const q = tableSearch.value.trim().toLowerCase()
  if (!q) return rows
  return rows.filter(t => t.qname.toLowerCase().includes(q))
})

const knownChats = computed<ScopedChat[]>(() => {
  const seen = new Map<string, ScopedChat>()
  for (const chat of [...(chatData.value?.chats ?? []), ...extraChats.value]) {
    if (!seen.has(chat.jid)) seen.set(chat.jid, chat)
  }
  return [...seen.values()]
})

const visibleChats = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return knownChats.value
  return knownChats.value.filter(c =>
    c.name.toLowerCase().includes(q) || c.jid.toLowerCase().includes(q),
  )
})

const selectedChats = computed(() =>
  scope.value.chat_jids.map(jid =>
    knownChats.value.find(c => c.jid === jid) ?? { jid, name: jid.split('@')[0]! },
  ),
)

/**
 * Add or remove one id on one axis.
 *
 * One function rather than one per axis: the set-dedupe is the only logic here,
 * and it was being maintained in three copies that differed solely in which key
 * they rebuilt.
 */
type ScopeList = 'tool_names' | 'chat_jids' | 'table_names'

function toggle(key: ScopeList, value: string, on: boolean) {
  const next = new Set(scope.value[key])
  on ? next.add(value) : next.delete(value)
  scope.value = { ...scope.value, [key]: [...next] }
}

/**
 * The muted line under a chat's name: a number for a person, a size for a group.
 * Two chats can share a display name, and this is what tells them apart.
 *
 * Digits only, deliberately. Formatting a number for reading needs
 * country-specific rules, and this app never applies those locally.
 */
function secondaryLine(chat: ScopedChat): string {
  if (chat.synced === false) return 'not synced'
  if (chat.messages !== undefined) return chat.messages === 1 ? '1 email synced' : `${chat.messages} emails synced`
  if (chat.username) return `@${chat.username}`
  if (chat.isGroup) {
    if (!chat.participantCount) return ''
    return chat.participantCount === 1 ? '1 member' : `${chat.participantCount} members`
  }
  return chat.number ? `+${chat.number}` : ''
}

async function addByNumber() {
  manualError.value = ''
  const number = manualNumber.value.trim()
  if (!number) return

  resolving.value = true
  try {
    // WhatsApp resolves a phone number; Telegram an @username, t.me link or phone.
    const result = await $fetch<{ jid: string, name?: string, username?: string }>(
      `/api/instances/${props.instanceId}/chats/resolve`,
      { method: 'POST', body: props.kind === 'telegram' ? { query: number } : { number } },
    )
    if (props.kind === 'telegram') {
      if (!knownChats.value.some(c => c.jid === result.jid)) {
        extraChats.value.push({ jid: result.jid, name: result.name?.trim() || result.jid, username: result.username })
      }
    }
    else if (!knownChats.value.some(c => c.jid === result.jid)) {
      // The number under the name comes off the resolved JID, not what was typed:
      // Evolution's rules may have rewritten it, and the JID is what scope matches.
      const resolvedNumber = result.jid.split('@')[0]!
      extraChats.value.push({
        jid: result.jid,
        name: result.name?.trim() || resolvedNumber,
        isGroup: false,
        number: resolvedNumber,
      })
    }
    toggle('chat_jids', result.jid, true)
    manualNumber.value = ''
  }
  catch (err: any) {
    manualError.value = apiErrorMessage(err, 'Could not add that number')
  }
  finally {
    resolving.value = false
  }
}
</script>

<template>
  <!--
    Fills its dialog. From md up, actions and the table/chat axis sit side by
    side, so the list gets nearly the dialog's full height and scrolls inside
    itself — stacked, five tool descriptions leave it a row or two and the whole
    dialog scrolls instead. Every min-w-0 on the way down is what lets a long
    table name truncate rather than widen the dialog.
  -->
  <div class="flex min-h-0 min-w-0 flex-1 flex-col gap-6 md:flex-row">
    <!-- ── actions ─────────────────────────────────────────────────────── -->
    <section class="shrink-0 space-y-3 md:min-h-0 md:min-w-0 md:flex-1 md:shrink md:overflow-y-auto">
      <div>
        <h3 class="text-sm font-medium">
          Actions
        </h3>
        <p class="text-xs text-muted-foreground">
          What this token is allowed to do.
        </p>
      </div>

      <ScopeModeRadio
        :model-value="scope.all_tools"
        name="tools"
        all-label="All actions"
        some-label="Only selected actions"
        @update:model-value="scope = { ...scope, all_tools: $event }"
      />

      <div v-if="!scope.all_tools" class="space-y-2 rounded-md border p-3">
        <div v-if="toolsLoading" class="space-y-3" aria-busy="true">
          <span class="sr-only">Loading actions…</span>
          <div v-for="n in 3" :key="n" class="flex items-start gap-3">
            <Skeleton class="mt-0.5 size-4 rounded-sm" />
            <div class="min-w-0 flex-1 space-y-1.5">
              <Skeleton class="h-4 w-40" />
              <Skeleton class="h-3 w-full" />
            </div>
          </div>
        </div>

        <template v-else>
          <div
            v-for="tool in actionTools"
            :key="tool.name"
            class="flex items-start gap-3"
          >
            <Checkbox
              :id="`tool-${tool.name}`"
              :model-value="scope.tool_names.includes(tool.name)"
              class="mt-0.5"
              @update:model-value="toggle('tool_names', tool.name, $event === true)"
            />
            <div class="min-w-0 flex-1">
              <Label :for="`tool-${tool.name}`" class="flex items-center gap-2 font-normal">
                {{ tool.title }}
                <Badge :variant="tool.readOnly ? 'secondary' : 'outline'" class="text-[10px]">
                  {{ tool.readOnly ? 'read' : 'write' }}
                </Badge>
              </Label>
              <p class="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                {{ tool.description }}
              </p>
            </div>
          </div>
        </template>
      </div>

      <div v-if="extraTools.length > 0" class="space-y-2 rounded-md border p-3">
        <div>
          <h4 class="text-sm font-medium">
            Extras (off by default)
          </h4>
          <p class="text-xs text-muted-foreground">
            Not included in "All actions". Tick to allow.
          </p>
        </div>
        <div
          v-for="tool in extraTools"
          :key="tool.name"
          class="flex items-start gap-3"
        >
          <Checkbox
            :id="`tool-${tool.name}`"
            :model-value="scope.tool_names.includes(tool.name)"
            class="mt-0.5"
            @update:model-value="toggle('tool_names', tool.name, $event === true)"
          />
          <div class="min-w-0 flex-1">
            <Label :for="`tool-${tool.name}`" class="flex items-center gap-2 font-normal">
              {{ tool.title }}
            </Label>
            <p class="mt-0.5 text-xs text-muted-foreground">
              Downloads attachments and creates download links valid for 1 hour.
            </p>
          </div>
        </div>
      </div>
    </section>

    <Separator class="shrink-0 md:hidden" />

    <!-- ── tables (databases only) ─────────────────────────────────────── -->
    <section v-if="isDatabase" class="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
      <div class="shrink-0">
        <h3 class="text-sm font-medium">
          Tables
        </h3>
        <p class="text-xs text-muted-foreground">
          Which tables this token can reach. Checked against the query plan before
          any row is read, so a query that joins outside this list is refused
          rather than silently returning less.
        </p>
      </div>

      <ScopeModeRadio
        class="shrink-0"
        :model-value="scope.all_tables"
        name="tables"
        all-label="All tables the connection can read"
        some-label="Only selected tables"
        @update:model-value="scope = { ...scope, all_tables: $event }"
      />

      <div v-if="!scope.all_tables" class="flex min-h-0 min-w-0 flex-1 flex-col gap-3 rounded-md border p-3">
        <div v-if="scope.table_names.length" class="flex max-h-20 shrink-0 flex-wrap gap-1.5 overflow-y-auto">
          <Badge
            v-for="qname in scope.table_names"
            :key="qname"
            variant="secondary"
            class="max-w-full gap-1 font-mono text-[10px]"
            :title="qname"
          >
            <span class="truncate">{{ qname }}</span>
            <button type="button" class="shrink-0" aria-label="Remove table" @click="toggle('table_names', qname, false)">
              <XIcon class="size-3" />
            </button>
          </Badge>
        </div>

        <div class="relative shrink-0">
          <SearchIcon class="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input v-model="tableSearch" placeholder="Search tables" class="pl-8" />
        </div>

        <div v-if="tablesLoading" class="space-y-2" aria-busy="true">
          <span class="sr-only">Loading tables…</span>
          <Skeleton v-for="n in 4" :key="n" class="h-8 w-full" />
        </div>

        <p v-else-if="!visibleTables.length" class="py-2 text-xs text-muted-foreground">
          No tables to show. If this database is reachable but empty here, the role
          it connects as has no SELECT grant on anything.
        </p>

        <div v-else class="min-h-28 flex-1 space-y-1 overflow-y-auto">
          <div
            v-for="table in visibleTables"
            :key="table.qname"
            class="flex items-start gap-3 rounded-sm px-1 py-1.5 hover:bg-accent"
          >
            <Checkbox
              :id="`table-${table.qname}`"
              :model-value="scope.table_names.includes(table.qname)"
              class="mt-0.5"
              @update:model-value="toggle('table_names', table.qname, $event === true)"
            />
            <Label :for="`table-${table.qname}`" class="block min-w-0 flex-1 font-normal" :title="table.qname">
              <span class="block truncate font-mono text-xs">{{ table.qname }}</span>
              <span class="block text-xs text-muted-foreground">{{ table.kind }}</span>
            </Label>
          </div>
        </div>

        <p v-if="tableData?.hasMore" class="shrink-0 text-xs text-muted-foreground">
          More tables exist than are listed. Search to narrow the list.
        </p>
      </div>
    </section>

    <!-- ── chats (WhatsApp and Telegram), folders (IMAP) ───────────────── -->
    <section v-else class="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
      <div class="shrink-0">
        <h3 class="text-sm font-medium">
          {{ chatAxis.title }}
        </h3>
        <p class="text-xs text-muted-foreground">
          {{ chatAxis.blurb }}
        </p>
      </div>

      <ScopeModeRadio
        class="shrink-0"
        :model-value="scope.all_chats"
        name="chats"
        :all-label="chatAxis.all"
        :some-label="chatAxis.some"
        @update:model-value="scope = { ...scope, all_chats: $event }"
      />

      <div v-if="!scope.all_chats" class="flex min-h-0 min-w-0 flex-1 flex-col gap-3 rounded-md border p-3">
        <div v-if="selectedChats.length" class="flex max-h-20 shrink-0 flex-wrap gap-1.5 overflow-y-auto">
          <Badge
            v-for="chat in selectedChats"
            :key="chat.jid"
            variant="secondary"
            class="max-w-full gap-1"
            :title="chat.name"
          >
            <span class="truncate">{{ chat.name }}</span>
            <button type="button" class="shrink-0" :aria-label="`Remove ${chat.name}`" @click="toggle('chat_jids', chat.jid, false)">
              <XIcon class="size-3" />
            </button>
          </Badge>
        </div>

        <div class="relative shrink-0">
          <SearchIcon class="absolute top-1/2 left-2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input v-model="search" :placeholder="chatAxis.search" class="pl-8" />
        </div>

        <div class="min-h-28 flex-1 space-y-1 overflow-y-auto">
          <div v-if="chatsLoading" class="space-y-1" aria-busy="true" aria-live="polite">
            <span class="sr-only">Loading conversations…</span>
            <div v-for="n in 4" :key="n" class="flex items-center gap-3 px-2 py-1.5">
              <Skeleton class="size-4 rounded-sm" />
              <Skeleton class="size-8 rounded-full" />
              <div class="min-w-0 flex-1 space-y-1">
                <Skeleton class="h-3.5 w-32" />
                <Skeleton class="h-3 w-20" />
              </div>
            </div>
          </div>

          <p v-else-if="!knownChats.length" class="py-2 text-xs text-muted-foreground">
            <template v-if="kind === 'telegram'">
              No chats synced yet — they appear once the account is linked. Add one by
              username below.
            </template>
            <template v-else-if="kind === 'imap'">
              No folders yet — they appear after the mailbox's first sync, a minute or
              two after it is connected.
            </template>
            <template v-else>
              No conversations recorded yet — they appear here once messages are
              exchanged. Add a number directly below.
            </template>
          </p>

          <p v-else-if="!visibleChats.length" class="py-2 text-xs text-muted-foreground">
            Nothing matches “{{ search }}”.
          </p>

          <label
            v-for="chat in visibleChats"
            :key="chat.jid"
            class="flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 hover:bg-accent"
          >
            <Checkbox
              :model-value="scope.chat_jids.includes(chat.jid)"
              @update:model-value="toggle('chat_jids', chat.jid, $event === true)"
            />
            <img v-if="chat.profilePicUrl" :src="chat.profilePicUrl" alt="" class="size-8 rounded-full object-cover">
            <span v-else class="flex size-8 items-center justify-center rounded-full bg-muted">
              <FolderIcon v-if="kind === 'imap'" class="size-3.5" />
              <UsersIcon v-else-if="chat.isGroup" class="size-3.5" />
            </span>
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm">{{ chat.name }}</span>
              <span
                v-if="secondaryLine(chat)"
                class="block truncate text-xs text-muted-foreground tabular-nums"
              >{{ secondaryLine(chat) }}</span>
            </span>
            <Badge v-if="chat.isGroup" variant="outline" class="text-[10px]">
              group
            </Badge>
          </label>
        </div>

        <div v-if="chatAxis.addable" class="shrink-0 space-y-1 border-t pt-3">
          <Label for="manual-number" class="text-xs">{{ kind === 'telegram' ? 'Add by @username or t.me link' : 'Add by phone number' }}</Label>
          <div class="flex gap-2">
            <Input
              id="manual-number"
              v-model="manualNumber"
              :placeholder="kind === 'telegram' ? '@username' : '5511999999999'"
              class="min-w-0 flex-1"
              @keydown.enter.prevent="addByNumber"
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              class="shrink-0"
              :disabled="resolving"
              :aria-label="kind === 'telegram' ? 'Add chat' : 'Add number'"
              @click="addByNumber"
            >
              <PlusIcon class="size-4" />
            </Button>
          </div>
          <p v-if="manualError" class="text-xs text-destructive">
            {{ manualError }}
          </p>
          <p v-else-if="kind === 'telegram'" class="text-xs text-muted-foreground">
            A person, group or channel with a public username. Checked with Telegram
            before it is added, so the account must be connected.
          </p>
          <p v-else class="text-xs text-muted-foreground">
            International format, no “+”. Checked against WhatsApp before it is added.
          </p>
        </div>
      </div>
    </section>
  </div>
</template>
