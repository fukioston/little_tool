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
    INSERT INTO career_profiles (
      id, display_name, target_roles, target_locations, weekly_application_goal, created_at, updated_at
    ) VALUES (
      'profile-default', '你', '["Product Designer","Design Engineer","Product Engineer"]',
      '["Singapore","Remote"]', 10, '2026-08-01T09:00:00.000Z', '2026-08-21T06:00:00.000Z'
    ) ON CONFLICT(id) DO NOTHING;

    INSERT INTO career_stages (id, name, stage_key, position, color, is_terminal, created_at) VALUES
      ('stage-preparing', '准备申请', 'preparing', 0, '#B38A58', 0, '2026-08-01T09:00:00.000Z'),
      ('stage-applied', '已投递', 'applied', 1, '#6C7D9D', 0, '2026-08-01T09:00:00.000Z'),
      ('stage-interviewing', '面试中', 'interviewing', 2, '#9B6D52', 0, '2026-08-01T09:00:00.000Z'),
      ('stage-offer', 'Offer', 'offer', 3, '#597A65', 1, '2026-08-01T09:00:00.000Z'),
      ('stage-rejected', '未继续', 'rejected', 4, '#8B7B78', 1, '2026-08-01T09:00:00.000Z'),
      ('stage-archived', '已归档', 'archived', 5, '#8A8A86', 1, '2026-08-01T09:00:00.000Z')
    ON CONFLICT(id) DO NOTHING;

    INSERT INTO companies (id, name, website, industry, location, size_label, logo_text, notes, created_at, updated_at) VALUES
      ('company-linear', 'Linear', 'https://linear.app', 'Productivity software', 'Remote', '51–200', 'L', '关注产品体验与系统思维。', '2026-08-14T08:00:00.000Z', '2026-08-20T08:00:00.000Z'),
      ('company-notion', 'Notion', 'https://notion.so', 'Productivity software', 'Singapore / Remote', '501–1,000', 'N', '通过朋友内推。', '2026-08-12T08:00:00.000Z', '2026-08-18T08:00:00.000Z'),
      ('company-arc', 'Arc', 'https://arc.net', 'Consumer software', 'Remote', '51–200', 'A', '准备技术与设计交叉案例。', '2026-08-10T08:00:00.000Z', '2026-08-21T05:00:00.000Z'),
      ('company-figma', 'Figma', 'https://figma.com', 'Design software', 'Singapore', '1,001–5,000', 'F', 'Offer 条款待确认。', '2026-07-22T08:00:00.000Z', '2026-08-21T04:00:00.000Z')
    ON CONFLICT(id) DO NOTHING;

    INSERT INTO job_applications (
      id, company_id, stage_id, role_title, location, work_mode, employment_type, source,
      source_url, priority, fit_score, description, applied_at, deadline_at, next_action,
      next_action_at, created_at, updated_at
    ) VALUES
      ('application-linear', 'company-linear', 'stage-preparing', 'Product Designer', 'Remote', 'remote', 'full_time', 'Company site', 'https://linear.app/careers', 2, 88, '强调复杂工作流、信息架构与细节品质。', NULL, '2026-08-24T15:59:00.000Z', '完成作品集定制', '2026-08-22T04:00:00.000Z', '2026-08-14T08:00:00.000Z', '2026-08-21T03:00:00.000Z'),
      ('application-notion', 'company-notion', 'stage-applied', 'Product Engineer', 'Singapore / Remote', 'hybrid', 'full_time', 'Referral', 'https://notion.so/careers', 2, 82, '突出原型能力和跨职能合作。', '2026-08-18T02:30:00.000Z', NULL, '跟进内推人', '2026-08-24T02:00:00.000Z', '2026-08-12T08:00:00.000Z', '2026-08-18T02:30:00.000Z'),
      ('application-arc', 'company-arc', 'stage-interviewing', 'Design Engineer', 'Remote', 'remote', 'full_time', 'Community', 'https://arc.net/jobs', 3, 94, '技术二面将覆盖前端架构与交互实现。', '2026-08-11T06:00:00.000Z', NULL, '准备 Arc 技术二面', '2026-08-22T06:00:00.000Z', '2026-08-10T08:00:00.000Z', '2026-08-21T05:00:00.000Z'),
      ('application-figma', 'company-figma', 'stage-offer', 'Growth Designer', 'Singapore', 'hybrid', 'full_time', 'Recruiter', 'https://figma.com/careers', 3, 90, '评估团队范围、成长空间与总包。', '2026-07-24T03:00:00.000Z', NULL, '整理 Offer 问题清单', '2026-08-23T03:00:00.000Z', '2026-07-22T08:00:00.000Z', '2026-08-21T04:00:00.000Z')
    ON CONFLICT(id) DO NOTHING;

    INSERT INTO application_events (
      id, application_id, event_type, from_stage_id, to_stage_id, title, detail, occurred_at, created_at
    ) VALUES
      ('event-linear-created', 'application-linear', 'created', NULL, 'stage-preparing', '收藏职位', '来自 Linear 招聘页。', '2026-08-14T08:00:00.000Z', '2026-08-14T08:00:00.000Z'),
      ('event-notion-applied', 'application-notion', 'stage_changed', 'stage-preparing', 'stage-applied', '完成投递', '使用 Product Engineer 定制版简历。', '2026-08-18T02:30:00.000Z', '2026-08-18T02:30:00.000Z'),
      ('event-arc-interview', 'application-arc', 'interview', 'stage-applied', 'stage-interviewing', '进入技术二面', '面试时间为周五 14:00。', '2026-08-20T05:00:00.000Z', '2026-08-20T05:00:00.000Z'),
      ('event-figma-offer', 'application-figma', 'offer', 'stage-interviewing', 'stage-offer', '收到 Offer', '下周一前确认。', '2026-08-20T03:00:00.000Z', '2026-08-20T03:00:00.000Z')
    ON CONFLICT(id) DO NOTHING;

    INSERT INTO career_tasks (id, application_id, title, detail, due_at, priority, status, completed_at, created_at, updated_at) VALUES
      ('task-arc-interview', 'application-arc', '准备 Arc 技术二面', '复盘架构案例并准备 3 个追问。', '2026-08-22T05:00:00.000Z', 3, 'doing', NULL, '2026-08-20T05:10:00.000Z', '2026-08-21T05:30:00.000Z'),
      ('task-linear-portfolio', 'application-linear', '定制 Linear 作品集', '将复杂工作流案例移到首屏。', '2026-08-22T04:00:00.000Z', 2, 'todo', NULL, '2026-08-20T08:00:00.000Z', '2026-08-20T08:00:00.000Z'),
      ('task-figma-offer', 'application-figma', '整理 Offer 问题清单', '覆盖职责范围、职级、签字费与入职时间。', '2026-08-23T03:00:00.000Z', 3, 'todo', NULL, '2026-08-21T04:10:00.000Z', '2026-08-21T04:10:00.000Z')
    ON CONFLICT(id) DO NOTHING;

    INSERT INTO interviews (
      id, application_id, round_number, interview_type, scheduled_at, duration_minutes,
      location_or_link, interviewer_names, preparation_notes, outcome, created_at, updated_at
    ) VALUES (
      'interview-arc-2', 'application-arc', 2, 'technical', '2026-08-22T06:00:00.000Z', 60,
      'Video call', '["Maya Chen","Alex Kim"]', '准备状态管理、性能取舍与无障碍实现。', 'pending',
      '2026-08-20T05:00:00.000Z', '2026-08-21T05:00:00.000Z'
    ) ON CONFLICT(id) DO NOTHING;

    INSERT INTO contacts (
      id, company_id, full_name, role_title, email, relationship, last_contacted_at,
      next_follow_up_at, notes, created_at, updated_at
    ) VALUES (
      'contact-notion-referrer', 'company-notion', 'Jamie Liu', 'Product Engineer', 'jamie@example.test',
      'Former teammate', '2026-08-18T03:00:00.000Z', '2026-08-24T02:00:00.000Z',
      '愿意在一周后帮忙查看进度。', '2026-08-12T08:00:00.000Z', '2026-08-18T03:00:00.000Z'
    ) ON CONFLICT(id) DO NOTHING;

    INSERT INTO career_documents (
      id, kind, title, original_filename, storage_key, mime_type, byte_size, sha256,
      version_label, status, created_at, updated_at
    ) VALUES (
      'document-resume-product-2026', 'resume', 'Product / Design Engineer Resume', NULL, NULL,
      NULL, NULL, NULL, '2026.08', 'draft', '2026-08-01T09:00:00.000Z', '2026-08-20T07:00:00.000Z'
    ) ON CONFLICT(id) DO NOTHING;

    INSERT INTO career_notes (id, application_id, title, body, is_pinned, created_at, updated_at) VALUES
      ('note-arc-prep', 'application-arc', '二面叙事主线', '从用户问题开始，说明约束、权衡、验证和复盘。', 1, '2026-08-20T06:00:00.000Z', '2026-08-21T05:00:00.000Z')
    ON CONFLICT(id) DO NOTHING;
  `,
};
