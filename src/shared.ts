export type ChatRole = "user" | "mod" | "admin" | "assistant";

export type MessageFormat = {
	bold?: boolean;
	italic?: boolean;
	underline?: boolean;
	strike?: boolean;
	color?: string;
	size?: "small" | "normal" | "large";
};

export type ChatMessage = {
	id: string;
	content: string;
	user: string;
	role: ChatRole;
	format?: MessageFormat;
	replyTo?: string | null;
	createdAt?: number;
	updatedAt?: number | null;
	deleted?: boolean;
	highlightColor?: string | null;
	reactions?: Record<string, number>;
};

// Kept for compatibility with the original Cloudflare Durable Chat template
// client that Wrangler still bundles during deployment.
export type Message =
	| ({ type: "add" } & ChatMessage)
	| ({ type: "update" } & ChatMessage)
	| {
			type: "all";
			messages: ChatMessage[];
	  };

// The template client still imports this list during its build. The private
// DRKODOOM frontend does not use these names for authenticated users.
export const names = [
	"Alice",
	"Bob",
	"Charlie",
	"David",
	"Eve",
	"Frank",
	"Grace",
	"Heidi",
	"Ivan",
	"Judy",
	"Kevin",
	"Linda",
	"Mallory",
	"Nancy",
	"Oscar",
	"Peggy",
	"Quentin",
	"Randy",
	"Steve",
	"Trent",
	"Ursula",
	"Victor",
	"Walter",
	"Xavier",
	"Yvonne",
	"Zoe",
];
