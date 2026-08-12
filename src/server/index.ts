import {
	type Connection,
	type ConnectionContext,
	Server,
	type WSMessage,
	routePartykitRequest,
} from "partyserver";

import type { ChatMessage, Message } from "../shared";

const ALLOWED_ORIGIN = "https://drkodoom.github.io";


// ======================================================
// DURABLE CHAT ROOM
// ======================================================

export class Chat extends Server<Env> {
	static options = {
		hibernate: true,
	};

	messages = [] as ChatMessage[];


	onStart() {
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS messages (
				id TEXT PRIMARY KEY,
				user TEXT,
				role TEXT,
				content TEXT
			)
		`);

		this.messages =
			this.ctx.storage.sql
				.exec(`
					SELECT *
					FROM messages
				`)
				.toArray() as ChatMessage[];
	}


	onConnect(
		connection: Connection,
		context: ConnectionContext
	) {
		const username =
			context.request.headers.get(
				"x-chat-username"
			);

		const role =
			context.request.headers.get(
				"x-chat-role"
			) || "user";


		if (!username) {
			connection.close(
				1008,
				"Unauthorized"
			);

			return;
		}


		connection.setState({
			username,
			role,
		});


		connection.send(
			JSON.stringify({
				type: "all",
				messages: this.messages,
			} satisfies Message)
		);
	}


	onMessage(
		connection: Connection,
		message: WSMessage
	) {
		if (
			typeof message !== "string"
		) {
			return;
		}


		let parsed: Message;

		try {
			parsed =
				JSON.parse(message) as Message;
		} catch {
			return;
		}


		// For now we only permit new messages.
		if (
			parsed.type !== "add"
		) {
			return;
		}


		const state =
			connection.state as {
				username?: string;
				role?: string;
			} | null;


		const username =
			state?.username;


		if (!username) {
			return;
		}


		const id =
			String(parsed.id || "")
				.trim();


		const content =
			String(parsed.content || "")
				.trim();


		if (
			!/^[A-Za-z0-9_-]{1,64}$/.test(id)
		) {
			return;
		}


		if (
			content.length < 1 ||
			content.length > 1000
		) {
			return;
		}


		// Don't allow somebody to overwrite
		// another existing message.
		const existing =
			this.messages.find(
				item => item.id === id
			);


		if (existing) {
			return;
		}


		const cleanMessage: ChatMessage = {
			id,
			content,
			user: username,
			role: "user",
		};


		this.messages.push(
			cleanMessage
		);


		this.ctx.storage.sql.exec(
			`
				INSERT INTO messages
				(id, user, role, content)

				VALUES (?, ?, ?, ?)
			`,
			cleanMessage.id,
			cleanMessage.user,
			cleanMessage.role,
			cleanMessage.content
		);


		const outgoing: Message = {
			type: "add",
			...cleanMessage,
		};


		this.broadcast(
			JSON.stringify(outgoing)
		);
	}
}


// ======================================================
// WORKER
// ======================================================

export default {
	async fetch(
		request: Request,
		env: Env
	) {
		const routed =
			await routePartykitRequest(
				request,
				{ ...env },
				{
					onBeforeConnect:
						async (
							req,
							lobby
						) => {

							// Everyone uses ONE room.
							if (
								lobby.name !==
								"lobby"
							) {
								return new Response(
									"Room not found.",
									{
										status: 404,
									}
								);
							}


							// Only our GitHub chatroom
							// may initiate connections.
							const origin =
								req.headers.get(
									"Origin"
								);


							if (
								origin !==
								ALLOWED_ORIGIN
							) {
								return new Response(
									"Forbidden.",
									{
										status: 403,
									}
								);
							}


							const url =
								new URL(
									req.url
								);


							const token =
								url.searchParams.get(
									"token"
								);


							if (!token) {
								return new Response(
									"Login required.",
									{
										status: 401,
									}
								);
							}


							// Ask our existing
							// authentication Worker
							// whether this session is valid.
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
										}
									)
								);


							if (
								!authResponse.ok
							) {
								return new Response(
									"Invalid session.",
									{
										status: 401,
									}
								);
							}


							const authData =
								await authResponse.json() as {
									ok?: boolean;

									user?: {
										username?: string;
										role?: string;
									};
								};


							if (
								!authData.ok ||
								!authData.user?.username
							) {
								return new Response(
									"Invalid session.",
									{
										status: 401,
									}
								);
							}


							// Strip the token before
							// forwarding the request to
							// the Durable Object.
							url.searchParams.delete(
								"token"
							);


							const forwarded =
								new Request(
									url.toString(),
									req
								);


							// The Durable Object receives
							// the VERIFIED username.
							forwarded.headers.set(
								"x-chat-username",
								authData.user.username
							);


							forwarded.headers.set(
								"x-chat-role",
								authData.user.role ||
									"user"
							);


							return forwarded;
						},
				}
			);


		if (routed) {
			return routed;
		}


		return env.ASSETS.fetch(
			request
		);
	},
} satisfies ExportedHandler<Env>;
