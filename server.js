const { WebSocketServer } = require('ws');
const axios = require('axios');

const PORT = process.env.PORT || 8080;

const wss = new WebSocketServer({
    port: PORT,
    host: '0.0.0.0'
});

console.log(`Signaling server active on port: ${PORT}`);

const rooms = new Map();


// ============================================================
// XIRSYS
// ============================================================

async function getXirsysIceServers() {
    const ident = process.env.XIRSYS_IDENT;
    const secret = process.env.XIRSYS_SECRET;
    const channel = process.env.XIRSYS_CHANNEL;

    console.log("Xirsys configuration:");
    console.log("IDENT exists:", !!ident);
    console.log("SECRET exists:", !!secret);
    console.log("CHANNEL:", channel);

    if (!ident || !secret || !channel) {
        throw new Error("Missing Xirsys environment variables");
    }

    const auth = Buffer
        .from(`${ident}:${secret}`)
        .toString('base64');

    const url =
        `https://global.xirsys.net/_turn/${encodeURIComponent(channel)}?webrtc=1`;

    const response = await axios.put(
        url,
        {},
        {
            headers: {
                "Authorization": `Basic ${auth}`,
                "Content-Type": "application/json"
            }
        }
    );

    if (!response.data || response.data.s !== "ok") {
        throw new Error(
            `Xirsys error: ${JSON.stringify(response.data)}`
        );
    }

    if (!response.data.v || !response.data.v.iceServers) {
        throw new Error("Xirsys did not return iceServers");
    }

    return response.data.v.iceServers;
}


// ============================================================
// WEBSOCKET CONNECTION
// ============================================================

wss.on('connection', async (ws) => {

    console.log("🔥🔥🔥 A CLIENT CONNECTED TO WEBSOCKET 🔥🔥🔥");

    let currentRoom = null;
    let isHost = false;


    // --------------------------------------------------------
    // RECEIVE MESSAGES
    // --------------------------------------------------------

    ws.on('message', (message) => {

        console.log("🔥 SERVER RECEIVED A MESSAGE");

        const messageString = message.toString('utf8');

        console.log("Raw message:", messageString);

        let data;

        try {
            data = JSON.parse(messageString);
        } catch (e) {
            console.log("❌ Invalid JSON received");
            return;
        }

        console.log("📨 Message type:", data.type);


        // ====================================================
        // CREATE ROOM
        // ====================================================

        if (data.type === "create") {

            currentRoom = data.room;
            isHost = true;

            rooms.set(currentRoom, {
                host: ws,
                client: null
            });

            console.log(
                `✓ Lobby Created -> ${currentRoom}`
            );

            console.log(
                "Current rooms:",
                [...rooms.keys()]
            );

            return;
        }


        // ====================================================
        // JOIN ROOM
        // ====================================================

        if (data.type === "join") {

            currentRoom = data.room;

            console.log(
                `JOIN REQUEST -> Room: ${currentRoom}`
            );

            console.log(
                "Rooms currently available:",
                [...rooms.keys()]
            );

            const room = rooms.get(currentRoom);


            if (room && !room.client) {

                room.client = ws;
                isHost = false;

                console.log(
                    `✓ Lobby Joined -> ${currentRoom}`
                );

                console.log(
                    `Host exists: ${!!room.host}`
                );

                console.log(
                    `Client exists: ${!!room.client}`
                );


                if (room.host) {

                    console.log(
                        "→ Sending client_joined to host"
                    );

                    room.host.send(
                        JSON.stringify({
                            type: "client_joined"
                        })
                    );

                    console.log(
                        "✓ client_joined sent"
                    );

                } else {

                    console.log(
                        "❌ ERROR: Room has no host"
                    );
                }

            } else {

                console.log(
                    `❌ Room full/invalid: ${currentRoom}`
                );

                ws.send(
                    JSON.stringify({
                        type: "error",
                        message: "Room full/invalid"
                    })
                );
            }

            return;
        }


        // ====================================================
        // WEBRTC SIGNAL
        // ====================================================

        if (data.type === "webrtc_signal") {

            const room = rooms.get(currentRoom);

            if (!room) {
                console.log(
                    "❌ WebRTC signal received but room doesn't exist"
                );
                return;
            }

            const target =
                isHost
                    ? room.client
                    : room.host;

            if (target) {

                console.log(
                    `→ Relaying WebRTC signal from ${
                        isHost ? "host" : "client"
                    }`
                );

                target.send(
                    JSON.stringify({
                        type: "webrtc_signal",
                        payload: data.payload
                    })
                );

            } else {

                console.log(
                    "❌ No target available for WebRTC signal"
                );
            }

            return;
        }


        // ====================================================
        // CLOSE LOBBY
        // ====================================================

        if (data.type === "close_lobby") {

            if (rooms.has(currentRoom)) {

                console.log(
                    `Lobby Cleared -> ${currentRoom}`
                );

                rooms.delete(currentRoom);
            }

            return;
        }


        console.log(
            `⚠️ Unknown message type: ${data.type}`
        );
    });


    // --------------------------------------------------------
    // DISCONNECT
    // --------------------------------------------------------

    ws.on('close', () => {

        console.log(
            `WebSocket disconnected. Room: ${currentRoom}`
        );

        if (currentRoom && rooms.has(currentRoom)) {

            console.log(
                `Lobby Cleared -> ${currentRoom}`
            );

            rooms.delete(currentRoom);
        }
    });


    ws.on('error', (error) => {

        console.error(
            "WebSocket error:",
            error.message
        );
    });

    // --------------------------------------------------------
    // Send Xirsys configuration
    // --------------------------------------------------------

    try {

        const rawIceServers = await getXirsysIceServers();
	const iceServers = filterIceServersForLibjuice(rawIceServers)

        ws.send(JSON.stringify({
            type: "ice_config",
            iceServers: iceServers
        }));

        console.log("Sent Xirsys ICE configuration to client.");

    } catch (error) {

        console.error(
            "Failed to get Xirsys ICE servers:",
            error.message
        );

        ws.send(JSON.stringify({
            type: "error",
            message: "Failed to obtain TURN configuration."
        }));
    }



});

function filterIceServersForLibjuice(iceServers) {
    const filtered = [];

    for (const server of iceServers) {
        const urls = Array.isArray(server.urls)
            ? server.urls
            : [server.urls];

        const supportedUrls = urls.filter(url => {
            // STUN is supported
            if (url.startsWith("stun:")) {
                return true;
            }

            // Only allow TURN over UDP.
            if (url.startsWith("turn:")) {
                return !url.includes("transport=tcp");
            }

            // Reject TURN-over-TLS ("turns:")
            return false;
        });

        if (supportedUrls.length > 0) {
            filtered.push({
                ...server,
                urls: supportedUrls
            });
        }
    }

    return filtered;
}