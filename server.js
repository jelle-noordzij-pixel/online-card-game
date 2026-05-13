const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const { createClient } = require('@supabase/supabase-js');

const sb = createClient(process.env.SB_URL, process.env.SB_KEY);

// Hier slaan we alle actieve kamers op
const rooms = {}; 

io.on('connection', (socket) => {

    // HOEST MAAKT EEN KAMER AAN
    socket.on('createRoom', async ({ userId }) => {
        const { data } = await sb.from('profiles').select('is_premium, username').eq('id', userId).single();
        const code = Math.floor(1000 + Math.random() * 9000).toString(); // 4-cijferige code
        
        rooms[code] = {
            status: 'LOBBY',
            hostId: socket.id,
            players: {},
            playerOrder: [],
            totals: {},
            tableStack: [],
            deck: [],
            turn: null,
            roundState: 'DRAW',
            rules: { limit: 100 }
        };

        joinPlayerToRoom(socket, code, data.username, userId);
    });

    // SPELER JOINT EEN BESTAANDE KAMER
    socket.on('joinRoom', async ({ code, userId }) => {
        if (!rooms[code]) return socket.emit('error', 'Code niet gevonden!');
        const { data } = await sb.from('profiles').select('username').eq('id', userId).single();
        
        joinPlayerToRoom(socket, code, data.username, userId);
    });

    function joinPlayerToRoom(socket, code, username, userId) {
        const room = rooms[code];
        socket.join(code);
        socket.roomCode = code;

        room.players[socket.id] = { name: username, userId, hand: [], handCount: 0 };
        if (!room.playerOrder.includes(socket.id)) room.playerOrder.push(socket.id);
        room.totals[socket.id] = room.totals[socket.id] || 0;

        io.to(code).emit('updateState', { ...room, myRoomCode: code });
    }

    // SPEL STARTEN (Alleen door Host)
    socket.on('startGame', () => {
        const room = rooms[socket.roomCode];
        if (!room || socket.id !== room.hostId) return;

        room.status = 'PLAYING';
        room.deck = createDeck();
        room.playerOrder.forEach(id => {
            room.players[id].hand = [room.deck.pop(), room.deck.pop(), room.deck.pop(), room.deck.pop()];
            room.players[id].handCount = 4;
        });
        room.tableStack = [room.deck.pop()];
        room.turn = room.playerOrder[0];
        room.roundState = 'DRAW';

        io.to(socket.roomCode).emit('updateState', room);
    });

    // ... (Hier komen de rest van je spel-logica functies zoals discard, draw, etc.)
    // Zorg dat je bij elke actie 'const room = rooms[socket.roomCode]' gebruikt!
});

function createDeck() {
    const suits = ['♥','♦','♣','♠'];
    const deck = [{v:0, s:'JK'}, {v:0, s:'JK'}];
    for(let s of suits) { for(let v=1; v<=13; v++) { deck.push({v,s}); }}
    return deck.sort(() => Math.random() - 0.5);
}

http.listen(process.env.PORT || 3000);
