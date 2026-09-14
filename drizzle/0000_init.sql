CREATE TABLE "ad_stats" (
	"id" serial PRIMARY KEY NOT NULL,
	"ad_id" integer NOT NULL,
	"day" date NOT NULL,
	"impressions" integer DEFAULT 0 NOT NULL,
	"clicks" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_audit_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"actor_id" integer,
	"actor_username" varchar(32) NOT NULL,
	"action" varchar(32) NOT NULL,
	"target_id" integer,
	"target_username" varchar(32),
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ads" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" varchar(8) DEFAULT 'general' NOT NULL,
	"slot" varchar(8) DEFAULT 'any' NOT NULL,
	"status" varchar(8) DEFAULT 'draft' NOT NULL,
	"headline" varchar(120) NOT NULL,
	"body" varchar(240) NOT NULL,
	"cta_label" varchar(40) NOT NULL,
	"target_url" text NOT NULL,
	"creator_name" varchar(120),
	"project_kind" varchar(12),
	"label" varchar(120),
	"genres" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"weight" smallint DEFAULT 1 NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"impressions" integer DEFAULT 0 NOT NULL,
	"clicks" integer DEFAULT 0 NOT NULL,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "albums" (
	"id" serial PRIMARY KEY NOT NULL,
	"deezer_id" text NOT NULL,
	"mbid" text,
	"artist_id" integer NOT NULL,
	"title" varchar(300) NOT NULL,
	"slug" text NOT NULL,
	"cover_path" text,
	"release_date" date,
	"original_release_date" date,
	"record_type" varchar(12) DEFAULT 'album' NOT NULL,
	"secondary_types" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_canonical" boolean DEFAULT true NOT NULL,
	"label" varchar(200),
	"upc" varchar(20),
	"explicit" boolean DEFAULT false NOT NULL,
	"genres" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"track_count" integer DEFAULT 0 NOT NULL,
	"disc_count" integer DEFAULT 1 NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"mean_track_ms" integer DEFAULT 0 NOT NULL,
	"fans" integer DEFAULT 0 NOT NULL,
	"popularity" integer DEFAULT 0 NOT NULL,
	"critic_score" real,
	"critic_votes" integer DEFAULT 0 NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tracks_synced_at" timestamp with time zone,
	"mb_synced_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "artist_similar" (
	"artist_id" integer NOT NULL,
	"similar_id" integer NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"source" varchar(12) DEFAULT 'deezer' NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artist_similar_artist_id_similar_id_pk" PRIMARY KEY("artist_id","similar_id")
);
--> statement-breakpoint
CREATE TABLE "artists" (
	"id" serial PRIMARY KEY NOT NULL,
	"deezer_id" text NOT NULL,
	"mbid" text,
	"name" varchar(200) NOT NULL,
	"slug" text NOT NULL,
	"picture_path" text,
	"bio" text,
	"country" varchar(2),
	"began_on" date,
	"ended_on" date,
	"genres" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fans" integer DEFAULT 0 NOT NULL,
	"album_count" integer DEFAULT 0 NOT NULL,
	"critic_score" real,
	"critic_votes" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"mb_synced_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"target_type" varchar(8) NOT NULL,
	"target_id" integer NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credits" (
	"id" serial PRIMARY KEY NOT NULL,
	"album_id" integer NOT NULL,
	"person_id" text NOT NULL,
	"name" varchar(200) NOT NULL,
	"picture_path" text,
	"role" varchar(40),
	"kind" varchar(8) NOT NULL,
	"credit_order" integer DEFAULT 999 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "desert_island" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"artist_id" integer NOT NULL,
	"album_id" integer NOT NULL,
	"disc_number" integer NOT NULL,
	"track_number" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_verification_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"token_hash" text NOT NULL,
	"email" varchar(255) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "favorites" (
	"user_id" integer NOT NULL,
	"position" smallint NOT NULL,
	"album_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "favorites_user_id_position_pk" PRIMARY KEY("user_id","position")
);
--> statement-breakpoint
CREATE TABLE "follows" (
	"follower_id" integer NOT NULL,
	"followee_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "follows_follower_id_followee_id_pk" PRIMARY KEY("follower_id","followee_id")
);
--> statement-breakpoint
CREATE TABLE "likes" (
	"user_id" integer NOT NULL,
	"target_type" varchar(8) NOT NULL,
	"target_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "likes_user_id_target_type_target_id_pk" PRIMARY KEY("user_id","target_type","target_id")
);
--> statement-breakpoint
CREATE TABLE "list_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"list_id" integer NOT NULL,
	"target_type" varchar(8) NOT NULL,
	"artist_id" integer NOT NULL,
	"album_id" integer,
	"disc_number" integer,
	"track_number" integer,
	"position" integer DEFAULT 0 NOT NULL,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "lists" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"title" varchar(120) NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"is_ranked" boolean DEFAULT false NOT NULL,
	"is_public" boolean DEFAULT true NOT NULL,
	"cloned_from_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "log_tags" (
	"log_id" integer NOT NULL,
	"tag" varchar(32) NOT NULL,
	CONSTRAINT "log_tags_log_id_tag_pk" PRIMARY KEY("log_id","tag")
);
--> statement-breakpoint
CREATE TABLE "logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"target_type" varchar(8) NOT NULL,
	"artist_id" integer NOT NULL,
	"album_id" integer,
	"disc_number" integer,
	"track_number" integer,
	"rating" smallint,
	"review" text,
	"listened_on" date,
	"is_replay" boolean DEFAULT false NOT NULL,
	"liked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "password_reset_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"token_hash" text NOT NULL,
	"email" varchar(255) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"key" text PRIMARY KEY NOT NULL,
	"window_start" timestamp with time zone DEFAULT now() NOT NULL,
	"count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tracks" (
	"id" serial PRIMARY KEY NOT NULL,
	"album_id" integer NOT NULL,
	"artist_id" integer NOT NULL,
	"deezer_id" text NOT NULL,
	"disc_number" integer DEFAULT 1 NOT NULL,
	"track_number" integer NOT NULL,
	"title" varchar(300) NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"isrc" varchar(15),
	"explicit" boolean DEFAULT false NOT NULL,
	"preview_url" text,
	"popularity" integer DEFAULT 0 NOT NULL,
	"critic_score" real,
	"critic_votes" integer DEFAULT 0 NOT NULL,
	"artist_name" varchar(200)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"username" varchar(32) NOT NULL,
	"email" varchar(255) NOT NULL,
	"password_hash" text NOT NULL,
	"display_name" varchar(64),
	"bio" text,
	"avatar_seed" varchar(32),
	"email_verified_at" timestamp with time zone,
	"role" varchar(16) DEFAULT 'member' NOT NULL,
	"is_guest" boolean DEFAULT false NOT NULL,
	"plan" varchar(16) DEFAULT 'free' NOT NULL,
	"plan_updated_at" timestamp with time zone,
	"wantlist_private" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wantlist" (
	"user_id" integer NOT NULL,
	"album_id" integer NOT NULL,
	"note" text,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wantlist_user_id_album_id_pk" PRIMARY KEY("user_id","album_id")
);
--> statement-breakpoint
ALTER TABLE "ad_stats" ADD CONSTRAINT "ad_stats_ad_id_ads_id_fk" FOREIGN KEY ("ad_id") REFERENCES "public"."ads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ads" ADD CONSTRAINT "ads_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "albums" ADD CONSTRAINT "albums_artist_id_artists_id_fk" FOREIGN KEY ("artist_id") REFERENCES "public"."artists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artist_similar" ADD CONSTRAINT "artist_similar_artist_id_artists_id_fk" FOREIGN KEY ("artist_id") REFERENCES "public"."artists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artist_similar" ADD CONSTRAINT "artist_similar_similar_id_artists_id_fk" FOREIGN KEY ("similar_id") REFERENCES "public"."artists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credits" ADD CONSTRAINT "credits_album_id_albums_id_fk" FOREIGN KEY ("album_id") REFERENCES "public"."albums"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "desert_island" ADD CONSTRAINT "desert_island_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "desert_island" ADD CONSTRAINT "desert_island_artist_id_artists_id_fk" FOREIGN KEY ("artist_id") REFERENCES "public"."artists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "desert_island" ADD CONSTRAINT "desert_island_album_id_albums_id_fk" FOREIGN KEY ("album_id") REFERENCES "public"."albums"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_verification_tokens" ADD CONSTRAINT "email_verification_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "favorites" ADD CONSTRAINT "favorites_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "favorites" ADD CONSTRAINT "favorites_album_id_albums_id_fk" FOREIGN KEY ("album_id") REFERENCES "public"."albums"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follows" ADD CONSTRAINT "follows_follower_id_users_id_fk" FOREIGN KEY ("follower_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follows" ADD CONSTRAINT "follows_followee_id_users_id_fk" FOREIGN KEY ("followee_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "likes" ADD CONSTRAINT "likes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "list_items" ADD CONSTRAINT "list_items_list_id_lists_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."lists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "list_items" ADD CONSTRAINT "list_items_artist_id_artists_id_fk" FOREIGN KEY ("artist_id") REFERENCES "public"."artists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "list_items" ADD CONSTRAINT "list_items_album_id_albums_id_fk" FOREIGN KEY ("album_id") REFERENCES "public"."albums"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lists" ADD CONSTRAINT "lists_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "log_tags" ADD CONSTRAINT "log_tags_log_id_logs_id_fk" FOREIGN KEY ("log_id") REFERENCES "public"."logs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logs" ADD CONSTRAINT "logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logs" ADD CONSTRAINT "logs_artist_id_artists_id_fk" FOREIGN KEY ("artist_id") REFERENCES "public"."artists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logs" ADD CONSTRAINT "logs_album_id_albums_id_fk" FOREIGN KEY ("album_id") REFERENCES "public"."albums"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracks" ADD CONSTRAINT "tracks_album_id_albums_id_fk" FOREIGN KEY ("album_id") REFERENCES "public"."albums"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracks" ADD CONSTRAINT "tracks_artist_id_artists_id_fk" FOREIGN KEY ("artist_id") REFERENCES "public"."artists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wantlist" ADD CONSTRAINT "wantlist_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wantlist" ADD CONSTRAINT "wantlist_album_id_albums_id_fk" FOREIGN KEY ("album_id") REFERENCES "public"."albums"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ad_stats_ad_day_uq" ON "ad_stats" USING btree ("ad_id","day");--> statement-breakpoint
CREATE INDEX "admin_audit_created_idx" ON "admin_audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "ads_status_kind_slot_idx" ON "ads" USING btree ("status","kind","slot");--> statement-breakpoint
CREATE UNIQUE INDEX "albums_deezer_id_uq" ON "albums" USING btree ("deezer_id");--> statement-breakpoint
CREATE INDEX "albums_artist_idx" ON "albums" USING btree ("artist_id");--> statement-breakpoint
CREATE INDEX "albums_slug_idx" ON "albums" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "albums_popularity_idx" ON "albums" USING btree ("popularity");--> statement-breakpoint
CREATE INDEX "albums_release_idx" ON "albums" USING btree ("release_date");--> statement-breakpoint
CREATE INDEX "albums_artist_release_idx" ON "albums" USING btree ("artist_id","release_date");--> statement-breakpoint
CREATE INDEX "albums_canonical_popularity_idx" ON "albums" USING btree ("is_canonical","popularity");--> statement-breakpoint
CREATE INDEX "artist_similar_position_idx" ON "artist_similar" USING btree ("artist_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "artists_deezer_id_uq" ON "artists" USING btree ("deezer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "artists_mbid_uq" ON "artists" USING btree ("mbid");--> statement-breakpoint
CREATE INDEX "artists_slug_idx" ON "artists" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "artists_fans_idx" ON "artists" USING btree ("fans");--> statement-breakpoint
CREATE INDEX "artists_name_idx" ON "artists" USING btree ("name");--> statement-breakpoint
CREATE INDEX "comments_target_idx" ON "comments" USING btree ("target_type","target_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "credits_album_person_role_uq" ON "credits" USING btree ("album_id","person_id","kind","role");--> statement-breakpoint
CREATE INDEX "credits_album_idx" ON "credits" USING btree ("album_id");--> statement-breakpoint
CREATE UNIQUE INDEX "desert_island_target_uq" ON "desert_island" USING btree ("user_id","album_id","disc_number","track_number");--> statement-breakpoint
CREATE INDEX "desert_island_user_created_idx" ON "desert_island" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "email_verification_token_hash_uq" ON "email_verification_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "email_verification_user_idx" ON "email_verification_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "follows_followee_idx" ON "follows" USING btree ("followee_id");--> statement-breakpoint
CREATE INDEX "likes_target_idx" ON "likes" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE UNIQUE INDEX "list_items_target_uq" ON "list_items" USING btree ("list_id","target_type","artist_id",coalesce("album_id", 0),coalesce("disc_number", 0),coalesce("track_number", 0));--> statement-breakpoint
CREATE INDEX "list_items_list_position_idx" ON "list_items" USING btree ("list_id","position");--> statement-breakpoint
CREATE INDEX "lists_user_updated_idx" ON "lists" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX "lists_public_updated_idx" ON "lists" USING btree ("is_public","updated_at");--> statement-breakpoint
CREATE INDEX "log_tags_tag_idx" ON "log_tags" USING btree ("tag");--> statement-breakpoint
CREATE INDEX "logs_user_created_idx" ON "logs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "logs_user_listened_idx" ON "logs" USING btree ("user_id","listened_on");--> statement-breakpoint
CREATE INDEX "logs_target_user_idx" ON "logs" USING btree ("album_id","disc_number","track_number","user_id","created_at");--> statement-breakpoint
CREATE INDEX "logs_target_rating_idx" ON "logs" USING btree ("album_id","target_type","disc_number","track_number","rating");--> statement-breakpoint
CREATE INDEX "logs_artist_target_idx" ON "logs" USING btree ("artist_id","target_type","user_id","created_at");--> statement-breakpoint
CREATE INDEX "logs_artist_idx" ON "logs" USING btree ("artist_id");--> statement-breakpoint
CREATE INDEX "logs_album_idx" ON "logs" USING btree ("album_id");--> statement-breakpoint
CREATE UNIQUE INDEX "password_reset_token_hash_uq" ON "password_reset_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "password_reset_user_idx" ON "password_reset_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tracks_album_disc_track_uq" ON "tracks" USING btree ("album_id","disc_number","track_number");--> statement-breakpoint
CREATE INDEX "tracks_album_idx" ON "tracks" USING btree ("album_id");--> statement-breakpoint
CREATE INDEX "tracks_artist_idx" ON "tracks" USING btree ("artist_id");--> statement-breakpoint
CREATE INDEX "tracks_deezer_idx" ON "tracks" USING btree ("deezer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_username_lower_uq" ON "users" USING btree (lower("username"));--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_uq" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "wantlist_user_added_idx" ON "wantlist" USING btree ("user_id","added_at");