/**
 * The app's schema, as an ordered list of migrations.
 *
 * TypeScript strings rather than `.sql` files so they are bundled into the Nitro
 * output with no copy step — a migration that is missing from the image is a
 * deployment with no tables. Applied at boot by `migrateAppDb()` in
 * `server/utils/app-db.ts`, under an advisory lock, in one transaction.
 *
 * Append only. A migration that has been deployed is never edited: its name is
 * recorded in `app.migrations` and it will not run again, so an edit reaches
 * fresh databases and silently skips every existing one.
 *
 * Every table lives in the `app` schema, never `public`: this is the same
 * Postgres database Evolution writes into (and the Telegram bridge, under
 * `telegram`), and Evolution owns `public`.
 */
export interface AppMigration {
  name: string
  sql: string
}

export const APP_MIGRATIONS: AppMigration[] = [
  {
    name: '0001_init',
    sql: /* sql */ `
      -- Ids are text so rows imported from PocketBase keep the ids they had —
      -- they are in URLs, in the browser's history, and in token labels people
      -- have written down. New rows get a uuid.

      CREATE TABLE app.users (
        id            text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        -- Stored lower-cased and trimmed (normaliseEmail), which is also what
        -- invitation acceptance compares against.
        email         text NOT NULL CHECK (email = lower(btrim(email)) AND email <> ''),
        name          text NOT NULL DEFAULT '',
        -- scrypt$..., or a bcrypt $2a$/$2b$ hash carried over from PocketBase and
        -- replaced by scrypt on that user's next successful sign-in.
        password_hash text NOT NULL,
        created       timestamptz NOT NULL DEFAULT now(),
        updated       timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX users_email_key ON app.users (email);

      -- A browser session. Only the SHA-256 of the cookie value is stored, the
      -- same handling an MCP token gets.
      CREATE TABLE app.sessions (
        id           text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        user_id      text NOT NULL REFERENCES app.users (id) ON DELETE CASCADE,
        token_hash   text NOT NULL CHECK (length(token_hash) = 64),
        expires_at   timestamptz NOT NULL,
        created      timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX sessions_token_hash_key ON app.sessions (token_hash);
      CREATE INDEX sessions_user_idx ON app.sessions (user_id);

      CREATE TABLE app.organizations (
        id      text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        name    text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
        created timestamptz NOT NULL DEFAULT now(),
        updated timestamptz NOT NULL DEFAULT now()
      );

      -- One organization per user: the unique index on user_id is that rule,
      -- and why accepting an invitation is an UPDATE of this row.
      CREATE TABLE app.memberships (
        id      text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        org     text NOT NULL REFERENCES app.organizations (id) ON DELETE CASCADE,
        user_id text NOT NULL REFERENCES app.users (id) ON DELETE CASCADE,
        role    text NOT NULL CHECK (role IN ('admin', 'member')),
        created timestamptz NOT NULL DEFAULT now(),
        updated timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX memberships_user_key ON app.memberships (user_id);
      CREATE INDEX memberships_org_idx ON app.memberships (org);

      CREATE TABLE app.instances (
        id               text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        -- RESTRICT, not CASCADE: deleting an organization that still owns
        -- connections must fail loudly rather than drop rows that point at live
        -- sockets on real phone numbers. deleteInstance() is the only way out.
        org              text NOT NULL REFERENCES app.organizations (id) ON DELETE RESTRICT,
        -- Provenance only. SET NULL for the same reason: a creator's account
        -- going must never take a connection with it.
        created_by       text REFERENCES app.users (id) ON DELETE SET NULL,
        kind             text NOT NULL CHECK (kind IN ('whatsapp', 'postgres', 'telegram')),
        name             text NOT NULL,
        instance_id      text NOT NULL DEFAULT '',
        api_key          text NOT NULL DEFAULT '',
        admin_key        text NOT NULL DEFAULT '',
        base_url         text NOT NULL DEFAULT '',
        evolution_db_url text NOT NULL DEFAULT '',
        telegram_db_url  text NOT NULL DEFAULT '',
        dsn              text NOT NULL DEFAULT '',
        db_host          text NOT NULL DEFAULT '',
        db_port          integer,
        db_database      text NOT NULL DEFAULT '',
        label            text NOT NULL DEFAULT '',
        down_since       timestamptz,
        alerted_at       timestamptz,
        created          timestamptz NOT NULL DEFAULT now(),
        updated          timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX instances_name_key ON app.instances (name);
      CREATE INDEX instances_org_idx ON app.instances (org);

      -- "May use, not manage." Admins hold no rows here.
      CREATE TABLE app.instance_assignments (
        id       text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        instance text NOT NULL REFERENCES app.instances (id) ON DELETE CASCADE,
        user_id  text NOT NULL REFERENCES app.users (id) ON DELETE CASCADE,
        created  timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX instance_assignments_key ON app.instance_assignments (instance, user_id);
      CREATE INDEX instance_assignments_user_idx ON app.instance_assignments (user_id);

      CREATE TABLE app.invitations (
        id          text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        org         text NOT NULL REFERENCES app.organizations (id) ON DELETE CASCADE,
        email       text NOT NULL,
        role        text NOT NULL CHECK (role IN ('admin', 'member')),
        code_hash   text NOT NULL CHECK (length(code_hash) = 64),
        invited_by  text REFERENCES app.users (id) ON DELETE SET NULL,
        accepted_by text REFERENCES app.users (id) ON DELETE SET NULL,
        expires_at  timestamptz,
        accepted_at timestamptz,
        revoked     boolean NOT NULL DEFAULT false,
        created     timestamptz NOT NULL DEFAULT now(),
        updated     timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX invitations_code_hash_key ON app.invitations (code_hash);
      CREATE INDEX invitations_org_idx ON app.invitations (org);

      CREATE TABLE app.mcp_tokens (
        id           text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        -- CASCADE: a deleted account's tokens must stop working.
        assigned_to  text NOT NULL REFERENCES app.users (id) ON DELETE CASCADE,
        created_by   text REFERENCES app.users (id) ON DELETE SET NULL,
        instance     text NOT NULL REFERENCES app.instances (id) ON DELETE CASCADE,
        token_hash   text NOT NULL CHECK (length(token_hash) = 64),
        label        text NOT NULL DEFAULT '',
        last_used_at timestamptz,
        expires_at   timestamptz,
        revoked      boolean NOT NULL DEFAULT false,
        -- Scope. NOT NULL with a default, so no write path can mint a token
        -- whose scope is an accident of what it forgot to set.
        all_chats    boolean NOT NULL DEFAULT true,
        chat_jids    jsonb NOT NULL DEFAULT '[]'::jsonb,
        all_tables   boolean NOT NULL DEFAULT true,
        table_names  jsonb NOT NULL DEFAULT '[]'::jsonb,
        all_tools    boolean NOT NULL DEFAULT true,
        tool_names   jsonb NOT NULL DEFAULT '[]'::jsonb,
        created      timestamptz NOT NULL DEFAULT now(),
        updated      timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX mcp_tokens_token_hash_key ON app.mcp_tokens (token_hash);
      CREATE INDEX mcp_tokens_assigned_to_idx ON app.mcp_tokens (assigned_to);
      CREATE INDEX mcp_tokens_instance_idx ON app.mcp_tokens (instance);
    `,
  },
  {
    name: '0002_two_factor',
    sql: /* sql */ `
      -- Second factors for the web sign-in. None of this touches the MCP
      -- surface: a connector token is its own credential.

      -- An authenticator-app secret, one per user. confirmed_at stays empty
      -- until a code from the app has been checked, so a setup abandoned
      -- halfway is not a factor login asks for. last_step is the newest
      -- 30-second step a code was accepted for; a code from that step or an
      -- older one is refused, so one observed code cannot be replayed.
      -- The secret is a plain column, like the credentials on app.instances.
      CREATE TABLE app.totp_credentials (
        user_id      text PRIMARY KEY REFERENCES app.users (id) ON DELETE CASCADE,
        secret       text NOT NULL,
        last_step    bigint NOT NULL DEFAULT 0,
        confirmed_at timestamptz,
        created      timestamptz NOT NULL DEFAULT now()
      );

      -- A passkey or security key. The public key is not secret; counter is
      -- the authenticator's signature counter (0 for most passkeys).
      CREATE TABLE app.webauthn_credentials (
        id            text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        user_id       text NOT NULL REFERENCES app.users (id) ON DELETE CASCADE,
        credential_id text NOT NULL,
        public_key    bytea NOT NULL,
        counter       bigint NOT NULL DEFAULT 0,
        transports    jsonb NOT NULL DEFAULT '[]'::jsonb,
        name          text NOT NULL DEFAULT '' CHECK (length(name) <= 100),
        created       timestamptz NOT NULL DEFAULT now(),
        last_used_at  timestamptz
      );
      CREATE UNIQUE INDEX webauthn_credentials_credential_id_key ON app.webauthn_credentials (credential_id);
      CREATE INDEX webauthn_credentials_user_idx ON app.webauthn_credentials (user_id);

      -- Single-use recovery codes. Only the SHA-256 is stored; the codes carry
      -- 60 random bits each, so a fast hash is enough.
      CREATE TABLE app.recovery_codes (
        id        text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        user_id   text NOT NULL REFERENCES app.users (id) ON DELETE CASCADE,
        code_hash text NOT NULL CHECK (length(code_hash) = 64),
        used_at   timestamptz,
        created   timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX recovery_codes_user_hash_key ON app.recovery_codes (user_id, code_hash);

      -- A sign-in that passed the password and still owes a second factor
      -- ('login'), or a passkey registration in progress ('register'). Never a
      -- session: a row in app.sessions means fully signed in, so nothing that
      -- reads sessions can mistake a half-finished login for one. token_hash is
      -- the SHA-256 of the login cookie; registration rows have none.
      CREATE TABLE app.mfa_challenges (
        id                 text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        user_id            text NOT NULL REFERENCES app.users (id) ON DELETE CASCADE,
        purpose            text NOT NULL CHECK (purpose IN ('login', 'register')),
        token_hash         text CHECK (token_hash IS NULL OR length(token_hash) = 64),
        webauthn_challenge text,
        attempts           integer NOT NULL DEFAULT 0,
        expires_at         timestamptz NOT NULL,
        created            timestamptz NOT NULL DEFAULT now(),
        CHECK ((purpose = 'login') = (token_hash IS NOT NULL))
      );
      CREATE UNIQUE INDEX mfa_challenges_token_hash_key ON app.mfa_challenges (token_hash);
      CREATE INDEX mfa_challenges_user_idx ON app.mfa_challenges (user_id);
    `,
  },
  {
    name: '0003_email_verification',
    sql: /* sql */ `
      -- An address waiting to be proved: a signup ('signup') or a change of
      -- sign-in address ('email_change'). A signup has no app.users row until
      -- it is verified, so a pending row claims nothing: several may name one
      -- address, and the first to verify wins. That is what stops someone
      -- registering an address they do not own ahead of its owner.
      --
      -- link_hash is the SHA-256 of the token in the mailed link; pending_hash
      -- of the cookie that lets the waiting browser type the code instead;
      -- code_hash of the row id and the six-digit code. Five wrong codes delete
      -- the row. password_hash and name are what the account is created with.
      CREATE TABLE app.email_verifications (
        id                 text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        purpose            text NOT NULL CHECK (purpose IN ('signup', 'email_change')),
        email              text NOT NULL CHECK (email = lower(btrim(email)) AND email <> ''),
        link_hash          text NOT NULL CHECK (length(link_hash) = 64),
        pending_hash       text NOT NULL CHECK (length(pending_hash) = 64),
        code_hash          text NOT NULL CHECK (length(code_hash) = 64),
        attempts           integer NOT NULL DEFAULT 0,
        user_id            text REFERENCES app.users (id) ON DELETE CASCADE,
        password_hash      text,
        name               text,
        invite_id          text REFERENCES app.invitations (id) ON DELETE CASCADE,
        first_account_only boolean NOT NULL DEFAULT false,
        expires_at         timestamptz NOT NULL,
        created            timestamptz NOT NULL DEFAULT now(),
        CHECK ((purpose = 'email_change') = (user_id IS NOT NULL)),
        CHECK ((purpose = 'signup') = (password_hash IS NOT NULL))
      );
      CREATE UNIQUE INDEX email_verifications_link_hash_key ON app.email_verifications (link_hash);
      CREATE UNIQUE INDEX email_verifications_pending_hash_key ON app.email_verifications (pending_hash);
      CREATE INDEX email_verifications_user_idx ON app.email_verifications (user_id);
    `,
  },
  {
    name: '0004_imap',
    sql: /* sql */ `
      -- A fourth kind: a user-supplied IMAP mailbox. The CHECK was declared
      -- inline in 0001_init, so it carries Postgres' default name.
      ALTER TABLE app.instances DROP CONSTRAINT instances_kind_check;
      ALTER TABLE app.instances ADD CONSTRAINT instances_kind_check
        CHECK (kind IN ('whatsapp', 'postgres', 'telegram', 'imap'));

      -- The mailbox's credentials. imap_password is a secret like dsn: plain,
      -- never projected. There is no plaintext transport — 'starttls' must
      -- upgrade or the connection is refused.
      ALTER TABLE app.instances
        ADD COLUMN imap_host     text NOT NULL DEFAULT '',
        ADD COLUMN imap_port     integer,
        ADD COLUMN imap_security text NOT NULL DEFAULT ''
          CHECK (imap_security IN ('', 'tls', 'starttls')),
        ADD COLUMN imap_user     text NOT NULL DEFAULT '',
        ADD COLUMN imap_password text NOT NULL DEFAULT '';

      -- What the sync knows about a mailbox. Headers only: bodies and
      -- attachments are fetched from the mail server when a tool asks, and are
      -- never written here. See server/utils/imap-sync.ts.
      --
      -- identity is lower(user@host): when new credentials name another
      -- mailbox, everything synced under the old one is deleted. lease_until is
      -- claimed by conditional UPDATE, so two replicas never sync one mailbox
      -- at once.
      CREATE TABLE app.mail_sync_state (
        instance_id     text PRIMARY KEY REFERENCES app.instances (id) ON DELETE CASCADE,
        identity        text NOT NULL DEFAULT '',
        lease_until     timestamptz NOT NULL DEFAULT '-infinity',
        runs            integer NOT NULL DEFAULT 0,
        last_attempt_at timestamptz,
        last_success_at timestamptz,
        last_error_code text,
        last_error_at   timestamptz,
        auth_failed     boolean NOT NULL DEFAULT false
      );

      -- One row per folder the server lists, synced or not, so a listing can
      -- say a folder exists and was skipped. oldest_uid is how far down the
      -- backfill has walked; backfill_stopped says why it stopped short of the
      -- folder's first message ('days' or 'count'), backfill_complete that it
      -- did not.
      CREATE TABLE app.mail_folders (
        instance_id       text NOT NULL REFERENCES app.instances (id) ON DELETE CASCADE,
        path              text NOT NULL,
        name              text NOT NULL DEFAULT '',
        delimiter         text,
        special_use       text,
        synced            boolean NOT NULL DEFAULT false,
        uidvalidity       bigint,
        last_uid          bigint NOT NULL DEFAULT 0,
        oldest_uid        bigint,
        highest_modseq    numeric,
        backfill_complete boolean NOT NULL DEFAULT false,
        backfill_stopped  text CHECK (backfill_stopped IN ('days', 'count')),
        server_messages   integer,
        last_synced_at    timestamptz,
        PRIMARY KEY (instance_id, path)
      );

      -- One row per message per folder. A message filed in two folders (a
      -- Gmail label) is two rows sharing message_id; cross-folder reads
      -- collapse them. text_part / html_part are BODYSTRUCTURE part ids, and
      -- attachments lists parts with name, type and size — the bytes stay on
      -- the mail server.
      CREATE TABLE app.mail_messages (
        instance_id     text NOT NULL REFERENCES app.instances (id) ON DELETE CASCADE,
        folder_path     text NOT NULL,
        uidvalidity     bigint NOT NULL,
        uid             bigint NOT NULL,
        message_id      text,
        in_reply_to     text,
        refs            text[] NOT NULL DEFAULT '{}',
        subject         text NOT NULL DEFAULT '',
        from_addr       jsonb NOT NULL DEFAULT '[]',
        to_addr         jsonb NOT NULL DEFAULT '[]',
        cc_addr         jsonb NOT NULL DEFAULT '[]',
        sent_at         timestamptz,
        received_at     timestamptz NOT NULL,
        flags           text[] NOT NULL DEFAULT '{}',
        size            integer,
        text_part       text,
        html_part       text,
        attachments     jsonb NOT NULL DEFAULT '[]',
        subject_tsv     tsvector GENERATED ALWAYS AS (to_tsvector('simple', subject)) STORED,
        PRIMARY KEY (instance_id, folder_path, uid),
        FOREIGN KEY (instance_id, folder_path) REFERENCES app.mail_folders (instance_id, path) ON DELETE CASCADE
      );
      CREATE INDEX mail_messages_received_idx ON app.mail_messages (instance_id, received_at DESC, uid DESC);
      CREATE INDEX mail_messages_message_id_idx ON app.mail_messages (instance_id, message_id);
      CREATE INDEX mail_messages_subject_idx ON app.mail_messages USING gin (subject_tsv);
    `,
  },
  {
    name: '0005_media_links',
    sql: /* sql */ `
      -- A download link for one WhatsApp attachment (get-message-media). The
      -- row holds no bytes: the file is fetched from WhatsApp when the link is
      -- opened, so nothing a chat sent is stored at rest by this table. Only
      -- the SHA-256 of the link's secret is kept, like an MCP token.
      --
      -- Both foreign keys cascade, for different reasons. instances: so
      -- deleteInstance() never fails on a link nobody can still use. mcp_tokens:
      -- tokens are revoked rather than deleted, so this only fires when the
      -- holder's account is deleted (which cascades through their tokens) and
      -- then the link must go with them. A revoked or demoted token's links die
      -- through authorizeMediaLink(), which reads the token live, not here.
      CREATE TABLE app.media_links (
        id          text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        token_hash  text NOT NULL CHECK (length(token_hash) = 64),
        instance    text NOT NULL REFERENCES app.instances (id) ON DELETE CASCADE,
        token_id    text NOT NULL REFERENCES app.mcp_tokens (id) ON DELETE CASCADE,
        message_id  text NOT NULL,
        remote_jid  text NOT NULL,
        file_name   text NOT NULL,
        mime_type   text NOT NULL,
        expires_at  timestamptz NOT NULL,
        downloads   integer NOT NULL DEFAULT 0 CHECK (downloads >= 0),
        created     timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX media_links_token_hash_key ON app.media_links (token_hash);
      CREATE INDEX media_links_expires_idx ON app.media_links (expires_at);
    `,
  },
]
