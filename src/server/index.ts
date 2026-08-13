import {
	type Connection,
	type ConnectionContext,
	Server,
	type WSMessage,
	routePartykitRequest,
} from "partyserver";

import type { ChatMessage, MessageFormat } from "../shared";

const ALLOWED_ORIGIN = "https://drkodoom.github.io";
const HISTORY_LIMIT = 100;
const EDIT_WINDOW_MS = 10 * 60 * 1000;
const ALLOWED_REACTIONS = new Set(["👍", "❤️", "😂", "😮", "👎"]);
const ALLOWED_ROOM_THEMES = new Set(["modern", "aol90", "terminal", "future", "comic", "arcade"]);

const validColor = (value: unknown) => {
	const color = String(value || "").trim();
	return /^#[0-9A-Fa-f]{6}$/.test(color) ? color.toUpperCase() : null;
};

const validBadge = (value: unknown) => {
	const badge = String(value || "").trim().slice(0, 12);
	return /^[A-Za-z0-9 _-]{0,12}$/.test(badge) ? badge : "";
};

const sanitizeFormat = (value: unknown): MessageFormat => {
	const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
	const size = ["small", "normal", "large"].includes(String(input.size))
		? String(input.size) as MessageFormat["size"]
		: "normal";
	return {
		bold: Boolean(input.bold),
		italic: Boolean(input.italic),
		underline: Boolean(input.underline),
		strike: Boolean(input.strike),
		color: validColor(input.color) || undefined,
		size,
	};
};

type ChatConnectionState = {
	username: string;
	role: string;
	displayName: string;
	hideAdminBadge: boolean;
	joinedAt: number;
	status: "online" | "away" | "busy";
	statusText: string;
	nameColor: string | null;
	badge: string;
	lastMessageAt: number;
};

type StoredMessage = ChatMessage & {
	displayUser: string;
	displayRole: "user" | "mod" | "admin";
	format: MessageFormat;
	replyTo: string | null;
	createdAt: number;
	updatedAt: number | null;
	deleted: boolean;
	highlightColor: string | null;
};

type RoomSettings = {
	pinnedMessageIds: string[];
	slowModeSeconds: number;
	locked: boolean;
	banner: string;
	modUsername: string | null;
	roomTheme: string | null;
};

type GameEffect = {
	name: string;
	kind: "buff" | "debuff" | "dot" | "shield" | "regen";
	value: number;
	turns: number;
};

type BattlePlayer = {
	username: string;
	hp: number;
	maxHp: number;
	attacks: number;
	damageDealt: number;
	crits: number;
	lastActionAt: number;
	effects: GameEffect[];
};

type HangmanGame = {
	type: "hangman";
	status: "active" | "won" | "lost" | "ended";
	host: string;
	phrase: string;
	guessed: string[];
	wrong: number;
	maxWrong: number;
	winner: string | null;
	log: string[];
	startedAt: number;
};

type BossKey = "mad_dragon" | "goblin_king" | "evil_wizard";

type BossGame = {
	type: "boss";
	status: "active" | "won" | "lost" | "ended";
	host: string;
	bossKey: BossKey;
	bossName: string;
	bossHp: number;
	bossMaxHp: number;
	players: Record<string, BattlePlayer>;
	turnOrder: string[];
	turnIndex: number;
	round: number;
	log: string[];
	startedAt: number;
};

type GameState = HangmanGame | BossGame | null;

type ClientMessage =
	| { type: "add"; id?: string; content?: string; format?: unknown; replyTo?: string | null }
	| { type: "edit"; id?: string; content?: string; format?: unknown }
	| { type: "delete"; id?: string }
	| { type: "reaction"; id?: string; emoji?: string }
	| { type: "typing"; active?: boolean }
	| { type: "presence_status"; status?: string; statusText?: string }
	| { type: "admin_clear_status"; username?: string }
	| { type: "ping"; time?: number }
	| { type: "clear_room" }
	| { type: "admin_announcement"; content?: string }
	| { type: "admin_banner"; content?: string }
	| { type: "admin_kick"; username?: string }
	| { type: "admin_mute"; username?: string; durationSeconds?: number; reason?: string }
	| { type: "admin_unmute"; username?: string }
	| { type: "admin_pin"; id?: string | null }
	| { type: "admin_highlight"; id?: string; color?: string | null }
	| { type: "admin_room_settings"; slowModeSeconds?: number; locked?: boolean }
	| { type: "admin_user_style"; username?: string; nameColor?: string | null; badge?: string }
	| { type: "admin_set_mod"; username?: string | null }
	| { type: "admin_room_theme"; theme?: string | null }
	| { type: "admin_confetti" }
	| { type: "admin_identity"; hideAdminBadge?: boolean; maskName?: string | null }
	| { type: "staff_user_color"; username?: string; nameColor?: string | null }
	| { type: "game_start"; game?: "hangman" | "boss"; phrase?: string; boss?: BossKey }
	| { type: "game_hangman_guess"; guess?: string }
	| { type: "game_boss_attack" }
	| { type: "game_boss_skip" }
	| { type: "game_end" };

export class Chat extends Server<Env> {
	static options = { hibernate: true };

	messages: StoredMessage[] = [];
	profiles = new Map<string, { username: string; nameColor: string | null; badge: string }>();
	settings: RoomSettings = {
		pinnedMessageIds: [],
		slowModeSeconds: 0,
		locked: false,
		banner: "",
		modUsername: null,
		roomTheme: null,
	};
	game: GameState = null;

