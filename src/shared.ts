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
