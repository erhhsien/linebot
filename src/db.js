import pg from "pg";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined });

export async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS invitations (
      id uuid PRIMARY KEY,
      gmail_thread_id text NOT NULL UNIQUE,
      gmail_message_id text,
      subject text NOT NULL,
      sender text NOT NULL,
      payload jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS line_sessions (
      user_id text PRIMARY KEY,
      invitation_id uuid NOT NULL REFERENCES invitations(id),
      scheme_key text NOT NULL,
      draft text NOT NULL,
      state text NOT NULL DEFAULT 'awaiting_confirmation',
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS outbound_actions (
      id uuid PRIMARY KEY,
      invitation_id uuid NOT NULL REFERENCES invitations(id),
      requested_by text NOT NULL,
      recipient text NOT NULL,
      subject text NOT NULL,
      body text NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      gmail_message_id text,
      created_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_open_action_per_invitation
      ON outbound_actions(invitation_id) WHERE status IN ('pending', 'sending');
    CREATE TABLE IF NOT EXISTS app_state (
      key text PRIMARY KEY,
      value jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

export async function saveInvitation(invitation) {
  const result = await pool.query(
    `INSERT INTO invitations(id,gmail_thread_id,gmail_message_id,subject,sender,payload)
     VALUES($1,$2,$3,$4,$5,$6)
     ON CONFLICT(gmail_thread_id) DO UPDATE SET
       gmail_message_id=excluded.gmail_message_id, subject=excluded.subject,
       sender=excluded.sender, payload=excluded.payload
     RETURNING *, (xmax = 0) AS inserted`,
    [invitation.id, invitation.gmailThreadId, invitation.gmailMessageId || null, invitation.subject, invitation.sender, invitation]
  );
  return rowInvitation(result.rows[0]);
}

function rowInvitation(row) { return { ...row.payload, id: row.id, gmailThreadId: row.gmail_thread_id, gmailMessageId: row.gmail_message_id, subject: row.subject, sender: row.sender, inserted: row.inserted }; }
export async function getInvitation(id) { const r = await pool.query("SELECT * FROM invitations WHERE id=$1", [id]); return r.rows[0] ? rowInvitation(r.rows[0]) : null; }
export async function getLatestInvitation() { const r = await pool.query("SELECT * FROM invitations ORDER BY created_at DESC LIMIT 1"); return r.rows[0] ? rowInvitation(r.rows[0]) : null; }

export async function saveSession(userId, invitationId, schemeKey, draft) {
  await pool.query(`INSERT INTO line_sessions(user_id,invitation_id,scheme_key,draft,state) VALUES($1,$2,$3,$4,'awaiting_confirmation')
    ON CONFLICT(user_id) DO UPDATE SET invitation_id=excluded.invitation_id,scheme_key=excluded.scheme_key,draft=excluded.draft,state='awaiting_confirmation',updated_at=now()`, [userId, invitationId, schemeKey, draft]);
}
export async function getSession(userId) { const r = await pool.query("SELECT * FROM line_sessions WHERE user_id=$1", [userId]); return r.rows[0] || null; }
export async function updateDraft(userId, draft) { await pool.query("UPDATE line_sessions SET draft=$2,state='awaiting_confirmation',updated_at=now() WHERE user_id=$1", [userId, draft]); }

export async function queueAction({ id, invitationId, userId, recipient, subject, body }) {
  const r = await pool.query(`INSERT INTO outbound_actions(id,invitation_id,requested_by,recipient,subject,body) VALUES($1,$2,$3,$4,$5,$6)
    ON CONFLICT DO NOTHING RETURNING *`, [id, invitationId, userId, recipient, subject, body]);
  if (!r.rows[0]) return null;
  await pool.query("UPDATE line_sessions SET state='queued',updated_at=now() WHERE user_id=$1", [userId]);
  return r.rows[0];
}
export async function claimAction(id) {
  const r = await pool.query(
    "UPDATE outbound_actions SET status='sending' WHERE id=$1 AND status='pending' RETURNING *",
    [id]
  );
  return r.rows[0] || null;
}
export async function completeAction(id, gmailMessageId) {
  const r = await pool.query(
    "UPDATE outbound_actions SET status='completed',gmail_message_id=$2,completed_at=now() WHERE id=$1 AND status='sending' RETURNING *",
    [id, gmailMessageId]
  );
  return r.rows[0] || null;
}
export async function flagActionForReview(id) {
  await pool.query("UPDATE outbound_actions SET status='needs_review' WHERE id=$1 AND status='sending'", [id]);
}
export async function listPendingActions() { const r = await pool.query("SELECT * FROM outbound_actions WHERE status='pending' ORDER BY created_at"); return r.rows; }
export async function setState(key, value) { await pool.query("INSERT INTO app_state(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=now()", [key, value]); }
export async function getState(key) { const r = await pool.query("SELECT value FROM app_state WHERE key=$1", [key]); return r.rows[0]?.value ?? null; }
export { pool };
