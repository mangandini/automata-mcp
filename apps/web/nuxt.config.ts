import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import { WHATSAPP_INSTRUCTIONS } from './server/utils/mcp-instructions'

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },
  css: ['~/assets/css/tailwind.css'],

  app: {
    head: {
      meta: [
        // The page's own --background, so a mobile browser's chrome matches it.
        { name: 'theme-color', content: '#f4f1e8' },
      ],
      link: [
        { rel: 'icon', href: '/favicon.ico', sizes: 'any' },
        { rel: 'icon', href: '/favicon-16x16.png', type: 'image/png', sizes: '16x16' },
        { rel: 'icon', href: '/favicon-32x32.png', type: 'image/png', sizes: '32x32' },
        { rel: 'apple-touch-icon', href: '/apple-touch-icon.png', sizes: '180x180' },
      ],
    },
  },

  vite: {
    plugins: [
      tailwindcss(),
    ],
  },

  modules: ['shadcn-nuxt', '@nuxtjs/mcp-toolkit'],

  nitro: {
    // The PDF worker (server/utils/media-pdf.ts) imports `unpdf` from a string of
    // source, which the bundler cannot see: without this, `unpdf` is missing from
    // `.output/server/node_modules` and every PDF read fails there. An absolute
    // path, because a bare name is handed back as external and never traced.
    externals: { traceInclude: [join(dirname(createRequire(import.meta.url).resolve('unpdf')), 'index.mjs')] },
    experimental: {
      // Required. MCP tool handlers are invoked by the MCP SDK and receive its
      // `RequestHandlerExtra` — not an H3 event. `useEvent()` is the only way to
      // reach per-request credentials from inside a tool, and it needs this flag.
      asyncContext: true,
      // Required for `scheduledTasks` below and for server/tasks/ to be built.
      tasks: true,
    },
    /**
     * The connection sweep. It is not a backstop for the webhook — a close
     * Evolution intends to retry emits no `connection.update` at all, so this is
     * the only thing that ever sees a session that dropped and stayed dropped.
     *
     * Runs in-process, once per running instance of this server. More than one
     * replica means more than one sweep, and so duplicate emails; keep this
     * service to a single instance or give the sweep a lock first.
     */
    scheduledTasks: {
      // Every five minutes so an outage that outlasts the 10-minute grace is
      // mailed soon after it does. Webhook re-registration stays hourly.
      '*/5 * * * *': ['alerts:sweep'],
      '0 * * * *': ['alerts:register-webhooks'],
      // Mailbox headers. Safe on several replicas: each mailbox is leased.
      '*/2 * * * *': ['imap:sync'],
    },
  },

  mcp: {
    // Static: the toolkit reads it before auth has run, so it cannot vary by
    // connection. Per-kind `instructions` can, and do.
    name: 'MCP Controller',
    version: '0.1.0',
    route: '/mcp',
    // The fallback, used for an unauthenticated request and if the hook in
    // server/plugins/mcp-instructions.ts ever stops firing. WhatsApp rather than
    // something neutral, so a degradation lands on today's behaviour.
    instructions: WHATSAPP_INSTRUCTIONS,
    // Opt out of evlog wide-events on the MCP route. Request bodies and headers on
    // /mcp carry bearer tokens; see server/utils/redact.ts.
    logging: false,
  },

  runtimeConfig: {
    // The app's own database: users, sessions, organizations, connections,
    // tokens. Required. Tables live in the `app` schema and are migrated at boot.
    databaseUrl: '',

    // Outbound mail (connection alerts, invitation emails). Optional: with no
    // host, mail is computed and not delivered. See server/utils/mailer.ts.
    smtpHost: '',
    smtpPort: '587',
    smtpUsername: '',
    smtpPassword: '',
    smtpTls: 'false',
    mailFrom: '',
    mailFromName: 'Automata MCP',

    // The *default* Evolution server, used by any WhatsApp connection that did
    // not bring its own. Optional: with these unset the app still runs, and the
    // WhatsApp create flow requires the user to supply a server.
    evolutionUrl: '',
    // That server's global key. Used ONLY to create and delete instances on it,
    // by server/utils/instances.ts. Never stored on a record and never used to
    // serve a request on behalf of a user — see server/utils/evolution.ts. A
    // user-supplied server carries its own key on the instance row instead; the
    // two are never cross-paired.
    evolutionAdminKey: '',
    // Read-only connection to Evolution's own Postgres, behind both
    // `read-messages` and `search-messages`. Unset, both fail for accounts on the
    // default server (announced once at startup); a bring-your-own connection
    // carries its own URL instead. This reaches every user's messages, so the
    // role behind it must be SELECT-only — see server/utils/evolution-db.ts and
    // docs/whatsapp.md "Reading and searching messages".
    evolutionDatabaseUrl: '',

    // WhatsApp attachment downloads (server/utils/media-download.ts), as strings
    // like every numeric setting here. The largest file the public download
    // link serves, and the in-memory copy of recently fetched files; a value
    // that is not a positive number falls back to the default.
    whatsappMediaMaxBytes: String(25 * 1024 * 1024),
    whatsappMediaCacheBytes: String(50 * 1024 * 1024),

    // The *default* Telegram bridge (apps/telegram-bridge), for Telegram
    // connections that did not bring their own. Optional, like Evolution's.
    telegramUrl: '',
    // That bridge's admin key. Creates and deletes sessions only; never used to
    // read or send on a user's behalf — see server/utils/telegram.ts.
    telegramAdminKey: '',
    // Read-only connection to that bridge's database as telegram_reader, behind
    // list-, read- and search-telegram-messages. Unset, those fail for
    // connections on the default bridge (announced at startup).
    telegramDatabaseUrl: '',
    // Where the bridge posts connection events for alerting. Unset, the public
    // app URL + /api/webhook/telegram; set it where the bridge cannot reach that
    // (in development, http://host.docker.internal:3000/api/webhook/telegram).
    telegramWebhookUrl: '',

    // IMAP mailboxes: how far back the header sync reaches, per folder, and the
    // largest attachment a tool will fetch. Attachments are fetched from the
    // mail server on request and never stored. See server/utils/imap-sync.ts.
    imapBackfillDays: '365',
    imapBackfillMax: '50000',
    imapAttachmentMaxBytes: String(10 * 1024 * 1024),

    // Let a user-supplied Postgres DSN or Evolution URL point at a private or
    // loopback address. Correct for a single-tenant, self-hosted deployment;
    // wrong for anything shared, where it lets one user's connection reach this
    // deployment's own backends. See server/utils/net-guard.ts.
    allowPrivateTargets: false,

    // Who may create an account without an invitation: `open` or `invite-only`.
    // Invite-only lets the first account on an empty database through, so a new
    // deployment still works unconfigured. See server/utils/signup-policy.ts.
    signup: 'invite-only',
    // Optional, invite-only mode only: a shared code that lets its holder sign
    // up and create their own organization. When set, the first account needs
    // it too.
    signupCode: '',
    // Prove an address before it becomes a sign-in: `auto` (on when
    // NUXT_SMTP_HOST is set), `required` or `off`; anything else is read as
    // required. See server/utils/email-verification.ts.
    emailVerification: 'auto',

    webhookUrl: '',
    webhookSecret: '',

    public: {
      appUrl: '',
    },
  },

  shadcn: {
    /**
     * Prefix for all the imported component.
     * @default "Ui"
     */
    prefix: '',
    /**
     * Directory that the component lives in.
     * Will respect the Nuxt aliases.
     * @link https://nuxt.com/docs/api/nuxt-config#alias
     * @default "@/components/ui"
     */
    componentDir: '@/components/ui',
  },
})
