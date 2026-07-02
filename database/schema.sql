-- =============================================================
--  FALSE LEAD — MVP Database Schema
--  MySQL 8.0+
--  Run this file on a fresh database:
--    mysql -u root -p false_lead < schema.sql
-- =============================================================

CREATE DATABASE IF NOT EXISTS false_lead
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE false_lead;

-- =============================================================
--  TABLE: word_bank
--  Standalone lookup table. Never mutated during gameplay.
--  alternate_word is required for Similar Word rounds.
--  Gemini scripts write here offline; game only reads.
-- =============================================================

CREATE TABLE word_bank (
  id              INT           NOT NULL AUTO_INCREMENT,
  word            VARCHAR(64)   NOT NULL,
  hint            VARCHAR(64)   NOT NULL,
  alternate_word  VARCHAR(64)   NULL DEFAULT NULL,  -- NULL = not usable in Similar Word rounds
  category        VARCHAR(64)   NOT NULL,
  difficulty      ENUM('easy','medium','hard') NOT NULL DEFAULT 'medium',
  is_active       TINYINT(1)    NOT NULL DEFAULT 1, -- soft-disable without deleting

  PRIMARY KEY (id),
  INDEX idx_word_bank_category      (category),
  INDEX idx_word_bank_active        (is_active),
  INDEX idx_word_bank_cat_active    (category, is_active),    -- composite: most common query
  INDEX idx_word_bank_has_alternate (alternate_word(1))       -- quickly filter for Similar Word eligibility
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- =============================================================
--  TABLE: rooms
--  One row per game session. Expires after 2 hours of inactivity.
--  settings_json holds the full host config so we never need a
--  separate settings table.
-- =============================================================

CREATE TABLE rooms (
  id              INT           NOT NULL AUTO_INCREMENT,
  room_code       VARCHAR(8)    NOT NULL,                     -- e.g. "TXQK91", generated server-side
  host_session_id VARCHAR(64)   NOT NULL,                     -- session_token of the player who is host
  status          ENUM('waiting','voting','in_progress','finished') NOT NULL DEFAULT 'waiting',
  preset          ENUM('classic','party','custom') NOT NULL DEFAULT 'classic',
  settings_json   JSON          NOT NULL,                     -- full config snapshot (see architecture doc)
  current_round   TINYINT       NOT NULL DEFAULT 0,
  total_rounds    TINYINT       NOT NULL DEFAULT 3,
  created_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at      TIMESTAMP     NOT NULL DEFAULT (CURRENT_TIMESTAMP + INTERVAL 2 HOUR),

  PRIMARY KEY (id),
  UNIQUE INDEX uidx_rooms_code   (room_code),
  INDEX idx_rooms_status         (status),
  INDEX idx_rooms_expires        (expires_at)                 -- for cleanup job
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- =============================================================
--  TABLE: room_players
--  One row per player per room. No user accounts — identity is
--  entirely the session_token issued at join time.
--  Stored in localStorage client-side for reconnection.
-- =============================================================

CREATE TABLE room_players (
  id              INT           NOT NULL AUTO_INCREMENT,
  room_id         INT           NOT NULL,
  nickname        VARCHAR(32)   NOT NULL,
  session_token   VARCHAR(64)   NOT NULL,                     -- UUID, issued at join, used for reconnect
  is_host         TINYINT(1)    NOT NULL DEFAULT 0,
  score           SMALLINT      NOT NULL DEFAULT 0,           -- cumulative score within this room
  is_connected    TINYINT(1)    NOT NULL DEFAULT 1,           -- flipped on socket disconnect
  joined_at       TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE INDEX uidx_rp_token        (session_token),          -- fastest lookup path (every socket event)
  UNIQUE INDEX uidx_rp_nickname     (room_id, nickname),      -- no duplicate nicknames in same room
  INDEX idx_rp_room                 (room_id),

  CONSTRAINT fk_rp_room
    FOREIGN KEY (room_id) REFERENCES rooms(id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- =============================================================
--  TABLE: rounds
--  One row per round per room.
--  alternate_word only populated for similar_word round type.
--  word/alternate_word are denormalised copies from word_bank
--  so results are stable even if word_bank rows are edited later.
-- =============================================================

CREATE TABLE rounds (
  id              INT           NOT NULL AUTO_INCREMENT,
  room_id         INT           NOT NULL,
  round_number    TINYINT       NOT NULL,
  round_type      ENUM('normal','reverse_spy','similar_word','chaos') NOT NULL DEFAULT 'normal',
  category        VARCHAR(64)   NOT NULL,
  word            VARCHAR(64)   NOT NULL,
  alternate_word  VARCHAR(64)   NULL DEFAULT NULL,            -- similar_word rounds only
  status          ENUM('clue','discussion','voting','results') NOT NULL DEFAULT 'clue',
  started_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at        TIMESTAMP     NULL DEFAULT NULL,

  PRIMARY KEY (id),
  UNIQUE INDEX uidx_rounds_room_num  (room_id, round_number), -- one round-number per room
  INDEX idx_rounds_room              (room_id),
  INDEX idx_rounds_status            (status),

  CONSTRAINT fk_rounds_room
    FOREIGN KEY (room_id) REFERENCES rooms(id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- =============================================================
--  TABLE: round_players
--  One row per player per round. Stores the private info each
--  player received, their role, their clue, and outcome.
--  word_guess only used by imposters at round end.
-- =============================================================

CREATE TABLE round_players (
  id                INT           NOT NULL AUTO_INCREMENT,
  round_id          INT           NOT NULL,
  room_player_id    INT           NOT NULL,
  role              ENUM('normal','imposter','reverse_spy_target','similar_word_target') NOT NULL,
  received_info     VARCHAR(128)  NOT NULL,                   -- exactly what was shown on their screen
  clue_given        VARCHAR(256)  NULL DEFAULT NULL,          -- filled after clue phase
  clue_order        TINYINT       NOT NULL,                   -- 1-based turn position
  word_guess        VARCHAR(64)   NULL DEFAULT NULL,          -- imposter end-of-round guess
  was_voted_out     TINYINT(1)    NOT NULL DEFAULT 0,

  PRIMARY KEY (id),
  UNIQUE INDEX uidx_rp_round_player  (round_id, room_player_id), -- one entry per player per round
  INDEX idx_rp_round                 (round_id),
  INDEX idx_rp_player                (room_player_id),

  CONSTRAINT fk_rp_round
    FOREIGN KEY (round_id) REFERENCES rounds(id)
    ON DELETE CASCADE,
  CONSTRAINT fk_rp_player
    FOREIGN KEY (room_player_id) REFERENCES room_players(id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- =============================================================
--  TABLE: votes
--  One row per vote cast. voter_id and target_id both reference
--  room_players so votes are always scoped to a single room.
--  Unique constraint prevents double-voting.
-- =============================================================

CREATE TABLE votes (
  id              INT           NOT NULL AUTO_INCREMENT,
  round_id        INT           NOT NULL,
  voter_id        INT           NOT NULL,                     -- room_players.id
  target_id       INT           NOT NULL,                     -- room_players.id

  PRIMARY KEY (id),
  UNIQUE INDEX uidx_votes_voter      (round_id, voter_id),    -- one vote per player per round
  INDEX idx_votes_round              (round_id),
  INDEX idx_votes_target             (target_id),             -- count votes against a player quickly

  CONSTRAINT fk_votes_round
    FOREIGN KEY (round_id) REFERENCES rounds(id)
    ON DELETE CASCADE,
  CONSTRAINT fk_votes_voter
    FOREIGN KEY (voter_id) REFERENCES room_players(id)
    ON DELETE CASCADE,
  CONSTRAINT fk_votes_target
    FOREIGN KEY (target_id) REFERENCES room_players(id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- =============================================================
--  TABLE: category_votes
--  Lightweight. Cleared after voting resolves.
--  Kept in DB (not just in-memory) for reconnect safety —
--  if server restarts mid-vote, nothing is lost.
-- =============================================================

CREATE TABLE category_votes (
  id              INT           NOT NULL AUTO_INCREMENT,
  room_id         INT           NOT NULL,
  room_player_id  INT           NOT NULL,
  category        VARCHAR(64)   NOT NULL,

  PRIMARY KEY (id),
  UNIQUE INDEX uidx_cv_player        (room_id, room_player_id), -- one category vote per player per room
  INDEX idx_cv_room                  (room_id),

  CONSTRAINT fk_cv_room
    FOREIGN KEY (room_id) REFERENCES rooms(id)
    ON DELETE CASCADE,
  CONSTRAINT fk_cv_player
    FOREIGN KEY (room_player_id) REFERENCES room_players(id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- =============================================================
--  SEED DATA — word_bank
--  10 categories × ~10 words each = 100 entries to start.
--  alternate_word filled where a good Similar Word pair exists.
--  Expand offline using /database/scripts/generate_words.js
-- =============================================================

INSERT INTO word_bank (word, hint, alternate_word, category, difficulty) VALUES

-- -------------------------
--  FOOD (10 words)
-- -------------------------
('Pizza',        'Italian',    'Burger',       'Food', 'easy'),
('Sushi',        'Japanese',   'Sashimi',      'Food', 'easy'),
('Pasta',        'Noodles',    'Noodles',      'Food', 'easy'),
('Tacos',        'Mexican',    'Burrito',      'Food', 'easy'),
('Croissant',    'Flaky',      'Baguette',     'Food', 'medium'),
('Ramen',        'Broth',      'Pho',          'Food', 'medium'),
('Cheesecake',   'Dessert',    'Tiramisu',     'Food', 'medium'),
('Biryani',      'Spiced',     'Pulao',        'Food', 'medium'),
('Fondue',       'Melted',     'Raclette',     'Food', 'hard'),
('Kimchi',       'Fermented',  NULL,           'Food', 'hard'),

-- -------------------------
--  ANIMALS (10 words)
-- -------------------------
('Tiger',        'Predator',   'Leopard',      'Animals', 'easy'),
('Elephant',     'Trunk',      'Rhinoceros',   'Animals', 'easy'),
('Penguin',      'Antarctic',  'Puffin',       'Animals', 'easy'),
('Shark',        'Ocean',      'Barracuda',    'Animals', 'easy'),
('Giraffe',      'Tall',       'Camel',        'Animals', 'medium'),
('Chameleon',    'Colorful',   'Gecko',        'Animals', 'medium'),
('Platypus',     'Unique',     NULL,           'Animals', 'hard'),
('Cheetah',      'Fastest',    'Jaguar',       'Animals', 'medium'),
('Octopus',      'Tentacles',  'Squid',        'Animals', 'medium'),
('Flamingo',     'Pink',       'Heron',        'Animals', 'easy'),

-- -------------------------
--  SPORTS (10 words)
-- -------------------------
('Cricket',      'Sport',      'Baseball',     'Sports', 'easy'),
('Basketball',   'Hoops',      'Netball',      'Sports', 'easy'),
('Swimming',     'Lanes',      'Diving',       'Sports', 'easy'),
('Wrestling',    'Grapple',    'Judo',         'Sports', 'medium'),
('Archery',      'Arrows',     'Darts',        'Sports', 'medium'),
('Polo',         'Horses',     NULL,           'Sports', 'hard'),
('Fencing',      'Sword',      'Kendo',        'Sports', 'hard'),
('Volleyball',   'Net',        'Badminton',    'Sports', 'easy'),
('Cycling',      'Pedals',     'Triathlon',    'Sports', 'medium'),
('Gymnastics',   'Flexible',   'Acrobatics',  'Sports', 'medium'),

-- -------------------------
--  MOVIES (10 words)
-- -------------------------
('Thriller',     'Suspense',   'Horror',       'Movies', 'easy'),
('Documentary',  'Factual',    NULL,           'Movies', 'medium'),
('Animation',    'Cartoon',    'Anime',        'Movies', 'easy'),
('Western',      'Cowboys',    NULL,           'Movies', 'medium'),
('Heist',        'Robbery',    'Caper',        'Movies', 'medium'),
('Sequel',       'Continues',  'Remake',       'Movies', 'easy'),
('Flashback',    'Memory',     NULL,           'Movies', 'hard'),
('Cameo',        'Surprise',   NULL,           'Movies', 'hard'),
('Blockbuster',  'Huge',       NULL,           'Movies', 'easy'),
('Cliffhanger',  'Ending',     NULL,           'Movies', 'medium'),

-- -------------------------
--  GAMING (10 words)
-- -------------------------
('Controller',   'Input',      'Joystick',     'Gaming', 'easy'),
('Respawn',      'Return',     NULL,           'Gaming', 'easy'),
('Inventory',    'Items',      NULL,           'Gaming', 'easy'),
('Dungeon',      'Underground','Cave',         'Gaming', 'medium'),
('Speedrun',     'Fast',       NULL,           'Gaming', 'medium'),
('Loot',         'Reward',     'Treasure',     'Gaming', 'easy'),
('Sandbox',      'Open world', NULL,           'Gaming', 'medium'),
('Glitch',       'Bug',        'Exploit',      'Gaming', 'hard'),
('Crafting',     'Building',   'Forging',      'Gaming', 'medium'),
('Leaderboard',  'Ranking',    NULL,           'Gaming', 'easy'),

-- -------------------------
--  PROGRAMMING (10 words)
-- -------------------------
('Variable',     'Stores',     'Constant',     'Programming', 'easy'),
('Recursion',    'Self-calls', NULL,           'Programming', 'hard'),
('Debugging',    'Fixing',     'Testing',      'Programming', 'easy'),
('Algorithm',    'Steps',      'Procedure',    'Programming', 'medium'),
('Database',     'Stores data',NULL,           'Programming', 'easy'),
('Framework',    'Structure',  'Library',      'Programming', 'medium'),
('Loop',         'Repeats',    'Iteration',    'Programming', 'easy'),
('API',          'Interface',  'Endpoint',     'Programming', 'medium'),
('Compiler',     'Translates', 'Interpreter',  'Programming', 'hard'),
('Deployment',   'Releasing',  NULL,           'Programming', 'medium'),

-- -------------------------
--  BOLLYWOOD (10 words)
-- -------------------------
('Item Song',    'Dance',      NULL,           'Bollywood', 'easy'),
('Dialogue',     'Line',       NULL,           'Bollywood', 'easy'),
('Intermission', 'Break',      NULL,           'Bollywood', 'easy'),
('Villain',      'Antagonist', 'Anti-hero',    'Bollywood', 'easy'),
('Choreographer','Dance',      NULL,           'Bollywood', 'medium'),
('Stunt Double', 'Action',     NULL,           'Bollywood', 'medium'),
('Dubbing',      'Voice',      NULL,           'Bollywood', 'medium'),
('Box Office',   'Earnings',   NULL,           'Bollywood', 'easy'),
('Flop',         'Failure',    'Disaster',     'Bollywood', 'easy'),
('Remake',       'Redo',       'Sequel',       'Bollywood', 'easy'),

-- -------------------------
--  CRICKET (10 words)
-- -------------------------
('Bouncer',      'Fast ball',  'Yorker',       'Cricket', 'medium'),
('LBW',          'Out',        NULL,           'Cricket', 'medium'),
('Century',      'Hundred',    'Half century', 'Cricket', 'easy'),
('Wicket',       'Three stumps','Crease',      'Cricket', 'easy'),
('Yorker',       'Feet',       'Bouncer',      'Cricket', 'medium'),
('No ball',      'Extra',      'Wide',         'Cricket', 'easy'),
('Googly',       'Spin',       'Doosra',       'Cricket', 'hard'),
('Run out',      'Fielding',   NULL,           'Cricket', 'easy'),
('Powerplay',    'Overs',      NULL,           'Cricket', 'medium'),
('DRS',          'Review',     NULL,           'Cricket', 'hard'),

-- -------------------------
--  COUNTRIES (10 words)
-- -------------------------
('Japan',        'Cherry',     'South Korea',  'Countries', 'easy'),
('Brazil',       'Carnival',   'Argentina',    'Countries', 'easy'),
('Egypt',        'Pyramids',   'Morocco',      'Countries', 'easy'),
('Canada',       'Maple',      'Australia',    'Countries', 'easy'),
('Switzerland',  'Neutral',    'Austria',      'Countries', 'medium'),
('Iceland',      'Glaciers',   'Norway',       'Countries', 'medium'),
('Mexico',       'Spicy',      'Colombia',     'Countries', 'easy'),
('Greece',       'Ancient',    'Rome',        'Countries', 'easy'),
('Thailand',     'Temples',    'Vietnam',      'Countries', 'medium'),
('New Zealand',  'Kiwi',       'Australia',    'Countries', 'medium'),

-- -------------------------
--  ENGINEERING (10 words)
-- -------------------------
('Blueprint',    'Plan',       'Schematic',    'Engineering', 'easy'),
('Torque',       'Rotation',   NULL,           'Engineering', 'medium'),
('Circuit',      'Electrical', 'Network',      'Engineering', 'medium'),
('Prototype',    'First model','Mockup',       'Engineering', 'easy'),
('Stress test',  'Pressure',   NULL,           'Engineering', 'medium'),
('Calibration',  'Adjusting',  NULL,           'Engineering', 'hard'),
('Tolerance',    'Margin',     NULL,           'Engineering', 'hard'),
('Hydraulics',   'Fluid power',NULL,           'Engineering', 'hard'),
('Alloy',        'Mixed metal','Composite',    'Engineering', 'medium'),
('Load bearing', 'Support',    NULL,           'Engineering', 'medium'),

