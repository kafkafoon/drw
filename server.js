const { WebSocketServer } = require('ws');
const axios = require('axios');

const PORT = process.env.PORT || 8080;

const wss = new WebSocketServer({ port: PORT, host: '0.0.0.0' });
console.log(`Signaling server active on port: ${PORT}`);

const rooms = new Map();

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

    const auth = Buffer.from(`${ident}:${secret}`).toString('base64');

    const response = await axios.put(
        `https://global.xirsys.net/_turn/${encodeURIComponent(channel)}?webrtc=1`,
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

    return response.data.v.iceServers;
}

wss.on('connection', async (ws) => {
    console.log("🔥🔥🔥 A CLIENT CONNECTED TO WEBSOCKET 🔥🔥🔥");
    let currentRoom = null;
    let isHost = false;
	
    try {
        const iceServers = await getXirsysIceServers();

        ws.send(JSON.stringify({
            type: "ice_config",
            iceServers: iceServers
        }));

        console.log("Sent Xirsys ICE configuration to client.");
    } catch (error) {
        console.error("Failed to get Xirsys ICE servers:", error.message);

        ws.send(JSON.stringify({
            type: "error",
            message: "Failed to obtain TURN configuration."
        }));
    }

    ws.on('message', (message) => {
        // --- FORCE STRING CONVERSION TO PREVENT SILENT DROPS ---
	console.log("🔥 SERVER RECEIVED A MESSAGE");

        const messageString = message.toString('utf8'); 
        let data;
        try {
            data = JSON.parse(messageString);
        } catch(e) {
            return;
        }

	console.log("📨 Message type:", data.type);

        if (data.type === "create") {
            currentRoom = data.room;
            isHost = true;
            rooms.set(currentRoom, { host: ws, client: null });
            console.log(`Lobby Created -> ${currentRoom}`);
        }

        if (data.type === "join") {
            currentRoom = data.room;
            const room = rooms.get(currentRoom);
            console.log(`JOIN REQUEST -> Room: ${currentRoom}`);
    	    console.log(`Rooms currently available:`, [...rooms.keys()]);
            if (room && !room.client) {
                console.log(`✓ Lobby Joined -> ${currentRoom}`);
        	console.log(`Host exists: ${!!room.host}`);
      		console.log(`Client exists: ${!!room.client}`);
                room.client = ws;
                isHost = false;
                console.log(`Lobby Joined -> ${currentRoom}`);
                if (room.host) {
           	    console.log(`→ Sending client_joined to host`);

            	    const result = room.host.send(
                    JSON.stringify({
                    	type: "client_joined"
                    })
                    );

            	    console.log(`→ client_joined send result:`, result);
        	} else {
            	    console.log(`❌ ERROR: Room has no host!`);
        	}
	
    	} else {
            console.log(`❌ Room full/invalid: ${currentRoom}`);
            ws.send(JSON.stringify({ type: "error", message: "Room full/invalid" }));
        }}

        if (data.type === "webrtc_signal") {
            const room = rooms.get(currentRoom);
            if (room) {
                const target = isHost ? room.client : room.host;
                if (target) {
                    target.send(JSON.stringify({ type: "webrtc_signal", payload: data.payload }));
                }
            }
        }
        if (data.type === "close_lobby") {
            if (rooms.has(currentRoom)) {
                console.log(`Lobby Cleared (via Explicit Packet) -> ${currentRoom}`);
                rooms.delete(currentRoom);
            }
        }
    });

    ws.on('close', () => {
        if (currentRoom && rooms.has(currentRoom)) {
            console.log(`Lobby Cleared -> ${currentRoom}`);
            rooms.delete(currentRoom);
        }
    });
});