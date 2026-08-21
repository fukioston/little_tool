import type { LocalDatabaseSchema } from "./types";

/** SQLite application_id for the ASCII-ish marker "ZHJI". */
export const ZHIJI_APPLICATION_ID = 0x5a484a49;

export const zhijiSchema: LocalDatabaseSchema = {
  name: "zhiji",
  filename: "zhiji.sqlite3",
  applicationId: ZHIJI_APPLICATION_ID,
  seedVersion: 1,
  migrations: [
    {
      version: 1,
      description: "Create the initial career workspace schema",
      sql: `
        PRAGMA application_id = ${ZHIJI_APPLICATION_ID};

        CREATE TABLE app_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE career_profiles (
          id TEXT PRIMARY KEY,
          display_name TEXT NOT NULL,
          target_roles TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(target_roles)),
          target_locations TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(target_locations)),
          weekly_application_goal INTEGER NOT NULL DEFAULT 5 CHECK (weekly_application_goal >= 0),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE career_stages (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          stage_key TEXT NOT NULL UNIQUE,
          position INTEGER NOT NULL UNIQUE CHECK (position >= 0),
          color TEXT NOT NULL,
          is_terminal INTEGER NOT NULL DEFAULT 0 CHECK (is_terminal IN (0, 1)),
          created_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE companies (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          website TEXT,
          industry TEXT,
          location TEXT,
          size_label TEXT,
          logo_text TEXT,
          notes TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE job_applications (
          id TEXT PRIMARY KEY,
          company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
          stage_id TEXT NOT NULL REFERENCES career_stages(id) ON DELETE RESTRICT,
          role_title TEXT NOT NULL,
          location TEXT,
          work_mode TEXT CHECK (work_mode IS NULL OR work_mode IN ('onsite', 'hybrid', 'remote')),
          employment_type TEXT CHECK (employment_type IS NULL OR employment_type IN ('full_time', 'part_time', 'contract', 'internship')),
          source TEXT,
          source_url TEXT,
          salary_min INTEGER CHECK (salary_min IS NULL OR salary_min >= 0),
          salary_max INTEGER CHECK (salary_max IS NULL OR salary_max >= salary_min),
          salary_currency TEXT,
          priority INTEGER NOT NULL DEFAULT 1 CHECK (priority BETWEEN 0 AND 3),
          fit_score INTEGER CHECK (fit_score IS NULL OR fit_score BETWEEN 0 AND 100),
          description TEXT NOT NULL DEFAULT '',
          applied_at TEXT,
          deadline_at TEXT,
          next_action TEXT,
          next_action_at TEXT,
          archived_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE application_events (
          id TEXT PRIMARY KEY,
          application_id TEXT NOT NULL REFERENCES job_applications(id) ON DELETE CASCADE,
          event_type TEXT NOT NULL CHECK (event_type IN ('created', 'stage_changed', 'note', 'email', 'call', 'interview', 'offer', 'rejection')),
          from_stage_id TEXT REFERENCES career_stages(id) ON DELETE SET NULL,
          to_stage_id TEXT REFERENCES career_stages(id) ON DELETE SET NULL,
          title TEXT NOT NULL,
          detail TEXT NOT NULL DEFAULT '',
          occurred_at TEXT NOT NULL,
          created_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE career_tasks (
          id TEXT PRIMARY KEY,
          application_id TEXT REFERENCES job_applications(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          detail TEXT NOT NULL DEFAULT '',
          due_at TEXT,
          priority INTEGER NOT NULL DEFAULT 1 CHECK (priority BETWEEN 0 AND 3),
          status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'doing', 'done', 'cancelled')),
          completed_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE interviews (
          id TEXT PRIMARY KEY,
          application_id TEXT NOT NULL REFERENCES job_applications(id) ON DELETE CASCADE,
          round_number INTEGER NOT NULL CHECK (round_number > 0),
          interview_type TEXT NOT NULL CHECK (interview_type IN ('screen', 'portfolio', 'technical', 'behavioral', 'case', 'onsite', 'other')),
          scheduled_at TEXT NOT NULL,
          duration_minutes INTEGER CHECK (duration_minutes IS NULL OR duration_minutes > 0),
          location_or_link TEXT,
          interviewer_names TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(interviewer_names)),
          preparation_notes TEXT NOT NULL DEFAULT '',
          outcome TEXT CHECK (outcome IS NULL OR outcome IN ('pending', 'passed', 'failed', 'cancelled')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (application_id, round_number)
        ) STRICT;

        CREATE TABLE contacts (
          id TEXT PRIMARY KEY,
          company_id TEXT REFERENCES companies(id) ON DELETE SET NULL,
          full_name TEXT NOT NULL,
          role_title TEXT,
          email TEXT,
          phone TEXT,
          profile_url TEXT,
          relationship TEXT,
          last_contacted_at TEXT,
          next_follow_up_at TEXT,
          notes TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE contact_interactions (
          id TEXT PRIMARY KEY,
          contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
          application_id TEXT REFERENCES job_applications(id) ON DELETE SET NULL,
          channel TEXT NOT NULL CHECK (channel IN ('email', 'phone', 'message', 'meeting', 'other')),
          direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound', 'mutual')),
          summary TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          created_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE career_documents (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL CHECK (kind IN ('resume', 'cover_letter', 'portfolio', 'case_study', 'certificate', 'other')),
          title TEXT NOT NULL,
          original_filename TEXT,
          storage_key TEXT UNIQUE,
          mime_type TEXT,
          byte_size INTEGER CHECK (byte_size IS NULL OR byte_size >= 0),
          sha256 TEXT,
          version_label TEXT,
          status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'ready', 'archived', 'missing')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE application_documents (
          application_id TEXT NOT NULL REFERENCES job_applications(id) ON DELETE CASCADE,
          document_id TEXT NOT NULL REFERENCES career_documents(id) ON DELETE CASCADE,
          purpose TEXT NOT NULL DEFAULT 'attachment',
          attached_at TEXT NOT NULL,
          PRIMARY KEY (application_id, document_id)
        ) STRICT;

        CREATE TABLE career_notes (
          id TEXT PRIMARY KEY,
          application_id TEXT REFERENCES job_applications(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          body TEXT NOT NULL DEFAULT '',
          is_pinned INTEGER NOT NULL DEFAULT 0 CHECK (is_pinned IN (0, 1)),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE INDEX idx_job_applications_stage_updated
          ON job_applications(stage_id, updated_at DESC);
        CREATE INDEX idx_job_applications_next_action
          ON job_applications(next_action_at)
          WHERE archived_at IS NULL AND next_action_at IS NOT NULL;
        CREATE INDEX idx_application_events_application_time
          ON application_events(application_id, occurred_at DESC);
        CREATE INDEX idx_career_tasks_status_due
          ON career_tasks(status, due_at)
          WHERE status IN ('todo', 'doing');
        CREATE INDEX idx_interviews_scheduled
          ON interviews(scheduled_at);
        CREATE INDEX idx_contacts_follow_up
          ON contacts(next_follow_up_at)
          WHERE next_follow_up_at IS NOT NULL;
        CREATE INDEX idx_contact_interactions_contact_time
          ON contact_interactions(contact_id, occurred_at DESC);
        CREATE INDEX idx_career_notes_application_updated
          ON career_notes(application_id, updated_at DESC);
      `,
    },
  ],
  seedSql: `
    INSERT INTO career_stages
      (id, name, stage_key, position, color, is_terminal, created_at) VALUES
      ('stage-preparing', '准备申请', 'preparing', 0, '#B38A58', 0, '1970-01-01T00:00:00.000Z'),
      ('stage-applied', '已投递', 'applied', 1, '#6C7D9D', 0, '1970-01-01T00:00:00.000Z'),
      ('stage-interviewing', '面试中', 'interviewing', 2, '#9B6D52', 0, '1970-01-01T00:00:00.000Z'),
      ('stage-offer', 'Offer', 'offer', 3, '#597A65', 1, '1970-01-01T00:00:00.000Z'),
      ('stage-rejected', '未继续', 'rejected', 4, '#8B7B78', 1, '1970-01-01T00:00:00.000Z'),
      ('stage-archived', '已归档', 'archived', 5, '#8A8A86', 1, '1970-01-01T00:00:00.000Z')
    ON CONFLICT(id) DO NOTHING;
  `,
};
