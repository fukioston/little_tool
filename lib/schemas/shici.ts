import type { LocalDatabaseSchema } from "./types";

/** SQLite application_id for the ASCII-ish marker "SHCI". */
export const SHICI_APPLICATION_ID = 0x53484349;

export const shiciSchema: LocalDatabaseSchema = {
  name: "shici",
  filename: "shici.sqlite3",
  applicationId: SHICI_APPLICATION_ID,
  seedVersion: 1,
  migrations: [
    {
      version: 1,
      description: "Create the initial reading and vocabulary schema",
      sql: `
        PRAGMA application_id = ${SHICI_APPLICATION_ID};

        CREATE TABLE app_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE learning_profiles (
          id TEXT PRIMARY KEY,
          display_name TEXT NOT NULL,
          native_language TEXT NOT NULL DEFAULT 'zh-CN',
          learning_languages TEXT NOT NULL DEFAULT '["en"]' CHECK (json_valid(learning_languages)),
          daily_review_goal INTEGER NOT NULL DEFAULT 20 CHECK (daily_review_goal >= 0),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE sources (
          id TEXT PRIMARY KEY,
          source_type TEXT NOT NULL CHECK (source_type IN ('article', 'audio', 'video', 'document', 'note')),
          title TEXT NOT NULL,
          subtitle TEXT,
          publisher TEXT,
          author TEXT,
          language TEXT NOT NULL,
          source_url TEXT,
          body_text TEXT NOT NULL DEFAULT '',
          cover_storage_key TEXT,
          estimated_minutes INTEGER CHECK (estimated_minutes IS NULL OR estimated_minutes >= 0),
          word_count INTEGER CHECK (word_count IS NULL OR word_count >= 0),
          status TEXT NOT NULL DEFAULT 'unread' CHECK (status IN ('unread', 'reading', 'completed', 'archived')),
          progress REAL NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 1),
          published_at TEXT,
          last_opened_at TEXT,
          completed_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE source_sections (
          id TEXT PRIMARY KEY,
          source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
          position INTEGER NOT NULL CHECK (position >= 0),
          heading TEXT,
          body_text TEXT NOT NULL DEFAULT '',
          start_ms INTEGER CHECK (start_ms IS NULL OR start_ms >= 0),
          end_ms INTEGER CHECK (end_ms IS NULL OR end_ms >= start_ms),
          created_at TEXT NOT NULL,
          UNIQUE (source_id, position)
        ) STRICT;

        CREATE TABLE audio_assets (
          id TEXT PRIMARY KEY,
          source_id TEXT REFERENCES sources(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          original_filename TEXT,
          storage_key TEXT UNIQUE,
          mime_type TEXT,
          byte_size INTEGER CHECK (byte_size IS NULL OR byte_size >= 0),
          sha256 TEXT,
          duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
          transcript TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'failed', 'missing')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE vocabulary_entries (
          id TEXT PRIMARY KEY,
          term TEXT NOT NULL,
          normalized_term TEXT NOT NULL,
          language TEXT NOT NULL,
          pronunciation TEXT,
          part_of_speech TEXT,
          definition TEXT NOT NULL,
          definition_zh TEXT,
          example_sentence TEXT,
          notes TEXT NOT NULL DEFAULT '',
          tags TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags)),
          mastery_level INTEGER NOT NULL DEFAULT 0 CHECK (mastery_level BETWEEN 0 AND 5),
          is_favorite INTEGER NOT NULL DEFAULT 0 CHECK (is_favorite IN (0, 1)),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (normalized_term, language)
        ) STRICT;

        CREATE TABLE word_occurrences (
          id TEXT PRIMARY KEY,
          vocabulary_id TEXT NOT NULL REFERENCES vocabulary_entries(id) ON DELETE CASCADE,
          source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
          section_id TEXT REFERENCES source_sections(id) ON DELETE SET NULL,
          context_sentence TEXT NOT NULL,
          character_start INTEGER CHECK (character_start IS NULL OR character_start >= 0),
          character_end INTEGER CHECK (character_end IS NULL OR character_end >= character_start),
          encountered_at TEXT NOT NULL,
          UNIQUE (vocabulary_id, source_id, section_id, context_sentence)
        ) STRICT;

        CREATE TABLE review_cards (
          id TEXT PRIMARY KEY,
          vocabulary_id TEXT NOT NULL UNIQUE REFERENCES vocabulary_entries(id) ON DELETE CASCADE,
          due_at TEXT NOT NULL,
          interval_days REAL NOT NULL DEFAULT 0 CHECK (interval_days >= 0),
          ease_factor REAL NOT NULL DEFAULT 2.5 CHECK (ease_factor >= 1.3),
          repetitions INTEGER NOT NULL DEFAULT 0 CHECK (repetitions >= 0),
          lapses INTEGER NOT NULL DEFAULT 0 CHECK (lapses >= 0),
          last_rating INTEGER CHECK (last_rating IS NULL OR last_rating BETWEEN 0 AND 4),
          last_reviewed_at TEXT,
          is_suspended INTEGER NOT NULL DEFAULT 0 CHECK (is_suspended IN (0, 1)),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE review_events (
          id TEXT PRIMARY KEY,
          card_id TEXT NOT NULL REFERENCES review_cards(id) ON DELETE CASCADE,
          rating INTEGER NOT NULL CHECK (rating BETWEEN 0 AND 4),
          response_ms INTEGER CHECK (response_ms IS NULL OR response_ms >= 0),
          previous_interval_days REAL NOT NULL CHECK (previous_interval_days >= 0),
          next_interval_days REAL NOT NULL CHECK (next_interval_days >= 0),
          reviewed_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE study_sessions (
          id TEXT PRIMARY KEY,
          source_id TEXT REFERENCES sources(id) ON DELETE SET NULL,
          mode TEXT NOT NULL CHECK (mode IN ('reading', 'listening', 'review', 'import')),
          started_at TEXT NOT NULL,
          ended_at TEXT,
          active_seconds INTEGER NOT NULL DEFAULT 0 CHECK (active_seconds >= 0),
          new_words INTEGER NOT NULL DEFAULT 0 CHECK (new_words >= 0),
          reviewed_words INTEGER NOT NULL DEFAULT 0 CHECK (reviewed_words >= 0),
          progress_start REAL CHECK (progress_start IS NULL OR progress_start BETWEEN 0 AND 1),
          progress_end REAL CHECK (progress_end IS NULL OR progress_end BETWEEN 0 AND 1),
          created_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE source_bookmarks (
          id TEXT PRIMARY KEY,
          source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
          section_id TEXT REFERENCES source_sections(id) ON DELETE SET NULL,
          label TEXT,
          note TEXT NOT NULL DEFAULT '',
          character_offset INTEGER CHECK (character_offset IS NULL OR character_offset >= 0),
          position_ms INTEGER CHECK (position_ms IS NULL OR position_ms >= 0),
          created_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE vocabulary_collections (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          description TEXT NOT NULL DEFAULT '',
          color TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE collection_entries (
          collection_id TEXT NOT NULL REFERENCES vocabulary_collections(id) ON DELETE CASCADE,
          vocabulary_id TEXT NOT NULL REFERENCES vocabulary_entries(id) ON DELETE CASCADE,
          added_at TEXT NOT NULL,
          PRIMARY KEY (collection_id, vocabulary_id)
        ) STRICT;

        CREATE TABLE shici_settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE INDEX idx_sources_status_updated
          ON sources(status, updated_at DESC);
        CREATE INDEX idx_source_sections_source_position
          ON source_sections(source_id, position);
        CREATE INDEX idx_vocabulary_normalized
          ON vocabulary_entries(language, normalized_term);
        CREATE INDEX idx_vocabulary_mastery_updated
          ON vocabulary_entries(mastery_level, updated_at DESC);
        CREATE INDEX idx_word_occurrences_source
          ON word_occurrences(source_id, encountered_at DESC);
        CREATE INDEX idx_review_cards_due
          ON review_cards(due_at)
          WHERE is_suspended = 0;
        CREATE INDEX idx_review_events_card_time
          ON review_events(card_id, reviewed_at DESC);
        CREATE INDEX idx_study_sessions_started
          ON study_sessions(started_at DESC);
        CREATE INDEX idx_source_bookmarks_source
          ON source_bookmarks(source_id, created_at DESC);
      `,
    },
  ],
  seedSql: `
    INSERT INTO learning_profiles (
      id, display_name, native_language, learning_languages, daily_review_goal, created_at, updated_at
    ) VALUES (
      'profile-default', 'Learner', 'zh-CN', '["en"]', 20,
      '2026-08-01T09:00:00.000Z', '2026-08-21T08:00:00.000Z'
    ) ON CONFLICT(id) DO NOTHING;

    INSERT INTO sources (
      id, source_type, title, subtitle, publisher, author, language, source_url, body_text,
      estimated_minutes, word_count, status, progress, published_at, last_opened_at, created_at, updated_at
    ) VALUES (
      'source-slowly', 'article', 'The surprising value of doing things slowly',
      'In a culture obsessed with speed, a quieter movement is asking what we lose when every moment becomes a race.',
      'The Atlantic', 'Anna Moreau', 'en', 'https://example.test/articles/doing-things-slowly',
      'We have learned to treat speed as a virtue in itself. Messages should be answered instantly, meals delivered in minutes, and ideas transformed into outcomes before they have had time to fully form. But a growing number of people are beginning to question that rhythm. They are not rejecting ambition. Instead, they are becoming more deliberate about where their attention goes—and what deserves to unfold without being rushed. Slowness, in this sense, is not the absence of progress. It is the decision to notice the texture of an experience while it is still happening.',
      12, 428, 'reading', 0.37, '2026-08-18T00:00:00.000Z', '2026-08-21T07:42:00.000Z',
      '2026-08-18T01:00:00.000Z', '2026-08-21T07:42:00.000Z'
    ) ON CONFLICT(id) DO NOTHING;

    INSERT INTO source_sections (id, source_id, position, heading, body_text, created_at) VALUES
      ('section-slowly-1', 'source-slowly', 0, 'The quiet shift', 'We have learned to treat speed as a virtue in itself. Messages should be answered instantly, meals delivered in minutes, and ideas transformed into outcomes before they have had time to fully form.', '2026-08-18T01:00:00.000Z'),
      ('section-slowly-2', 'source-slowly', 1, 'A different rhythm', 'But a growing number of people are beginning to question that rhythm. They are not rejecting ambition. Instead, they are becoming more deliberate about where their attention goes—and what deserves to unfold without being rushed.', '2026-08-18T01:00:00.000Z'),
      ('section-slowly-3', 'source-slowly', 2, 'What we carry', 'Slowness, in this sense, is not the absence of progress. It is the decision to notice the texture of an experience while it is still happening.', '2026-08-18T01:00:00.000Z'),
      ('section-slowly-4', 'source-slowly', 3, 'Looking forward', 'A deliberate pace can make space for attention, memory, and better choices.', '2026-08-18T01:00:00.000Z')
    ON CONFLICT(id) DO NOTHING;

    INSERT INTO vocabulary_entries (
      id, term, normalized_term, language, pronunciation, part_of_speech, definition, definition_zh,
      example_sentence, notes, tags, mastery_level, is_favorite, created_at, updated_at
    ) VALUES
      ('word-deliberate', 'deliberate', 'deliberate', 'en', '/dɪˈlɪbərət/', 'adjective', 'done consciously and with careful consideration, rather than by accident or in a hurry', '深思熟虑的；从容审慎的', 'They are becoming more deliberate about where their attention goes.', '在本文语境中强调有意识地选择注意力。', '["attention","pace"]', 1, 1, '2026-08-21T07:25:00.000Z', '2026-08-21T07:25:00.000Z'),
      ('word-virtue', 'virtue', 'virtue', 'en', '/ˈvɜːrtʃuː/', 'noun', 'a good quality or useful advantage', '美德；优点', 'We have learned to treat speed as a virtue in itself.', '', '["culture"]', 2, 0, '2026-08-21T07:17:00.000Z', '2026-08-21T07:17:00.000Z'),
      ('word-obsessed', 'obsessed', 'obsessed', 'en', '/əbˈsest/', 'adjective', 'unable to stop thinking about something', '着迷的；过度关注的', 'In a culture obsessed with speed, every moment can feel like a race.', '', '["attention"]', 1, 0, '2026-08-21T07:19:00.000Z', '2026-08-21T07:19:00.000Z'),
      ('word-transform', 'transform', 'transform', 'en', '/trænsˈfɔːrm/', 'verb', 'to change something completely in form or character', '彻底改变；转化', 'Ideas are transformed into outcomes before they fully form.', '', '["change"]', 2, 0, '2026-08-21T07:21:00.000Z', '2026-08-21T07:21:00.000Z'),
      ('word-unfold', 'unfold', 'unfold', 'en', '/ʌnˈfoʊld/', 'verb', 'to develop or become clear gradually', '逐渐展开；呈现', 'Some things deserve to unfold without being rushed.', '', '["pace"]', 1, 1, '2026-08-21T07:28:00.000Z', '2026-08-21T07:28:00.000Z'),
      ('word-texture', 'texture', 'texture', 'en', '/ˈtekstʃər/', 'noun', 'the distinctive quality or feel of something', '质感；特质', 'Notice the texture of an experience while it is happening.', '', '["experience"]', 0, 0, '2026-08-21T07:31:00.000Z', '2026-08-21T07:31:00.000Z')
    ON CONFLICT(id) DO NOTHING;

    INSERT INTO word_occurrences (
      id, vocabulary_id, source_id, section_id, context_sentence, character_start, character_end, encountered_at
    ) VALUES
      ('occurrence-deliberate', 'word-deliberate', 'source-slowly', 'section-slowly-2', 'They are becoming more deliberate about where their attention goes.', 24, 34, '2026-08-21T07:25:00.000Z'),
      ('occurrence-virtue', 'word-virtue', 'source-slowly', 'section-slowly-1', 'We have learned to treat speed as a virtue in itself.', 36, 42, '2026-08-21T07:17:00.000Z'),
      ('occurrence-obsessed', 'word-obsessed', 'source-slowly', 'section-slowly-1', 'In a culture obsessed with speed, every moment can feel like a race.', 13, 21, '2026-08-21T07:19:00.000Z'),
      ('occurrence-transform', 'word-transform', 'source-slowly', 'section-slowly-1', 'Ideas are transformed into outcomes before they fully form.', 10, 21, '2026-08-21T07:21:00.000Z'),
      ('occurrence-unfold', 'word-unfold', 'source-slowly', 'section-slowly-2', 'Some things deserve to unfold without being rushed.', 23, 29, '2026-08-21T07:28:00.000Z'),
      ('occurrence-texture', 'word-texture', 'source-slowly', 'section-slowly-3', 'Notice the texture of an experience while it is happening.', 11, 18, '2026-08-21T07:31:00.000Z')
    ON CONFLICT(id) DO NOTHING;

    INSERT INTO review_cards (
      id, vocabulary_id, due_at, interval_days, ease_factor, repetitions, lapses,
      last_rating, last_reviewed_at, is_suspended, created_at, updated_at
    ) VALUES
      ('card-deliberate', 'word-deliberate', '2026-08-21T12:00:00.000Z', 1, 2.50, 0, 0, NULL, NULL, 0, '2026-08-21T07:25:00.000Z', '2026-08-21T07:25:00.000Z'),
      ('card-virtue', 'word-virtue', '2026-08-22T00:00:00.000Z', 3, 2.60, 2, 0, 3, '2026-08-19T02:00:00.000Z', 0, '2026-08-17T02:00:00.000Z', '2026-08-19T02:00:00.000Z'),
      ('card-obsessed', 'word-obsessed', '2026-08-21T12:00:00.000Z', 1, 2.40, 1, 1, 2, '2026-08-20T02:00:00.000Z', 0, '2026-08-19T02:00:00.000Z', '2026-08-20T02:00:00.000Z'),
      ('card-transform', 'word-transform', '2026-08-23T00:00:00.000Z', 4, 2.70, 2, 0, 4, '2026-08-19T02:05:00.000Z', 0, '2026-08-17T02:05:00.000Z', '2026-08-19T02:05:00.000Z'),
      ('card-unfold', 'word-unfold', '2026-08-21T12:00:00.000Z', 0, 2.50, 0, 0, NULL, NULL, 0, '2026-08-21T07:28:00.000Z', '2026-08-21T07:28:00.000Z'),
      ('card-texture', 'word-texture', '2026-08-21T12:00:00.000Z', 0, 2.50, 0, 0, NULL, NULL, 0, '2026-08-21T07:31:00.000Z', '2026-08-21T07:31:00.000Z')
    ON CONFLICT(id) DO NOTHING;

    INSERT INTO study_sessions (
      id, source_id, mode, started_at, ended_at, active_seconds, new_words,
      reviewed_words, progress_start, progress_end, created_at
    ) VALUES (
      'session-slowly-20260821', 'source-slowly', 'reading', '2026-08-21T07:24:00.000Z',
      '2026-08-21T07:42:00.000Z', 1080, 6, 0, 0.12, 0.37, '2026-08-21T07:24:00.000Z'
    ) ON CONFLICT(id) DO NOTHING;

    INSERT INTO source_bookmarks (
      id, source_id, section_id, label, note, character_offset, created_at
    ) VALUES (
      'bookmark-deliberate', 'source-slowly', 'section-slowly-2', 'A different rhythm',
      '回看 deliberate 在注意力语境中的用法。', 118, '2026-08-21T07:26:00.000Z'
    ) ON CONFLICT(id) DO NOTHING;

    INSERT INTO vocabulary_collections (id, name, description, color, created_at, updated_at) VALUES
      ('collection-current-reading', '本周阅读', '本周阅读材料中遇到的词。', '#9A6A44', '2026-08-18T01:00:00.000Z', '2026-08-21T07:31:00.000Z')
    ON CONFLICT(id) DO NOTHING;

    INSERT INTO collection_entries (collection_id, vocabulary_id, added_at) VALUES
      ('collection-current-reading', 'word-deliberate', '2026-08-21T07:25:00.000Z'),
      ('collection-current-reading', 'word-virtue', '2026-08-21T07:17:00.000Z'),
      ('collection-current-reading', 'word-obsessed', '2026-08-21T07:19:00.000Z'),
      ('collection-current-reading', 'word-transform', '2026-08-21T07:21:00.000Z'),
      ('collection-current-reading', 'word-unfold', '2026-08-21T07:28:00.000Z'),
      ('collection-current-reading', 'word-texture', '2026-08-21T07:31:00.000Z')
    ON CONFLICT(collection_id, vocabulary_id) DO NOTHING;

    INSERT INTO shici_settings (key, value, updated_at) VALUES
      ('show_chinese_definitions', 'false', '2026-08-21T07:00:00.000Z'),
      ('playback_rate', '1', '2026-08-21T07:00:00.000Z'),
      ('review_order', 'due_first', '2026-08-21T07:00:00.000Z')
    ON CONFLICT(key) DO NOTHING;
  `,
};
