import {
	type Connection,
	type ConnectionContext,
	Server,
	type WSMessage,
	routePartykitRequest,
} from "partyserver";

import type {
	ChatMessage,
	Message,
} from "../shared";


const ALLOWED_ORIGIN =
	"https://drkodoom.github.io";


type ChatConnectionState = {
	username: string;
	role: string;
	joinedAt: number;
};


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


	// ==================================================
	// PRESENCE HELPERS
	// ==================================================

	getOnlineUsers(
		excludeConnectionId?: string
	) {

		const users =
			new Set<string>();


		for (
			const connection
			of this.getConnections<ChatConnectionState>()
		) {

			if (
				excludeConnectionId &&
				connection.id ===
					excludeConnectionId
			) {
				continue;
			}


			const username =
				connection.state?.username;


			if (username) {
				users.add(username);
			}
		}


		return Array
			.from(users)
			.sort(
				(a, b) =>
					a.localeCompare(
						b,
						undefined,
						{
							sensitivity:
								"base",
						}
					)
			);
	}


	isUsernameOnline(
		username: string,
		excludeConnectionId?: string
	) {

		for (
			const connection
			of this.getConnections<ChatConnectionState>()
		) {

			if (
				excludeConnectionId &&
				connection.id ===
					excludeConnectionId
			) {
				continue;
			}


			if (
				connection.state?.username ===
					username
			) {
				return true;
			}
		}


		return false;
	}


	broadcastPresence(
		excludeConnectionId?: string
	) {

		this.broadcast(
			JSON.stringify({
				type: "presence",

				users:
					this.getOnlineUsers(
						excludeConnectionId
					),
			})
		);
	}


	broadcastSystem(
		event: "join" | "leave",
		username: string
	) {

		this.broadcast(
			JSON.stringify({
				type: "system",
				event,
				username,
			})
		);
	}


	// ==================================================
	// CONNECTION OPENED
	// ==================================================

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


		/*
		 * Check BEFORE assigning this
		 * connection's state so opening
		 * another tab does not make the
		 * same username "join" twice.
		 */

		const alreadyOnline =
			this.isUsernameOnline(
				username,
				connection.id
			);


		connection.setState({
			username,
			role,
			joinedAt:
				Date.now(),
		});


		/*
		 * Send message history to the
		 * person who just connected.
		 */

		connection.send(
			JSON.stringify({
				type: "all",
				messages:
					this.messages,
			} satisfies Message)
		);


		/*
		 * Announce a user only when
		 * their FIRST connection joins.
		 */

		if (!alreadyOnline) {

			this.broadcastSystem(
				"join",
				username
			);
		}


		this.broadcastPresence();
	}


	// ==================================================
	// CONNECTION CLOSED
	// ==================================================

	onClose(
		connection: Connection
	) {

		const state =
			connection.state as
				ChatConnectionState | null;


		const username =
			state?.username;


		if (!username) {
			return;
		}


		/*
		 * Ignore this closing connection
		 * when checking whether the same
		 * username is still connected in
		 * another tab/device.
		 */

		const stillOnline =
			this.isUsernameOnline(
				username,
				connection.id
			);


		if (!stillOnline) {

			this.broadcastSystem(
				"leave",
				username
			);
		}


		this.broadcastPresence(
			connection.id
		);
	}


	// ==================================================
	// CHAT MESSAGE
	// ==================================================

	onMessage(
		connection: Connection,
		message: WSMessage
	) {

		if (
			typeof message !==
				"string"
		) {
			return;
		}


		let parsed: Message;


		try {

			parsed =
				JSON.parse(
					message
				) as Message;

		} catch {

			return;
		}


		if (
			parsed.type !== "add"
		) {
			return;
		}


		const state =
			connection.state as
				ChatConnectionState | null;


		const username =
			state?.username;


		if (!username) {
			return;
		}


		const id =
			String(
				parsed.id || ""
			)
				.trim();


		const content =
			String(
				parsed.content || ""
			)
				.trim();


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


		const existing =
			this.messages.find(
				item =>
					item.id === id
			);


		if (existing) {
			return;
		}


		const cleanMessage:
			ChatMessage = {

			id,

			content,

			/*
			 * IMPORTANT:
			 * Username comes from the
			 * authenticated connection,
			 * NOT from client JSON.
			 */

			user:
				username,

			role:
				"user",
		};


		this.messages.push(
			cleanMessage
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
			cleanMessage.content
		);


		const outgoing:
			Message = {

			type: "add",

			...cleanMessage,
		};


		this.broadcast(
			JSON.stringify(
				outgoing
			)
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
				{
					...env,
				},
				{
					onBeforeConnect:
						async (
							req,
							lobby
						) => {

							/*
							 * Only ONE shared room.
							 */

							if (
								lobby.name !==
									"lobby"
							) {

								return new Response(
									"Room not found.",
									{
										status:
											404,
									}
								);
							}


							/*
							 * Connections must
							 * originate from your
							 * GitHub Pages site.
							 */

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
										status:
											403,
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
										status:
											401,
									}
								);
							}


							/*
							 * Ask the existing
							 * authentication Worker
							 * who this person is.
							 */

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
										status:
											401,
									}
								);
							}


							const authData =
								await authResponse
									.json() as {

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
										status:
											401,
									}
								);
							}


							/*
							 * Never pass the session
							 * token into the Durable
							 * Object itself.
							 */

							url.searchParams.delete(
								"token"
							);


							const forwarded =
								new Request(
									url.toString(),
									req
								);


							forwarded.headers.set(
								"x-chat-username",
								authData.user
									.username
							);


							forwarded.headers.set(
								"x-chat-role",
								authData.user
									.role ||
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