	onStart() {
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS messages (
				id TEXT PRIMARY KEY,
				user TEXT,
				role TEXT,
				content TEXT
			)
		`);
		this.ensureMessageColumns();

		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS reactions (
				message_id TEXT NOT NULL,
				username TEXT NOT NULL,
				emoji TEXT NOT NULL,
				PRIMARY KEY (message_id, username, emoji)
			)
		`);

		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS profiles (
				username TEXT PRIMARY KEY COLLATE NOCASE,
				name_color TEXT,
				badge TEXT NOT NULL DEFAULT ''
			)
		`);

		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS room_settings (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				pinned_message_id TEXT,
				slow_mode_seconds INTEGER NOT NULL DEFAULT 0,
				locked INTEGER NOT NULL DEFAULT 0,
				banner TEXT NOT NULL DEFAULT ''
			)
		`);
		this.ctx.storage.sql.exec(`
			INSERT OR IGNORE INTO room_settings
			(id, pinned_message_id, slow_mode_seconds, locked, banner)
			VALUES (1, NULL, 0, 0, '')
		`);
		this.ensureRoomSettingsColumns();

		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS game_state (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				state_json TEXT NOT NULL DEFAULT ''
			)
		`);
		this.ctx.storage.sql.exec(`INSERT OR IGNORE INTO game_state (id, state_json) VALUES (1, '')`);

		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS mutes (
				username TEXT PRIMARY KEY COLLATE NOCASE,
				muted_until INTEGER NOT NULL DEFAULT 0,
				muted_by TEXT,
				reason TEXT
			)
		`);

		this.loadState();
	}

	ensureMessageColumns() {
		const columns = new Set(
			(this.ctx.storage.sql.exec(`PRAGMA table_info(messages)`).toArray() as Array<{ name: string }>).map((row) => row.name),
		);
		const additions: Array<[string, string]> = [
			["display_user", "TEXT"],
			["display_role", "TEXT"],
			["format_json", "TEXT NOT NULL DEFAULT '{}'"],
			["reply_to", "TEXT"],
			["created_at", "INTEGER NOT NULL DEFAULT 0"],
			["updated_at", "INTEGER"],
			["deleted", "INTEGER NOT NULL DEFAULT 0"],
			["highlight_color", "TEXT"],
		];
		for (const [name, definition] of additions) {
			if (!columns.has(name)) this.ctx.storage.sql.exec(`ALTER TABLE messages ADD COLUMN ${name} ${definition}`);
		}
	}

	ensureRoomSettingsColumns() {
		const columns = new Set(
			(this.ctx.storage.sql.exec(`PRAGMA table_info(room_settings)`).toArray() as Array<{ name: string }>).map((row) => row.name),
		);
		if (!columns.has("pinned_message_ids_json")) {
			this.ctx.storage.sql.exec(`ALTER TABLE room_settings ADD COLUMN pinned_message_ids_json TEXT NOT NULL DEFAULT '[]'`);
		}
		if (!columns.has("mod_username")) {
			this.ctx.storage.sql.exec(`ALTER TABLE room_settings ADD COLUMN mod_username TEXT`);
		}
		if (!columns.has("room_theme")) {
			this.ctx.storage.sql.exec(`ALTER TABLE room_settings ADD COLUMN room_theme TEXT`);
		}
	}

	loadState() {
		const rows = this.ctx.storage.sql.exec(`
			SELECT rowid, * FROM messages
			ORDER BY CASE WHEN created_at = 0 THEN rowid ELSE created_at END DESC
			LIMIT ${HISTORY_LIMIT}
		`).toArray() as Array<Record<string, unknown>>;

		this.messages = rows.reverse().map((row) => {
			const ownerRole = ["admin", "mod"].includes(String(row.role || "user")) ? String(row.role) as "admin" | "mod" : "user";
			const publicRole = ["admin", "mod"].includes(String(row.display_role || ownerRole)) ? String(row.display_role || ownerRole) as "admin" | "mod" : "user";
			return {
			id: String(row.id || ""),
			user: String(row.user || ""),
			role: ownerRole,
			displayUser: String(row.display_user || row.user || ""),
			displayRole: publicRole,
			content: String(row.content || ""),
			format: this.parseFormat(row.format_json),
			replyTo: row.reply_to ? String(row.reply_to) : null,
			createdAt: Number(row.created_at) || 0,
			updatedAt: row.updated_at == null ? null : Number(row.updated_at),
			deleted: Number(row.deleted) === 1,
			highlightColor: validColor(row.highlight_color),
		};
		});

		const profileRows = this.ctx.storage.sql.exec(`SELECT username, name_color, badge FROM profiles`).toArray() as Array<Record<string, unknown>>;
		this.profiles.clear();
		for (const row of profileRows) {
			const username = String(row.username || "");
			if (username) this.profiles.set(username.toLowerCase(), {
				username,
				nameColor: validColor(row.name_color),
				badge: validBadge(row.badge),
			});
		}

		const settings = (this.ctx.storage.sql.exec(`SELECT * FROM room_settings WHERE id = 1`).toArray()[0] || {}) as Record<string, unknown>;
		let pinnedMessageIds: string[] = [];
		try {
			const parsed = JSON.parse(String(settings?.pinned_message_ids_json || "[]"));
			if (Array.isArray(parsed)) pinnedMessageIds = parsed.map((value) => String(value)).filter(Boolean).slice(0, 2);
		} catch {
			pinnedMessageIds = [];
		}
		if (!pinnedMessageIds.length && settings?.pinned_message_id) pinnedMessageIds = [String(settings.pinned_message_id)];
		this.settings = {
			pinnedMessageIds,
			slowModeSeconds: Math.max(0, Number(settings?.slow_mode_seconds) || 0),
			locked: Number(settings?.locked) === 1,
			banner: String(settings?.banner || ""),
			modUsername: settings?.mod_username ? String(settings.mod_username) : null,
			roomTheme: ALLOWED_ROOM_THEMES.has(String(settings?.room_theme || "")) ? String(settings.room_theme) : null,
		};

		const gameRow = (this.ctx.storage.sql.exec(`SELECT state_json FROM game_state WHERE id = 1`).toArray()[0] || {}) as Record<string, unknown>;
		try {
			this.game = gameRow.state_json ? JSON.parse(String(gameRow.state_json)) as GameState : null;
			if (this.game?.type === "boss") {
				if (!Array.isArray(this.game.turnOrder)) this.game.turnOrder = Object.keys(this.game.players || {});
				if (!Number.isInteger(this.game.turnIndex) || this.game.turnIndex < 0 || this.game.turnIndex >= Math.max(1, this.game.turnOrder.length)) this.game.turnIndex = 0;
				if (!Number.isInteger(this.game.round) || this.game.round < 1) this.game.round = 1;
			}
		} catch {
			this.game = null;
		}
	}

	parseFormat(value: unknown): MessageFormat {
		try {
			return sanitizeFormat(JSON.parse(String(value || "{}")));
		} catch {
			return sanitizeFormat({});
		}
	}

	getReactionSummary(messageId: string) {
		const rows = this.ctx.storage.sql.exec(
			`SELECT emoji, COUNT(*) AS count FROM reactions WHERE message_id = ? GROUP BY emoji`,
			messageId,
		).toArray() as Array<{ emoji: string; count: number }>;
		const result: Record<string, number> = {};
		for (const row of rows) result[String(row.emoji)] = Number(row.count) || 0;
		return result;
	}

	serializeMessage(message: StoredMessage) {
		return {
			id: message.id,
			content: message.content,
			user: message.displayUser || message.user,
			role: message.displayRole || message.role,
			format: message.format,
			replyTo: message.replyTo,
			createdAt: message.createdAt,
			updatedAt: message.updatedAt,
			deleted: message.deleted,
			highlightColor: message.highlightColor,
			pinned: this.settings.pinnedMessageIds.includes(message.id),
			reactions: this.getReactionSummary(message.id),
		};
	}

	getProfileMap() {
		const result: Record<string, { nameColor: string | null; badge: string }> = {};
		for (const profile of this.profiles.values()) {
			result[profile.username] = { nameColor: profile.nameColor, badge: profile.badge };
		}
		return result;
	}


	isAdmin(state: ChatConnectionState | null | undefined) {
		return state?.role === "admin";
	}

	publicName(state: ChatConnectionState | null | undefined) {
		return state?.displayName || state?.username || "Unknown";
	}

	publicRole(state: ChatConnectionState | null | undefined): "user" | "mod" | "admin" {
		if (this.isAdmin(state)) return state?.hideAdminBadge ? "user" : "admin";
		if (this.isMod(state)) return "mod";
		return "user";
	}

	validMaskName(value: unknown) {
		const name = String(value || "").trim().replace(/\s+/g, " ").slice(0, 24);
		if (!name) return null;
		return /^[A-Za-z0-9_. -]{2,24}$/.test(name) ? name : undefined;
	}

	maskNameAvailable(name: string, selfUsername: string) {
		const key = name.toLowerCase();
		for (const profile of this.profiles.values()) {
			if (profile.username.toLowerCase() === key && profile.username.toLowerCase() !== selfUsername.toLowerCase()) return false;
		}
		for (const connection of this.getConnections<ChatConnectionState>()) {
			const other = connection.state;
			if (!other || other.username.toLowerCase() === selfUsername.toLowerCase()) continue;
			if (other.username.toLowerCase() === key || this.publicName(other).toLowerCase() === key) return false;
		}
		return true;
	}

	isMod(state: ChatConnectionState | null | undefined) {
		return Boolean(
			state?.username &&
			this.settings.modUsername &&
			state.username.toLowerCase() === this.settings.modUsername.toLowerCase()
		);
	}

	isStaff(state: ChatConnectionState | null | undefined) {
		return this.isAdmin(state) || this.isMod(state);
	}

	effectiveRole(state: ChatConnectionState | null | undefined): "user" | "mod" | "admin" {
		if (this.isAdmin(state)) return "admin";
		if (this.isMod(state)) return "mod";
		return "user";
	}

	saveRoomSettings() {
		this.ctx.storage.sql.exec(
			`UPDATE room_settings
			 SET pinned_message_ids_json = ?, pinned_message_id = ?, slow_mode_seconds = ?, locked = ?, banner = ?, mod_username = ?, room_theme = ?
			 WHERE id = 1`,
			JSON.stringify(this.settings.pinnedMessageIds.slice(0, 2)),
			this.settings.pinnedMessageIds[0] || null,
			this.settings.slowModeSeconds,
			this.settings.locked ? 1 : 0,
			this.settings.banner,
			this.settings.modUsername,
			this.settings.roomTheme,
		);
	}

	setModerator(username: string | null, actor: string) {
		const clean = username ? String(username).trim() : null;
		const previous = this.settings.modUsername;
		this.settings.modUsername = clean || null;
		this.saveRoomSettings();
		this.broadcastSettings();
		this.broadcastPresence();
		if (previous && (!clean || previous.toLowerCase() !== clean.toLowerCase())) {
			this.broadcastSystem("mod_removed", previous, actor);
		}
		if (clean && (!previous || previous.toLowerCase() !== clean.toLowerCase())) {
			this.broadcastSystem("mod_granted", clean, actor);
		}
	}

	saveGame() {
		this.ctx.storage.sql.exec(
			`UPDATE game_state SET state_json = ? WHERE id = 1`,
			this.game ? JSON.stringify(this.game) : "",
		);
	}

	addGameLog(text: string) {
		if (!this.game) return;
		this.game.log.push(text);
		if (this.game.log.length > 18) this.game.log = this.game.log.slice(-18);
	}

	broadcastGameEvent(text: string, tone: "normal" | "good" | "bad" | "critical" = "normal") {
		this.broadcast(JSON.stringify({ type: "game_event", text, tone }));
	}

	hangmanDisplay(game: HangmanGame) {
		if (game.status !== "active") return game.phrase;
		const guessed = new Set(game.guessed);
		return Array.from(game.phrase).map((char) => {
			if (!/[A-Z0-9]/i.test(char)) return char;
			return guessed.has(char.toUpperCase()) ? char : "_";
		}).join("");
	}

	publicGameState() {
		if (!this.game) return null;
		if (this.game.type === "hangman") {
			return {
				type: "hangman",
				status: this.game.status,
				host: this.game.host,
				displayPhrase: this.hangmanDisplay(this.game),
				guessed: this.game.guessed,
				wrong: this.game.wrong,
				maxWrong: this.game.maxWrong,
				winner: this.game.winner,
				log: this.game.log,
				startedAt: this.game.startedAt,
			};
		}
		const currentKey = this.game.turnOrder?.[this.game.turnIndex] || null;
		const currentPlayer = currentKey ? this.game.players[currentKey] : null;
		return {
			...this.game,
			players: Object.values(this.game.players),
			turnOrder: undefined,
			turnIndex: undefined,
			currentTurn: currentPlayer?.username || null,
			round: this.game.round || 1,
		};
	}

	broadcastGame() {
		this.broadcast(JSON.stringify({ type: "game_state", game: this.publicGameState() }));
	}

	randomInt(min: number, max: number) {
		return Math.floor(Math.random() * (max - min + 1)) + min;
	}

	addEffect(player: BattlePlayer, effect: GameEffect) {
		const existing = player.effects.find((item) => item.name === effect.name);
		if (existing) {
			existing.turns = Math.max(existing.turns, effect.turns);
			existing.value = effect.value;
			existing.kind = effect.kind;
			return;
		}
		player.effects.push(effect);
	}

	getUniqueConnectionStates() {
		const users = new Map<string, ChatConnectionState>();
		for (const connection of this.getConnections<ChatConnectionState>()) {
			const state = connection.state;
			if (!state?.username) continue;
			const key = state.username.toLowerCase();
			const existing = users.get(key);
			if (!existing || state.joinedAt < existing.joinedAt) users.set(key, state);
		}
		return Array.from(users.values()).sort((a, b) => a.joinedAt - b.joinedAt);
	}

	newBattlePlayer(state: ChatConnectionState): BattlePlayer {
		return {
			username: this.publicName(state),
			hp: 45,
			maxHp: 45,
			attacks: 0,
			damageDealt: 0,
			crits: 0,
			lastActionAt: 0,
			effects: [],
		};
	}

	startBossGame(hostState: ChatConnectionState, bossKey: BossKey) {
		const states = this.getUniqueConnectionStates();
		const hostKey = hostState.username.toLowerCase();
		states.sort((a, b) => {
			if (a.username.toLowerCase() === hostKey) return -1;
			if (b.username.toLowerCase() === hostKey) return 1;
			return a.joinedAt - b.joinedAt;
		});
		const online = Math.max(1, states.length);
		const defs: Record<BossKey, { name: string; baseHp: number; perPlayer: number }> = {
			mad_dragon: { name: "Mad Dragon", baseHp: 180, perPlayer: 35 },
			goblin_king: { name: "Goblin King", baseHp: 150, perPlayer: 30 },
			evil_wizard: { name: "Evil Wizard", baseHp: 165, perPlayer: 32 },
		};
		const def = defs[bossKey];
		const hp = def.baseHp + Math.max(0, online - 1) * def.perPlayer;
		const players: Record<string, BattlePlayer> = {};
		const turnOrder: string[] = [];
		for (const playerState of states) {
			const key = playerState.username.toLowerCase();
			players[key] = this.newBattlePlayer(playerState);
			turnOrder.push(key);
		}
		if (!turnOrder.length) {
			players[hostKey] = this.newBattlePlayer(hostState);
			turnOrder.push(hostKey);
		}
		this.game = {
			type: "boss",
			status: "active",
			host: this.publicName(hostState),
			bossKey,
			bossName: def.name,
			bossHp: hp,
			bossMaxHp: hp,
			players,
			turnOrder,
			turnIndex: 0,
			round: 1,
			log: [`${this.publicName(hostState)} summoned the ${def.name}. ${players[turnOrder[0]]?.username || "A player"} goes first. Type /roll only when it is your turn.`],
			startedAt: Date.now(),
		};
		this.saveGame();
		this.broadcastGame();
		this.broadcastGameEvent(`${this.publicName(hostState)} summoned the ${def.name}. ${players[turnOrder[0]]?.username || "A player"} goes first.`, "critical");
	}

	ensureBossPlayer(game: BossGame, state: ChatConnectionState) {
		const key = state.username.toLowerCase();
		if (!game.players[key]) {
			game.players[key] = this.newBattlePlayer(state);
			game.turnOrder.push(key);
			this.addGameLog(`${this.publicName(state)} joins the battle and enters the turn order.`);
		} else {
			game.players[key].username = this.publicName(state);
		}
		return game.players[key];
	}

	advanceBossTurn(game: BossGame) {
		if (!game.turnOrder.length) return null;
		const total = game.turnOrder.length;
		for (let step = 1; step <= total; step += 1) {
			const nextIndex = (game.turnIndex + step) % total;
			const key = game.turnOrder[nextIndex];
			const player = game.players[key];
			if (!player || player.hp <= 0 || !this.isUsernameOnline(key)) continue;
			if (nextIndex <= game.turnIndex) game.round = Math.max(1, (game.round || 1) + 1);
			game.turnIndex = nextIndex;
			return player;
		}
		return null;
	}

	currentBossPlayer(game: BossGame) {
		const key = game.turnOrder?.[game.turnIndex];
		return key ? game.players[key] || null : null;
	}

	bossAttack(game: BossGame, player: BattlePlayer) {
		const roll = Math.random();
		let name = "Attack";
		let damage = 0;
		let effect: GameEffect | null = null;
		let heal = 0;
		let extraText = "";

		if (game.bossKey === "mad_dragon") {
			if (roll < 0.34) {
				name = "Flame Breath";
				damage = this.randomInt(8, 14);
				effect = { name: "Burning", kind: "dot", value: 2, turns: 3 };
			} else if (roll < 0.58) {
				name = "Terrifying Roar";
				damage = this.randomInt(4, 8);
				effect = { name: "Shaken", kind: "debuff", value: -2, turns: 2 };
			} else {
				name = "Claw Swipe";
				damage = this.randomInt(7, 12);
			}
		} else if (game.bossKey === "goblin_king") {
			if (roll < 0.28) {
				name = "Pocket Sand";
				damage = this.randomInt(3, 6);
				effect = { name: "Blinded", kind: "debuff", value: -4, turns: 1 };
			} else if (roll < 0.55) {
				name = "Crown Theft";
				damage = this.randomInt(4, 7);
				const stolenIndex = player.effects.findIndex((item) => item.kind === "buff" || item.kind === "regen" || item.kind === "shield");
				if (stolenIndex >= 0) {
					const [stolen] = player.effects.splice(stolenIndex, 1);
					heal = 4;
					extraText = ` The Goblin King steals ${stolen.name}!`;
				} else {
					effect = { name: "Shaken", kind: "debuff", value: -2, turns: 2 };
				}
			} else {
				name = "Royal Cleaver";
				damage = this.randomInt(5, 10);
			}
		} else {
			if (roll < 0.3) {
				name = "Hex";
				damage = this.randomInt(4, 8);
				effect = { name: "Hexed", kind: "debuff", value: -3, turns: 3 };
			} else if (roll < 0.56) {
				name = "Life Drain";
				damage = this.randomInt(5, 10);
				heal = Math.max(2, Math.floor(damage / 2));
			} else if (roll < 0.78) {
				name = "Withering Curse";
				damage = this.randomInt(3, 6);
				effect = { name: "Cursed", kind: "dot", value: 3, turns: 2 };
			} else {
				name = "Arcane Bolt";
				damage = this.randomInt(6, 12);
			}
		}

		const shield = player.effects.find((item) => item.kind === "shield");
		let blocked = 0;
		if (shield && damage > 0) {
			blocked = Math.min(damage, Math.max(0, shield.value));
			damage -= blocked;
			shield.turns -= 1;
			if (shield.turns <= 0) player.effects = player.effects.filter((item) => item !== shield);
		}

		player.hp = Math.max(0, player.hp - damage);
		if (effect && player.hp > 0) this.addEffect(player, effect);
		if (heal > 0) game.bossHp = Math.min(game.bossMaxHp, game.bossHp + heal);
		let text = `${game.bossName} uses ${name} on ${player.username} for ${damage} damage.`;
		if (blocked > 0) text += ` ${player.username}'s shield blocks ${blocked}.`;
		if (effect && player.hp > 0) text += ` ${player.username} is ${effect.name} for ${effect.turns} turn${effect.turns === 1 ? "" : "s"}.`;
		if (heal > 0) text += ` The boss heals ${heal} HP.`;
		if (extraText) text += extraText;
		if (player.hp <= 0) text += ` ${player.username} is knocked out!`;
		this.addGameLog(text);
		this.broadcastGameEvent(text, player.hp <= 0 ? "bad" : "normal");
	}

	processPlayerEffects(player: BattlePlayer) {
		let modifier = 0;
		const remaining: GameEffect[] = [];
		for (const effect of player.effects) {
			if (effect.kind === "shield") {
				remaining.push(effect);
				continue;
			}
			if (effect.kind === "dot") {
				const damage = Math.max(0, effect.value);
				player.hp = Math.max(0, player.hp - damage);
				const line = `${player.username} takes ${damage} damage from ${effect.name}.`;
				this.addGameLog(line);
				this.broadcastGameEvent(line, "bad");
			} else if (effect.kind === "regen") {
				const before = player.hp;
				player.hp = Math.min(player.maxHp, player.hp + Math.max(0, effect.value));
				const healed = player.hp - before;
				if (healed > 0) {
					const line = `${player.username} regenerates ${healed} HP from ${effect.name}.`;
					this.addGameLog(line);
					this.broadcastGameEvent(line, "good");
				}
			} else {
				modifier += effect.value;
			}
			const turns = effect.turns - 1;
			if (turns > 0) remaining.push({ ...effect, turns });
		}
		player.effects = remaining;
		return modifier;
	}

	bossBattleAttack(state: ChatConnectionState, connection: Connection) {
		if (!this.game || this.game.type !== "boss" || this.game.status !== "active") return this.sendError(connection, "No boss battle is active.");
		const game = this.game;
		const key = state.username.toLowerCase();
		const player = this.ensureBossPlayer(game, state);
		const currentKey = game.turnOrder?.[game.turnIndex];
		const currentPlayer = currentKey ? game.players[currentKey] : null;
		if (currentKey && currentKey !== key) return this.sendError(connection, `It is ${currentPlayer?.username || "another player's"} turn. Wait for your turn.`);
		if (player.hp <= 0) return this.sendError(connection, "You are knocked out for the rest of this battle.");

		const modifier = this.processPlayerEffects(player);
		if (player.hp <= 0) {
			this.addGameLog(`${player.username} falls before they can attack.`);
			const next = this.advanceBossTurn(game);
			if (next) this.addGameLog(`It is now ${next.username}'s turn.`);
			this.saveGame();
			this.broadcastGame();
			return;
		}

		const rawRoll = this.randomInt(1, 20);
		const totalRoll = rawRoll + modifier;
		let damage = 0;
		let attackText = `${player.username} rolls ${rawRoll}`;
		if (modifier) attackText += ` (${modifier > 0 ? "+" : ""}${modifier} = ${totalRoll})`;

		if (rawRoll === 1) {
			this.addEffect(player, { name: "Rattled", kind: "debuff", value: -2, turns: 1 });
			attackText += " and fumbles — no damage! Rattled gives -2 on the next roll.";
		} else if (totalRoll <= 5) {
			attackText += " and misses!";
		} else {
			damage = this.randomInt(4, 8) + Math.max(0, Math.floor(totalRoll / 4));
			if (rawRoll === 20) {
				damage *= 2;
				player.crits += 1;
				this.addEffect(player, { name: "Heroic", kind: "buff", value: 3, turns: 2 });
				this.addEffect(player, { name: "Dragonheart Shield", kind: "shield", value: 5, turns: 1 });
				attackText += ` — CRITICAL HIT for ${damage} damage! Heroic gives +3 for 2 turns and a 5-point shield.`;
			} else if (rawRoll === 19) {
				this.addEffect(player, { name: "Regeneration", kind: "regen", value: 3, turns: 2 });
				attackText += ` and hits for ${damage} damage! Regeneration restores 3 HP on the next 2 turns.`;
			} else if (rawRoll === 18) {
				this.addEffect(player, { name: "Inspired", kind: "buff", value: 2, turns: 2 });
				attackText += ` and hits for ${damage} damage! Inspired gives +2 for 2 turns.`;
			} else {
				attackText += ` and hits for ${damage} damage.`;
			}
			game.bossHp = Math.max(0, game.bossHp - damage);
			player.damageDealt += damage;
		}
		player.attacks += 1;
		player.lastActionAt = Date.now();
		this.addGameLog(attackText);
		this.broadcastGameEvent(attackText, rawRoll === 20 ? "critical" : (damage > 0 ? "good" : "normal"));

		if (game.bossHp <= 0) {
			game.status = "won";
			const winText = `${game.bossName} is defeated! The party wins!`;
			this.addGameLog(winText);
			this.broadcastGameEvent(winText, "critical");
			this.saveGame();
			this.broadcastGame();
			return;
		}

		this.bossAttack(game, player);
		const participants = Object.values(game.players);
		if (participants.length > 0 && participants.every((entry) => entry.hp <= 0)) {
			game.status = "lost";
			const lossText = `The party has fallen. ${game.bossName} wins.`;
			this.addGameLog(lossText);
			this.broadcastGameEvent(lossText, "bad");
		} else {
			const next = this.advanceBossTurn(game);
			if (next) {
				const nextText = `Round ${game.round}: ${next.username}'s turn.`;
				this.addGameLog(nextText);
				this.broadcastGameEvent(nextText, "normal");
			}
		}
		this.saveGame();
		this.broadcastGame();
	}

	getOnlineUsers(excludeConnectionId?: string) {
		const users = new Map<string, ReturnType<Chat["presenceEntry"]>>();
		for (const connection of this.getConnections<ChatConnectionState>()) {
			if (excludeConnectionId && connection.id === excludeConnectionId) continue;
			const state = connection.state;
			if (!state?.username) continue;
			const key = state.username.toLowerCase();
			if (!users.has(key)) users.set(key, this.presenceEntry(state));
		}
		return Array.from(users.values()).sort((a, b) => a.username.localeCompare(b.username, undefined, { sensitivity: "base" }));
	}

	presenceEntry(state: ChatConnectionState) {
		const profile = this.profiles.get(state.username.toLowerCase());
		return {
			username: this.publicName(state),
			status: state.status,
			statusText: state.statusText,
			nameColor: profile?.nameColor ?? state.nameColor ?? null,
			badge: profile?.badge ?? state.badge ?? "",
			role: this.publicRole(state),
		};
	}

	isUsernameOnline(username: string, excludeConnectionId?: string) {
		for (const connection of this.getConnections<ChatConnectionState>()) {
			if (excludeConnectionId && connection.id === excludeConnectionId) continue;
			if (connection.state?.username?.toLowerCase() === username.toLowerCase()) return true;
		}
		return false;
	}

	broadcastPresence(excludeConnectionId?: string) {
		this.broadcast(JSON.stringify({ type: "presence", users: this.getOnlineUsers(excludeConnectionId) }));
	}

	broadcastSystem(event: string, username: string, actor?: string, extra: Record<string, unknown> = {}) {
		this.broadcast(JSON.stringify({ type: "system", event, username, actor, ...extra }));
	}

	broadcastSettings() {
		this.broadcast(JSON.stringify({ type: "room_settings", settings: this.settings }));
	}

	upsertProfile(username: string, nameColor: string | null, badge: string) {
		this.ctx.storage.sql.exec(
			`INSERT INTO profiles (username, name_color, badge) VALUES (?, ?, ?)
			 ON CONFLICT(username) DO UPDATE SET name_color = excluded.name_color, badge = excluded.badge`,
			username,
			nameColor,
			badge,
		);
		this.profiles.set(username.toLowerCase(), { username, nameColor, badge });
	}

	onConnect(connection: Connection, context: ConnectionContext) {
		const username = context.request.headers.get("x-chat-username");
		const role = context.request.headers.get("x-chat-role") || "user";
		const nameColor = validColor(context.request.headers.get("x-chat-name-color"));
		const badge = validBadge(context.request.headers.get("x-chat-badge"));

		if (!username) {
			connection.close(1008, "Unauthorized");
			return;
		}
		const modAllowed = Boolean(this.settings.modUsername && this.settings.modUsername.toLowerCase() === username.toLowerCase());
		if (this.settings.locked && role !== "admin" && !modAllowed) {
			connection.close(4002, "Room is currently locked by an administrator");
			return;
		}

		const alreadyOnline = this.isUsernameOnline(username, connection.id);
		const existingProfile = this.profiles.get(username.toLowerCase());
		if (!existingProfile) this.upsertProfile(username, nameColor, badge);
		connection.setState({
			username,
			role,
			displayName: username,
			hideAdminBadge: false,
			joinedAt: Date.now(),
			status: "online",
			statusText: "",
			nameColor,
			badge,
			lastMessageAt: 0,
		});

		connection.send(JSON.stringify({
			type: "all",
			messages: this.messages.map((message) => this.serializeMessage(message)),
			profiles: this.getProfileMap(),
			settings: this.settings,
			game: this.publicGameState(),
			identity: { displayName: username, hideAdminBadge: false },
		}));

		const connectedState = connection.state as ChatConnectionState;
		if (this.game?.type === "boss" && this.game.status === "active") {
			this.ensureBossPlayer(this.game, connectedState);
			this.saveGame();
			this.broadcastGame();
		}
		if (!alreadyOnline) this.broadcastSystem("join", this.publicName(connectedState));
		this.broadcastPresence();
	}

	onClose(connection: Connection) {
		const state = connection.state as ChatConnectionState | null;
		const username = state?.username;
		if (!username) return;
		const stillOnline = this.isUsernameOnline(username, connection.id);
		if (!stillOnline) {
			this.broadcastSystem("leave", this.publicName(state));
			if (this.settings.modUsername && this.settings.modUsername.toLowerCase() === username.toLowerCase()) {
				this.setModerator(null, "system");
			}
			if (this.game?.type === "boss" && this.game.status === "active") {
				const currentKey = this.game.turnOrder?.[this.game.turnIndex];
				if (currentKey === username.toLowerCase()) {
					const next = this.advanceBossTurn(this.game);
					if (next) this.addGameLog(`${this.publicName(state)} left. It is now ${next.username}'s turn.`);
					this.saveGame();
					this.broadcastGame();
				}
			}
		}
		this.broadcastPresence(connection.id);
	}

	isMuted(username: string) {
		const mute = this.ctx.storage.sql.exec(`SELECT muted_until, muted_by, reason FROM mutes WHERE lower(username) = lower(?) LIMIT 1`, username).toArray()[0] as Record<string, unknown> | undefined;
		if (!mute) return null;
		const until = Number(mute.muted_until) || 0;
		if (until > 0 && until <= Date.now()) {
			this.ctx.storage.sql.exec(`DELETE FROM mutes WHERE lower(username) = lower(?)`, username);
			return null;
		}
		return { until, by: String(mute.muted_by || ""), reason: String(mute.reason || "") };
	}

	findMessage(id: string) {
		return this.messages.find((message) => message.id === id) || null;
	}

	onMessage(connection: Connection, message: WSMessage) {
		if (typeof message !== "string") return;
		let parsed: ClientMessage;
		try { parsed = JSON.parse(message) as ClientMessage; } catch { return; }

		const state = connection.state as ChatConnectionState | null;
		if (!state?.username) return;

		if (parsed.type === "ping") {
			connection.send(JSON.stringify({ type: "pong", time: Date.now() }));
			return;
		}

		if (parsed.type === "typing") {
			this.broadcast(JSON.stringify({ type: "typing", username: this.publicName(state), active: Boolean(parsed.active) }));
			return;
		}

		if (parsed.type === "presence_status") {
			const status = ["online", "away", "busy"].includes(String(parsed.status)) ? String(parsed.status) as ChatConnectionState["status"] : "online";
			const statusText = String(parsed.statusText || "").trim().slice(0, 80);
			connection.setState({ ...state, status, statusText });
			this.broadcastPresence();
			return;
		}

		if (parsed.type === "admin_clear_status") {
			if (!this.isAdmin(state)) return this.adminError(connection);
			const target = String(parsed.username || "").trim().toLowerCase();
			if (!target) return;
			let cleared = false;
			for (const targetConnection of this.getConnections<ChatConnectionState>()) {
				const targetState = targetConnection.state;
				if (!targetState?.username) continue;
				const matches = targetState.username.toLowerCase() === target || this.publicName(targetState).toLowerCase() === target;
				if (!matches) continue;
				targetConnection.setState({ ...targetState, status: "online", statusText: "" });
				targetConnection.send(JSON.stringify({ type: "status_removed", actor: this.publicName(state) }));
				cleared = true;
			}
			if (cleared) this.broadcastPresence();
			return;
		}

		if (parsed.type === "clear_room") {
			if (!this.isAdmin(state)) return this.adminError(connection);
			this.ctx.storage.sql.exec(`DELETE FROM reactions`);
			this.ctx.storage.sql.exec(`DELETE FROM messages`);
			this.messages = [];
			this.settings.pinnedMessageIds = [];
			this.saveRoomSettings();
			this.broadcast(JSON.stringify({ type: "clear_room", username: this.publicName(state) }));
			this.broadcastSettings();
			return;
		}

		if (parsed.type === "admin_announcement") {
			if (!this.isStaff(state)) return this.staffError(connection);
			const content = String(parsed.content || "").trim().slice(0, 500);
			if (!content) return;
			this.broadcast(JSON.stringify({ type: "admin_announcement", username: this.publicName(state), role: this.publicRole(state), content }));
			return;
		}

		if (parsed.type === "admin_banner") {
			if (state.role !== "admin") return this.adminError(connection);
			const content = String(parsed.content || "").trim().slice(0, 200);
			this.settings.banner = content;
			this.ctx.storage.sql.exec(`UPDATE room_settings SET banner = ? WHERE id = 1`, content);
			this.broadcastSettings();
			return;
		}

		if (parsed.type === "admin_kick") {
			if (state.role !== "admin") return this.adminError(connection);
			const target = String(parsed.username || "").trim();
			if (!target || target.toLowerCase() === state.username.toLowerCase()) return;
			let kicked = 0;
			for (const other of this.getConnections<ChatConnectionState>()) {
				if (other.state?.username?.toLowerCase() === target.toLowerCase()) {
					kicked += 1;
					other.close(4001, `Removed from #lobby by ${state.username}`);
				}
			}
			if (!kicked) return this.sendError(connection, `${target} is not currently online.`);
			this.broadcastSystem("kick", target, this.publicName(state));
			this.broadcastPresence();
			return;
		}

		if (parsed.type === "admin_mute") {
			if (state.role !== "admin") return this.adminError(connection);
			const target = String(parsed.username || "").trim();
			if (!target || target.toLowerCase() === state.username.toLowerCase()) return;
			const duration = Number(parsed.durationSeconds);
			const until = duration < 0 ? 0 : Date.now() + Math.max(60, Math.min(duration || 300, 86400 * 30)) * 1000;
			const reason = String(parsed.reason || "").trim().slice(0, 160);
			this.ctx.storage.sql.exec(
				`INSERT INTO mutes (username, muted_until, muted_by, reason) VALUES (?, ?, ?, ?)
				 ON CONFLICT(username) DO UPDATE SET muted_until = excluded.muted_until, muted_by = excluded.muted_by, reason = excluded.reason`,
				target, until, state.username, reason,
			);
			this.broadcastSystem("mute", target, this.publicName(state), { until });
			return;
		}

		if (parsed.type === "admin_unmute") {
			if (state.role !== "admin") return this.adminError(connection);
			const target = String(parsed.username || "").trim();
			if (!target) return;
			this.ctx.storage.sql.exec(`DELETE FROM mutes WHERE lower(username) = lower(?)`, target);
			this.broadcastSystem("unmute", target, this.publicName(state));
			return;
		}

		if (parsed.type === "admin_pin") {
			if (!this.isStaff(state)) return this.staffError(connection);
			const id = parsed.id ? String(parsed.id) : null;
			if (!id) {
				this.settings.pinnedMessageIds = [];
			} else {
				const target = this.findMessage(id);
				if (!target || target.deleted) return;
				const existing = this.settings.pinnedMessageIds.indexOf(id);
				if (existing >= 0) {
					this.settings.pinnedMessageIds.splice(existing, 1);
				} else {
					if (this.settings.pinnedMessageIds.length >= 2) return this.sendError(connection, "Only two messages can be pinned at once.");
					this.settings.pinnedMessageIds.push(id);
				}
			}
			this.saveRoomSettings();
			this.broadcastSettings();
			return;
		}

		if (parsed.type === "admin_highlight") {
			if (state.role !== "admin") return this.adminError(connection);
			const id = String(parsed.id || "");
			const target = this.findMessage(id);
			if (!target) return;
			const color = parsed.color ? validColor(parsed.color) : null;
			target.highlightColor = color;
			this.ctx.storage.sql.exec(`UPDATE messages SET highlight_color = ? WHERE id = ?`, color, id);
			this.broadcast(JSON.stringify({ type: "message_update", message: this.serializeMessage(target) }));
			return;
		}

		if (parsed.type === "admin_room_settings") {
			if (state.role !== "admin") return this.adminError(connection);
			if (parsed.slowModeSeconds != null) {
				this.settings.slowModeSeconds = Math.max(0, Math.min(120, Math.floor(Number(parsed.slowModeSeconds) || 0)));
			}
			if (parsed.locked != null) this.settings.locked = Boolean(parsed.locked);
			this.saveRoomSettings();
			this.broadcastSettings();
			return;
		}

		if (parsed.type === "admin_room_theme") {
			if (!this.isAdmin(state)) return this.adminError(connection);
			const requested = parsed.theme ? String(parsed.theme) : null;
			if (requested && !ALLOWED_ROOM_THEMES.has(requested)) return this.sendError(connection, "Unknown room theme.");
			this.settings.roomTheme = requested;
			this.saveRoomSettings();
			this.broadcastSettings();
			this.broadcast(JSON.stringify({ type: "room_theme", theme: requested, actor: this.publicName(state) }));
			return;
		}

		if (parsed.type === "admin_confetti") {
			if (!this.isAdmin(state)) return this.adminError(connection);
			this.broadcast(JSON.stringify({ type: "confetti", actor: this.publicName(state), at: Date.now() }));
			return;
		}

		if (parsed.type === "admin_identity") {
			if (!this.isAdmin(state)) return this.adminError(connection);
			const requestedMask = this.validMaskName(parsed.maskName);
			if (requestedMask === undefined) return this.sendError(connection, "Mask names must be 2-24 characters using letters, numbers, spaces, periods, underscores, or hyphens.");
			const displayName = requestedMask || state.username;
			if (displayName.toLowerCase() !== state.username.toLowerCase() && !this.maskNameAvailable(displayName, state.username)) {
				return this.sendError(connection, "That disguise name is already in use or belongs to another known member.");
			}
			const hideAdminBadge = Boolean(parsed.hideAdminBadge);
			for (const other of this.getConnections<ChatConnectionState>()) {
				if (other.state?.username?.toLowerCase() !== state.username.toLowerCase()) continue;
				other.setState({ ...other.state, displayName, hideAdminBadge });
				other.send(JSON.stringify({ type: "admin_identity", displayName, hideAdminBadge }));
			}
			this.broadcastPresence();
			const publicRole = hideAdminBadge ? "user" : "admin";
			for (const message of this.messages) {
				if (message.user.toLowerCase() !== state.username.toLowerCase()) continue;
				message.displayUser = displayName;
				message.displayRole = publicRole;
				this.ctx.storage.sql.exec(`UPDATE messages SET display_user = ?, display_role = ? WHERE id = ?`, displayName, publicRole, message.id);
				this.broadcast(JSON.stringify({ type: "message_update", message: this.serializeMessage(message) }));
			}
			if (this.game?.type === "boss") {
				const player = this.game.players[state.username.toLowerCase()];
				if (player) player.username = displayName;
				if (this.game.host.toLowerCase() === state.username.toLowerCase() || this.game.host.toLowerCase() === this.publicName(state).toLowerCase()) this.game.host = displayName;
				this.saveGame();
				this.broadcastGame();
			}
			return;
		}

		if (parsed.type === "admin_user_style") {
			if (state.role !== "admin") return this.adminError(connection);
			const target = String(parsed.username || "").trim();
			if (!target) return;
			const color = parsed.nameColor ? validColor(parsed.nameColor) : null;
			const badge = validBadge(parsed.badge);
			this.upsertProfile(target, color, badge);
			for (const other of this.getConnections<ChatConnectionState>()) {
				if (other.state?.username?.toLowerCase() === target.toLowerCase()) {
					other.setState({ ...other.state, nameColor: color, badge });
				}
			}
			this.broadcast(JSON.stringify({ type: "user_style", username: target, nameColor: color, badge }));
			this.broadcastPresence();
			return;
		}


		if (parsed.type === "admin_set_mod") {
			if (!this.isAdmin(state)) return this.adminError(connection);
			const target = parsed.username ? String(parsed.username).trim() : null;
			if (target) {
				if (target.toLowerCase() === state.username.toLowerCase()) return this.sendError(connection, "The administrator already has all moderator powers.");
				if (!this.isUsernameOnline(target)) return this.sendError(connection, `${target} must be online to become MOD.`);
			}
			this.setModerator(target, this.publicName(state));
			return;
		}

		if (parsed.type === "staff_user_color") {
			if (!this.isStaff(state)) return this.staffError(connection);
			const target = String(parsed.username || "").trim();
			if (!target) return;
			if (!this.isAdmin(state)) {
				for (const other of this.getConnections<ChatConnectionState>()) {
					if (other.state?.username?.toLowerCase() === target.toLowerCase() && other.state.role === "admin") {
						return this.sendError(connection, "MODs cannot change the administrator's screen-name color.");
					}
				}
			}
			const current = this.profiles.get(target.toLowerCase());
			const color = parsed.nameColor ? validColor(parsed.nameColor) : null;
			if (parsed.nameColor && !color) return this.sendError(connection, "Use a six-digit hex color such as #FF3B30.");
			const badge = current?.badge || "";
			this.upsertProfile(target, color, badge);
			for (const other of this.getConnections<ChatConnectionState>()) {
				if (other.state?.username?.toLowerCase() === target.toLowerCase()) {
					other.setState({ ...other.state, nameColor: color });
				}
			}
			this.broadcast(JSON.stringify({ type: "user_style", username: target, nameColor: color, badge }));
			this.broadcastPresence();
			return;
		}

		if (parsed.type === "game_start") {
			if (!this.isStaff(state)) return this.staffError(connection);
			if (this.game?.status === "active") return this.sendError(connection, "End the current game before starting another one.");
			if (parsed.game === "hangman") {
				const phrase = String(parsed.phrase || "").trim().replace(/\s+/g, " ").slice(0, 80);
				if (phrase.length < 2 || !/[A-Za-z0-9]/.test(phrase)) return this.sendError(connection, "Enter a Hangman word or phrase between 2 and 80 characters.");
				this.game = {
					type: "hangman",
					status: "active",
					host: this.publicName(state),
					phrase,
					guessed: [],
					wrong: 0,
					maxWrong: 6,
					winner: null,
					log: [`${this.publicName(state)} started Hangman.`],
					startedAt: Date.now(),
				};
				this.saveGame();
				this.broadcastGame();
				this.broadcastGameEvent(`${this.publicName(state)} started Hangman.`, "critical");
				return;
			}
			if (parsed.game === "boss") {
				const boss = ["mad_dragon", "goblin_king", "evil_wizard"].includes(String(parsed.boss)) ? parsed.boss as BossKey : "mad_dragon";
				this.startBossGame(state, boss);
				return;
			}
			return this.sendError(connection, "Choose a game to start.");
		}

		if (parsed.type === "game_end") {
			if (!this.isStaff(state)) return this.staffError(connection);
			if (!this.game) return;
			const endText = `${this.publicName(state)} cleared the game from the room.`;
			this.broadcastGameEvent(endText, "normal");
			this.game = null;
			this.saveGame();
			this.broadcastGame();
			return;
		}

		if (parsed.type === "game_hangman_guess") {
			if (!this.game || this.game.type !== "hangman" || this.game.status !== "active") return this.sendError(connection, "No Hangman game is active.");
			const game = this.game;
			const guess = String(parsed.guess || "").trim().toUpperCase();
			if (!guess || guess.length > 80) return;
			const normalizedPhrase = game.phrase.toUpperCase().replace(/\s+/g, " ").trim();
			if (guess.length === 1 && /[A-Z0-9]/.test(guess)) {
				if (game.guessed.includes(guess)) return this.sendError(connection, `${guess} was already guessed.`);
				game.guessed.push(guess);
				if (normalizedPhrase.includes(guess)) this.addGameLog(`${this.publicName(state)} guessed ${guess} — correct!`);
				else {
					game.wrong += 1;
					this.addGameLog(`${this.publicName(state)} guessed ${guess} — nope. (${game.wrong}/${game.maxWrong})`);
				}
			} else {
				const normalizedGuess = guess.replace(/\s+/g, " ").trim();
				if (normalizedGuess === normalizedPhrase) {
					game.status = "won";
					game.winner = this.publicName(state);
					this.addGameLog(`${this.publicName(state)} solved it: ${game.phrase}`);
				} else {
					game.wrong += 1;
					this.addGameLog(`${this.publicName(state)} guessed the phrase incorrectly. (${game.wrong}/${game.maxWrong})`);
				}
			}
			if (game.status === "active") {
				const needed = Array.from(normalizedPhrase).filter((char) => /[A-Z0-9]/.test(char));
				if (needed.every((char) => game.guessed.includes(char))) {
					game.status = "won";
					game.winner = this.publicName(state);
					this.addGameLog(`${this.publicName(state)} completed the phrase: ${game.phrase}`);
				} else if (game.wrong >= game.maxWrong) {
					game.status = "lost";
					this.addGameLog(`Hangman is over. The answer was: ${game.phrase}`);
				}
			}
			const latest = game.log[game.log.length - 1];
			if (latest) this.broadcastGameEvent(latest, game.status === "won" ? "good" : (game.status === "lost" ? "bad" : "normal"));
			this.saveGame();
			this.broadcastGame();
			return;
		}

		if (parsed.type === "game_boss_attack") {
			this.bossBattleAttack(state, connection);
			return;
		}

		if (parsed.type === "game_boss_skip") {
			if (!this.isStaff(state)) return this.staffError(connection);
			if (!this.game || this.game.type !== "boss" || this.game.status !== "active") return this.sendError(connection, "No boss battle is active.");
			const current = this.currentBossPlayer(this.game);
			if (!current) return;
			this.addGameLog(`${this.publicName(state)} skipped ${current.username}'s turn.`);
			const next = this.advanceBossTurn(this.game);
			if (next) this.addGameLog(`Round ${this.game.round}: ${next.username}'s turn.`);
			this.saveGame();
			this.broadcastGame();
			return;
		}

		if (parsed.type === "reaction") {
			const id = String(parsed.id || "");
			const emoji = String(parsed.emoji || "");
			const target = this.findMessage(id);
			if (!target || target.deleted || !ALLOWED_REACTIONS.has(emoji)) return;
			const existing = this.ctx.storage.sql.exec(
				`SELECT 1 AS found FROM reactions WHERE message_id = ? AND lower(username) = lower(?) AND emoji = ? LIMIT 1`,
				id, state.username, emoji,
			).toArray()[0];
			if (existing) {
				this.ctx.storage.sql.exec(`DELETE FROM reactions WHERE message_id = ? AND lower(username) = lower(?) AND emoji = ?`, id, state.username, emoji);
			} else {
				this.ctx.storage.sql.exec(`INSERT INTO reactions (message_id, username, emoji) VALUES (?, ?, ?)`, id, state.username, emoji);
			}
			this.broadcast(JSON.stringify({ type: "reaction_update", id, reactions: this.getReactionSummary(id) }));
			return;
		}

		if (parsed.type === "edit") {
			const id = String(parsed.id || "");
			const target = this.findMessage(id);
			if (!target || target.deleted || target.user.toLowerCase() !== state.username.toLowerCase()) return;
			if (target.createdAt && Date.now() - target.createdAt > EDIT_WINDOW_MS) return this.sendError(connection, "Messages can only be edited for 10 minutes.");
			const content = String(parsed.content || "").trim();
			if (!content || content.length > 1000) return;
			target.content = content;
			target.format = sanitizeFormat(parsed.format);
			target.updatedAt = Date.now();
			this.ctx.storage.sql.exec(
				`UPDATE messages SET content = ?, format_json = ?, updated_at = ? WHERE id = ?`,
				target.content, JSON.stringify(target.format), target.updatedAt, id,
			);
			this.broadcast(JSON.stringify({ type: "message_update", message: this.serializeMessage(target) }));
			return;
		}

		if (parsed.type === "delete") {
			const id = String(parsed.id || "");
			const target = this.findMessage(id);
			if (!target || target.deleted) return;
			const own = target.user.toLowerCase() === state.username.toLowerCase();
			if (!own && state.role !== "admin") return;
			target.deleted = true;
			target.content = "";
			target.format = sanitizeFormat({});
			target.replyTo = null;
			target.updatedAt = Date.now();
			this.ctx.storage.sql.exec(
				`UPDATE messages SET content = '', format_json = '{}', reply_to = NULL, deleted = 1, updated_at = ? WHERE id = ?`,
				target.updatedAt, id,
			);
			this.ctx.storage.sql.exec(`DELETE FROM reactions WHERE message_id = ?`, id);
			if (this.settings.pinnedMessageIds.includes(id)) {
				this.settings.pinnedMessageIds = this.settings.pinnedMessageIds.filter((value) => value !== id);
				this.saveRoomSettings();
				this.broadcastSettings();
			}
			this.broadcast(JSON.stringify({ type: "message_update", message: this.serializeMessage(target) }));
			return;
		}

		if (parsed.type !== "add") return;

		const commandContent = String(parsed.content || "").trim();
		if (commandContent.toLowerCase() === "/roll") {
			this.bossBattleAttack(state, connection);
			return;
		}

		const mute = this.isMuted(state.username);
		if (mute && !this.isStaff(state)) {
			const untilText = mute.until === 0 ? "until an administrator unmutes you" : `until ${new Date(mute.until).toLocaleTimeString()}`;
			return this.sendError(connection, `You are muted ${untilText}.`);
		}

		const now = Date.now();
		if (!this.isStaff(state) && this.settings.slowModeSeconds > 0) {
			const remaining = this.settings.slowModeSeconds * 1000 - (now - state.lastMessageAt);
			if (remaining > 0) return this.sendError(connection, `Slow mode: wait ${Math.ceil(remaining / 1000)} second(s).`);
		}

		const id = String(parsed.id || "").trim();
		const content = String(parsed.content || "").trim();
		if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return;
		if (content.length < 1 || content.length > 1000) return;
		if (this.messages.some((item) => item.id === id)) return;

		const replyTo = parsed.replyTo ? String(parsed.replyTo) : null;
		if (replyTo && !this.findMessage(replyTo)) return;
		const format = sanitizeFormat(parsed.format);
		const cleanMessage: StoredMessage = {
			id,
			content,
			user: state.username,
			role: this.effectiveRole(state),
			displayUser: this.publicName(state),
			displayRole: this.publicRole(state),
			format,
			replyTo,
			createdAt: now,
			updatedAt: null,
			deleted: false,
			highlightColor: null,
		};

		this.messages.push(cleanMessage);
		if (this.messages.length > HISTORY_LIMIT) this.messages = this.messages.slice(-HISTORY_LIMIT);
		this.ctx.storage.sql.exec(
			`INSERT INTO messages (id, user, role, display_user, display_role, content, format_json, reply_to, created_at, updated_at, deleted, highlight_color)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, NULL)`,
			cleanMessage.id, cleanMessage.user, cleanMessage.role, cleanMessage.displayUser, cleanMessage.displayRole, cleanMessage.content,
			JSON.stringify(cleanMessage.format), cleanMessage.replyTo, cleanMessage.createdAt,
		);
		connection.setState({ ...state, lastMessageAt: now });
		this.broadcast(JSON.stringify({ type: "add", ...this.serializeMessage(cleanMessage) }));
	}

	adminError(connection: Connection) {
		this.sendError(connection, "Administrator access required.");
	}

	staffError(connection: Connection) {
		this.sendError(connection, "Administrator or MOD access required.");
	}

	sendError(connection: Connection, message: string) {
		connection.send(JSON.stringify({ type: "error", message }));
	}
}

