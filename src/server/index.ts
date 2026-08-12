import {
	type Connection,
	type ConnectionContext,
	Server,
	type WSMessage,
	routePartykitRequest,
} from "partyserver";

import type { ChatMessage } from "../shared";

const ALLOWED_ORIGIN = "https://drkodoom.github.io";

type ChatConnectionState = {
	username: string;
	role: string;
	joinedAt: number;
};

type ClientMessage =
	| { type: "add"; id?: string; content?: string }
	| { type: "ping"; time?: number }
	| { type: "clear_room" };

export class Chat extends Server<Env> {
	static options = { hibernate: true };

	messages: ChatMessage[] = [];

	onStart() {
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS messages (
				id TEXT PRIMARY KEY,
				user TEXT,
				role TEXT,
				content TEXT
			)
		`);

		this.messages = this.ctx.storage.sql
			.exec(`SELECT * FROM messages`)
			.toArray() as ChatMessage[];
	}

	getOnlineUsers(excludeConnectionId?: string) {
		const users = new Set<string>();

		for (const connection of this.getConnections<ChatConnectionState>()) {
			if (excludeConnectionId && connection.id === excludeConnectionId) {
				continue;
			}

			const username = connection.state?.username;

			if (username) {
				users.add(username);
			}
		}

		return Array.from(users).sort((a, b) =>
			a.localeCompare(
				b,
				undefined,
				{ sensitivity: "base" },
			),
		);
	}

	isUsernameOnline(
		username: string,
		excludeConnectionId?: string,
	) {
		for (const connection of this.getConnections<ChatConnectionState>()) {
			if (excludeConnectionId && connection.id === excludeConnectionId) {
				continue;
			}

			if (connection.state?.username === username) {
				return true;
			}
		}

		return false;
	}

	broadcastPresence(excludeConnectionId?: string) {
		this.broadcast(
			JSON.stringify({
				type: "presence",
				users: this.getOnlineUsers(
					excludeConnectionId,
				),
			}),
		);
	}

	broadcastSystem(
		event: "join" | "leave",
		username: string,
	) {
		this.broadcast(
			JSON.stringify({
				type: "system",
				event,
				username,
			}),
		);
	}

	onConnect(
		connection: Connection,
		context: ConnectionContext,
	) {
		const username =
			context.request.headers.get(
				"x-chat-username",
			);

		const role =
			context.request.headers.get(
				"x-chat-role",
			) || "user";

		if (!username) {
			connection.close(
				1008,
				"Unauthorized",
			);

			return;
		}

		const alreadyOnline =
			this.isUsernameOnline(
				username,
				connection.id,
			);

		connection.setState({
			username,
			role,
			joinedAt: Date.now(),
		});

		connection.send(
			JSON.stringify({
				type: "all",
				messages: this.messages,
			}),
		);

		if (!alreadyOnline) {
			this.broadcastSystem(
				"join",
				username,
			);
		}

		this.broadcastPresence();
	}

	onClose(connection: Connection) {
		const state =
			connection.state as
				ChatConnectionState | null;

		const username =
			state?.username;

		if (!username) {
			return;
		}

		const stillOnline =
			this.isUsernameOnline(
				username,
				connection.id,
			);

		if (!stillOnline) {
			this.broadcastSystem(
				"leave",
				username,
			);
		}

		this.broadcastPresence(
			connection.id,
		);
	}

	onMessage(
		connection: Connection,
		message: WSMessage,
	) {
		if (typeof message !== "string") {
			return;
		}

		let parsed: ClientMessage;

		try {
			parsed =
				JSON.parse(
					message,
				) as ClientMessage;
		} catch {
			return;
		}

		const state =
			connection.state as
				ChatConnectionState | null;

		if (!state?.username) {
			return;
		}

		// Heartbeat
		if (parsed.type === "ping") {
			connection.send(
				JSON.stringify({
					type: "pong",
					time: Date.now(),
				}),
			);

			return;
		}

		// Admin-only permanent room clear
		if (parsed.type === "clear_room") {
			if (state.role !== "admin") {
				connection.send(
					JSON.stringify({
						type: "error",
						message:
							"Administrator access required.",
					}),
				);

				return;
			}

			this.ctx.storage.sql.exec(`
				DELETE FROM messages
			`);

			this.messages = [];

			this.broadcast(
				JSON.stringify({
					type: "clear_room",
					username:
						state.username,
				}),
			);

			return;
		}

		if (parsed.type !== "add") {
			return;
		}

		const id =
			String(
				parsed.id || "",
			).trim();

		const content =
			String(
				parsed.content || "",
			).trim();

		if (
			!/^[A-Za-z0-9_-]{1,64}$/
				.test(id)
		) {
			return;
		}

		if (
			content.length < 1 ||
			content.length > 1000
		) {
			return;
		}

		if (
			this.messages.some(
				(item) =>
					item.id === id,
			)
		) {
			return;
		}

		const cleanMessage:
			ChatMessage = {
				id,
				content,
				user:
					state.username,
				role:
					"user",
			};

		this.messages.push(
			cleanMessage,
		);

		this.ctx.storage.sql.exec(
			`
				INSERT INTO messages
				(
					id,
					user,
					role,
					content
				)

				VALUES
				(
					?,
					?,
					?,
					?
				)
			`,
			cleanMessage.id,
			cleanMessage.user,
			cleanMessage.role,
			cleanMessage.content,
		);

		this.broadcast(
			JSON.stringify({
				type: "add",
				...cleanMessage,
			}),
		);
	}
}

export default {
	async fetch(
		request: Request,
		env: Env,
	) {
		const routed =
			await routePartykitRequest(
				request,
				{
					...env,
				},
				{
					onBeforeConnect:
						async (
							req,
							lobby,
						) => {
							if (
								lobby.name !==
								"lobby"
							) {
								return new Response(
									"Room not found.",
									{
										status: 404,
									},
								);
							}

							const origin =
								req.headers.get(
									"Origin",
								);

							if (
								origin !==
								ALLOWED_ORIGIN
							) {
								return new Response(
									"Forbidden.",
									{
										status: 403,
									},
								);
							}

							const url =
								new URL(
									req.url,
								);

							const token =
								url.searchParams.get(
									"token",
								);

							if (!token) {
								return new Response(
									"Login required.",
									{
										status: 401,
									},
								);
							}

							const authResponse =
								await env.AUTH.fetch(
									new Request(
										"https://chatroom.internal/me",
										{
											method:
												"GET",

											headers: {
												Authorization:
													`Bearer ${token}`,
											},
										},
									),
								);

							if (
								!authResponse.ok
							) {
								return new Response(
									"Invalid session.",
									{
										status: 401,
									},
								);
							}

							const authData =
								(await authResponse.json()) as {
									ok?: boolean;

									user?: {
										username?:
											string;

										role?:
											string;
									};
								};

							if (
								!authData.ok ||
								!authData.user
									?.username
							) {
								return new Response(
									"Invalid session.",
									{
										status: 401,
									},
								);
							}

							// Never forward session token
							// into the Durable Object.
							url.searchParams.delete(
								"token",
							);

							const forwarded =
								new Request(
									url.toString(),
									req,
								);

							forwarded.headers.set(
								"x-chat-username",
								authData.user
									.username,
							);

							forwarded.headers.set(
								"x-chat-role",
								authData.user
									.role ||
									"user",
							);

							return forwarded;
						},
				},
			);

		if (routed) {
			return routed;
		}

		return env.ASSETS.fetch(
			request,
		);
	},
} satisfies ExportedHandler<Env>;
