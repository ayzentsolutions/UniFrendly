BEGIN;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS institutions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug = lower(slug) AND slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','closed')),
  config jsonb NOT NULL DEFAULT '{"imageMaxBytes":1048576,"imagesPerPost":4,"pdfMaxBytes":10485760,"studentQuotaBytes":52428800,"storyTtlHours":24,"listingTtlDays":30,"notificationRetentionDays":90,"temporaryUploadTtlHours":24}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS app_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 80),
  password_hash text,
  account_status text NOT NULL DEFAULT 'active' CHECK (account_status IN ('active','locked','deleted')),
  age_band text NOT NULL DEFAULT 'adult' CHECK (age_band IN ('under_18','adult','unknown')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'student' CHECK (role IN ('student','alumni','institution_admin','moderator')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','suspended','expired','revoked')),
  student_ref_hash text,
  verified_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (institution_id, user_id),
  UNIQUE (institution_id, id)
);
CREATE INDEX IF NOT EXISTS memberships_user_status_idx ON memberships(user_id, status);
CREATE TABLE IF NOT EXISTS institution_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  email text NOT NULL,
  role text NOT NULL DEFAULT 'student' CHECK (role IN ('student','alumni','moderator','institution_admin')),
  roster_ref text,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS invitations_email_idx ON institution_invitations(institution_id, lower(email), expires_at) WHERE used_at IS NULL;
CREATE TABLE IF NOT EXISTS auth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  membership_id uuid NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  refresh_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_membership_idx ON auth_sessions(membership_id, expires_at) WHERE revoked_at IS NULL;
CREATE TABLE IF NOT EXISTS profiles (
  membership_id uuid PRIMARY KEY REFERENCES memberships(id) ON DELETE CASCADE,
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  department text CHECK (department IS NULL OR char_length(department) <= 120),
  programme text CHECK (programme IS NULL OR char_length(programme) <= 120),
  batch_year smallint CHECK (batch_year IS NULL OR batch_year BETWEEN 1950 AND 2150),
  bio text NOT NULL DEFAULT '' CHECK (char_length(bio) <= 500),
  interests text[] NOT NULL DEFAULT '{}',
  visibility text NOT NULL DEFAULT 'campus' CHECK (visibility IN ('private','connections','campus')),
  discoverable boolean NOT NULL DEFAULT false,
  allow_messages text NOT NULL DEFAULT 'connections' CHECK (allow_messages IN ('nobody','connections','campus')),
  avatar_media_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS profiles_discovery_idx ON profiles(institution_id, department, programme, batch_year) WHERE discoverable = true;

CREATE TABLE IF NOT EXISTS media_usage (
  membership_id uuid PRIMARY KEY REFERENCES memberships(id) ON DELETE CASCADE,
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  quota_bytes bigint NOT NULL DEFAULT 52428800 CHECK (quota_bytes >= 0),
  used_bytes bigint NOT NULL DEFAULT 0 CHECK (used_bytes >= 0),
  reserved_bytes bigint NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (used_bytes + reserved_bytes <= quota_bytes)
);
CREATE TABLE IF NOT EXISTS media_uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  membership_id uuid NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  object_key text NOT NULL UNIQUE,
  original_name text NOT NULL,
  declared_mime text NOT NULL,
  expected_bytes bigint NOT NULL CHECK (expected_bytes > 0),
  media_kind text NOT NULL CHECK (media_kind IN ('image','pdf','avatar','attachment')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','rejected','expired')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS media_upload_cleanup_idx ON media_uploads(expires_at) WHERE status = 'pending';
CREATE TABLE IF NOT EXISTS media_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  membership_id uuid NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  upload_id uuid UNIQUE REFERENCES media_uploads(id) ON DELETE SET NULL,
  object_key text NOT NULL UNIQUE,
  mime_type text NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size > 0),
  media_kind text NOT NULL CHECK (media_kind IN ('image','pdf','avatar','attachment')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','pending_delete','deleted','quarantined')),
  delete_after timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS media_owner_idx ON media_assets(institution_id, membership_id, status);

CREATE TABLE IF NOT EXISTS posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  author_membership_id uuid NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  body text NOT NULL DEFAULT '' CHECK (char_length(body) <= 5000),
  visibility text NOT NULL DEFAULT 'campus' CHECK (visibility IN ('campus','connections')),
  story_expires_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (char_length(body) > 0 OR id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS posts_feed_idx ON posts(institution_id, created_at DESC, id DESC) WHERE deleted_at IS NULL AND story_expires_at IS NULL;
CREATE INDEX IF NOT EXISTS posts_story_idx ON posts(institution_id, story_expires_at) WHERE story_expires_at IS NOT NULL AND deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS post_media (
  post_id uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  media_id uuid NOT NULL REFERENCES media_assets(id) ON DELETE RESTRICT,
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  position smallint NOT NULL CHECK (position BETWEEN 0 AND 3),
  PRIMARY KEY (post_id, media_id),
  UNIQUE (post_id, position)
);
CREATE TABLE IF NOT EXISTS post_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  post_id uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  author_membership_id uuid NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS comments_post_idx ON post_comments(institution_id, post_id, created_at) WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS post_reactions (
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  post_id uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  membership_id uuid NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  reaction text NOT NULL CHECK (reaction IN ('like','love','laugh','support','insightful')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, membership_id)
);
CREATE TABLE IF NOT EXISTS post_bookmarks (
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  post_id uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  membership_id uuid NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, membership_id)
);
CREATE TABLE IF NOT EXISTS follows (
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  follower_membership_id uuid NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  followed_membership_id uuid NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_membership_id, followed_membership_id),
  CHECK (follower_membership_id <> followed_membership_id)
);
CREATE INDEX IF NOT EXISTS follows_target_idx ON follows(institution_id, followed_membership_id, status);
CREATE TABLE IF NOT EXISTS blocks (
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  blocker_membership_id uuid NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  blocked_membership_id uuid NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_membership_id, blocked_membership_id),
  CHECK (blocker_membership_id <> blocked_membership_id)
);
CREATE TABLE IF NOT EXISTS conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('direct','group')),
  title text CHECK (title IS NULL OR char_length(title) <= 100),
  created_by uuid NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS conversation_members (
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  membership_id uuid NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('member','admin')),
  request_status text NOT NULL DEFAULT 'accepted' CHECK (request_status IN ('pending','accepted','rejected')),
  last_read_at timestamptz,
  left_at timestamptz,
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, membership_id)
);
CREATE INDEX IF NOT EXISTS conversation_member_inbox_idx ON conversation_members(institution_id, membership_id, joined_at DESC) WHERE left_at IS NULL;
CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_membership_id uuid NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  client_message_id uuid NOT NULL,
  body text NOT NULL DEFAULT '' CHECK (char_length(body) <= 5000),
  attachment_media_id uuid REFERENCES media_assets(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (sender_membership_id, client_message_id),
  CHECK (char_length(body) > 0 OR attachment_media_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS messages_conversation_cursor_idx ON messages(institution_id, conversation_id, created_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS study_resources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  contributor_membership_id uuid NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  media_id uuid NOT NULL UNIQUE REFERENCES media_assets(id) ON DELETE RESTRICT,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 160),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 1000),
  subject text NOT NULL CHECK (char_length(subject) <= 120),
  semester text CHECK (semester IS NULL OR char_length(semester) <= 40),
  programme text CHECK (programme IS NULL OR char_length(programme) <= 120),
  visibility text NOT NULL DEFAULT 'campus' CHECK (visibility IN ('campus','connections')),
  status text NOT NULL DEFAULT 'pending_review' CHECK (status IN ('pending_review','approved','rejected','removed')),
  report_count integer NOT NULL DEFAULT 0 CHECK (report_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS study_search_idx ON study_resources(institution_id, subject, semester, created_at DESC) WHERE status = 'approved';
CREATE TABLE IF NOT EXISTS campus_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  creator_membership_id uuid NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 160),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 4000),
  club_name text CHECK (club_name IS NULL OR char_length(club_name) <= 120),
  location_label text CHECK (location_label IS NULL OR char_length(location_label) <= 160),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  capacity integer CHECK (capacity IS NULL OR capacity BETWEEN 1 AND 100000),
  status text NOT NULL DEFAULT 'published' CHECK (status IN ('draft','published','cancelled','completed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS events_listing_idx ON campus_events(institution_id, starts_at) WHERE status = 'published';
CREATE TABLE IF NOT EXISTS event_registrations (
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  event_id uuid NOT NULL REFERENCES campus_events(id) ON DELETE CASCADE,
  membership_id uuid NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'registered' CHECK (status IN ('registered','cancelled','attended')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, membership_id)
);
CREATE TABLE IF NOT EXISTS marketplace_listings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  seller_membership_id uuid NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 2000),
  category text NOT NULL CHECK (category IN ('used_books','stationery','permitted_service','canteen','lost_found')),
  price_minor integer CHECK (price_minor IS NULL OR price_minor >= 0),
  currency char(3) NOT NULL DEFAULT 'INR',
  media_id uuid REFERENCES media_assets(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','sold','expired','removed','pending_review')),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS marketplace_listing_idx ON marketplace_listings(institution_id, category, created_at DESC) WHERE status = 'active';
CREATE TABLE IF NOT EXISTS user_settings (
  membership_id uuid PRIMARY KEY REFERENCES memberships(id) ON DELETE CASCADE,
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  push_enabled boolean NOT NULL DEFAULT true,
  notify_messages boolean NOT NULL DEFAULT true,
  notify_connections boolean NOT NULL DEFAULT true,
  notify_events boolean NOT NULL DEFAULT true,
  notify_study boolean NOT NULL DEFAULT false,
  notify_marketplace boolean NOT NULL DEFAULT false,
  private_message_previews boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS device_push_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  membership_id uuid NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  token text NOT NULL UNIQUE,
  platform text NOT NULL CHECK (platform IN ('ios','android')),
  active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  recipient_membership_id uuid NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  actor_membership_id uuid REFERENCES memberships(id) ON DELETE SET NULL,
  category text NOT NULL CHECK (category IN ('message','connection','comment','reaction','event','study','marketplace','system','moderation')),
  title text NOT NULL CHECK (char_length(title) <= 120),
  body text NOT NULL DEFAULT '' CHECK (char_length(body) <= 240),
  resource_type text,
  resource_id uuid,
  dedupe_key text NOT NULL,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '90 days'),
  push_status text NOT NULL DEFAULT 'pending' CHECK (push_status IN ('pending','processing','sent','skipped','failed')),
  push_attempts integer NOT NULL DEFAULT 0 CHECK (push_attempts >= 0),
  push_available_at timestamptz NOT NULL DEFAULT now(),
  push_sent_at timestamptz,
  push_last_error text,
  UNIQUE (recipient_membership_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS notifications_inbox_idx ON notifications(institution_id, recipient_membership_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_push_idx ON notifications(push_available_at, created_at) WHERE push_status IN ('pending','processing');

-- Apply each institution's retention setting server-side for every new notification.
CREATE OR REPLACE FUNCTION set_notification_retention() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE retention_days integer;
BEGIN
  SELECT CASE
    WHEN config->>'notificationRetentionDays' ~ '^[0-9]{1,4}$'
      THEN GREATEST(1, LEAST(3650, (config->>'notificationRetentionDays')::integer))
    ELSE 90
  END INTO retention_days
  FROM institutions WHERE id = NEW.institution_id;
  NEW.expires_at := COALESCE(NEW.created_at, now()) + make_interval(days => COALESCE(retention_days, 90));
  RETURN NEW;
END $$;
CREATE TRIGGER notifications_retention_before_insert
  BEFORE INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION set_notification_retention();
CREATE TABLE IF NOT EXISTS reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  reporter_membership_id uuid NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  target_type text NOT NULL CHECK (target_type IN ('post','comment','profile','message','study_resource','event','listing')),
  target_id uuid NOT NULL,
  reason text NOT NULL CHECK (reason IN ('spam','harassment','unsafe','copyright','fraud','privacy','other')),
  details text NOT NULL DEFAULT '' CHECK (char_length(details) <= 1000),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_review','actioned','dismissed','appealed')),
  assigned_to uuid REFERENCES memberships(id) ON DELETE SET NULL,
  resolution text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reports_queue_idx ON reports(institution_id, status, created_at) WHERE status IN ('open','in_review','appealed');
CREATE UNIQUE INDEX IF NOT EXISTS reports_one_open_per_reporter_idx ON reports(reporter_membership_id, target_type, target_id) WHERE status IN ('open','in_review','appealed');
CREATE TABLE IF NOT EXISTS outbox_events (
  id bigserial PRIMARY KEY,
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  dedupe_key text NOT NULL UNIQUE,
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  delivered_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS outbox_pending_idx ON outbox_events(available_at, id) WHERE delivered_at IS NULL;
CREATE TABLE IF NOT EXISTS audit_logs (
  id bigserial PRIMARY KEY,
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  actor_membership_id uuid REFERENCES memberships(id) ON DELETE SET NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_logs_tenant_idx ON audit_logs(institution_id, created_at DESC);

-- Tenant-scoped tables are protected by PostgreSQL RLS. The API sets app.institution_id
-- locally for each tenant query; no client-supplied institution ID is used as authority.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'profiles','media_usage','media_uploads','media_assets','posts','post_media','post_comments',
    'post_reactions','post_bookmarks','follows','blocks','conversations','conversation_members',
    'messages','study_resources','campus_events','event_registrations','marketplace_listings',
    'user_settings','device_push_tokens','notifications','reports','outbox_events','audit_logs'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (institution_id = nullif(current_setting(''app.institution_id'', true), '''')::uuid) WITH CHECK (institution_id = nullif(current_setting(''app.institution_id'', true), '''')::uuid)', t);
  END LOOP;
END $$;

COMMIT;