export default {
	async fetch(request: Request, env: Env) {
		const routed = await routePartykitRequest(
			request,
			{ ...env },
			{
				onBeforeConnect: async (req, lobby) => {
					if (lobby.name !== "lobby") return new Response("Room not found.", { status: 404 });
					const origin = req.headers.get("Origin");
					if (origin !== ALLOWED_ORIGIN) return new Response("Forbidden.", { status: 403 });

					const url = new URL(req.url);
					const token = url.searchParams.get("token");
					if (!token) return new Response("Login required.", { status: 401 });

					const authResponse = await env.AUTH.fetch(
						new Request("https://chatroom.internal/me", {
							method: "GET",
							headers: { Authorization: `Bearer ${token}` },
						}),
					);
					if (!authResponse.ok) return new Response("Invalid session.", { status: 401 });

					const authData = await authResponse.json() as {
						ok?: boolean;
						user?: { username?: string; role?: string; chat_name_color?: string | null; chat_badge?: string | null };
					};
					if (!authData.ok || !authData.user?.username) return new Response("Invalid session.", { status: 401 });

					url.searchParams.delete("token");
					const forwarded = new Request(url.toString(), req);
					forwarded.headers.set("x-chat-username", authData.user.username);
					forwarded.headers.set("x-chat-role", authData.user.role || "user");
					if (authData.user.chat_name_color) forwarded.headers.set("x-chat-name-color", authData.user.chat_name_color);
					if (authData.user.chat_badge) forwarded.headers.set("x-chat-badge", authData.user.chat_badge);
					return forwarded;
				},
			},
		);

		if (routed) return routed;
		return env.ASSETS.fetch(request);
	},
} satisfies ExportedHandler<Env>;
