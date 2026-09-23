const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;

const wss = new WebSocketServer({ port: PORT, host: '0.0.0.0' });
console.log(`Signaling server active on port: ${PORT}`);

const rooms = new Map();

wss.on('connection', (ws) => {
    let currentRoom = null;
    let isHost = false;

    ws.on('message', (message) => {
        // --- FORCE STRING CONVERSION TO PREVENT SILENT DROPS ---
        const messageString = message.toString('utf8'); 
        let data;
        try {
            data = JSON.parse(messageString);
        } catch(e) {
            return;
        }

        if (data.type === "create") {
            currentRoom = data.room;
            isHost = true;
            rooms.set(currentRoom, { host: ws, client: null });
            console.log(`Lobby Created -> ${currentRoom}`);
        }

        if (data.type === "join") {
            currentRoom = data.room;
            const room = rooms.get(currentRoom);
            if (room && !room.client) {
                room.client = ws;
                isHost = false;
                console.log(`Lobby Joined -> ${currentRoom}`);
                room.host.send(JSON.stringify({ type: "client_joined" }));
            } else {
                ws.send(JSON.stringify({ type: "error", message: "Room full/invalid" }));
            }
        }

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