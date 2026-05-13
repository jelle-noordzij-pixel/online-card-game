const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

// ── CONFIG ──
const SB_URL = process.env.SB_URL || 'https://caossvejzjutuwqsjdxc.supabase.co';
const SB_KEY = process.env.SB_KEY || 'sb_publishable_-I-ilTRgOdHHcHv2s7rJ7g_ecncNr46';
const sb = createClient(SB_URL, SB_KEY);

app.use(express.static(__dirname));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/auth.html', (req, res) => res.sendFile(path.join(__dirname, 'auth.html')));

const rooms = {};

// ── SOCKET LOGICA ──
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('createRoom', async ({ userId }) => {
        console.log('Creating room for:', userId);
        try {
            const { data, error } = await sb.from('profiles').select('username').eq('id', userId).single();
            if (error || !data) throw new Error("User niet gevonden");

            const code = Math.floor(1000 + Math.random() * 9000).toString();
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
                lastDiscardCount: 1,
                myRoomCode: code
            };
            joinPlayer(socket, code, data.username, userId);
        } catch (e) {
            console.error(e);
            socket.emit('error', 'Kon geen kamer aanmaken. Probeer opnieuw.');
        }
    });

    socket.on('joinRoom', async ({ code, userId }) => {
        const room = rooms[code];
        if (!room) return socket.emit('error', 'Kamer ' + code + ' bestaat niet.');
        
        try {
            const { data, error } = await sb.from('profiles').select('username').eq('id', userId).single();
            if (error) throw error;
            joinPlayer(socket, code, data.username, userId);
        } catch (e) {
            socket.emit('error', 'Kon niet deelnemen.');
        }
    });

    function joinPlayer(socket, code, username, userId) {
        const room = rooms[code];
        socket.join(code);
        socket.roomCode = code;
        room.players[socket.id] = { name: username, userId, hand: [], handCount: 0 };
        if (!room.playerOrder.includes(socket.id)) room.playerOrder.push(socket.id);
        room.totals[socket.id] = room.totals[socket.id] || 0;
        io.to(code).emit('updateState', room);
    }

    socket.on('startGame', () => {
        const room = rooms[socket.roomCode];
        if (!room || socket.id !== room.hostId) return;
        room.status = 'PLAYING';
        room.deck = createDeck();
        room.playerOrder.forEach(id => {
            room.players[id].hand = [room.deck.pop(), room.deck.pop(), room.deck.pop(), room.deck.pop()];
        });
        room.tableStack = [room.deck.pop()];
        room.turn = room.playerOrder[0];
        room.roundState = 'DRAW';
        io.to(socket.roomCode).emit('updateState', room);
    });

    // Overige acties (discard, draw, call) blijven hetzelfde...
    socket.on('drawFromDeck', () => {
        const room = rooms[socket.roomCode];
        if (room && room.turn === socket.id) {
            room.players[socket.id].hand.push(room.deck.pop());
            room.roundState = 'DISCARD';
            io.to(socket.roomCode).emit('updateState', room);
        }
    });

    socket.on('discard', ({ indices }) => {
        const room = rooms[socket.roomCode];
        if (!room || room.turn !== socket.id) return;
        const cards = indices.sort((a,b) => b-a).map(i => room.players[socket.id].hand.splice(i, 1)[0]);
        room.tableStack.push(...cards);
        room.lastDiscardCount = cards.length;
        const idx = room.playerOrder.indexOf(room.turn);
        room.turn = room.playerOrder[(idx + 1) % room.playerOrder.length];
        room.roundState = 'DRAW';
        io.to(socket.roomCode).emit('updateState', room);
    });

    socket.on('call', () => {
        const room = rooms[socket.roomCode];
        if (!room) return;
        room.status = 'REVEAL';
        const results = {};
        room.playerOrder.forEach(id => {
            const pts = room.players[id].hand.reduce((s, c) => s + (c.v === 0 ? -5 : c.v), 0);
            results[id] = { hand: room.players[id].hand, ptsThisRound: pts };
            room.totals[id] += pts;
        });
        room.revealData = { results };
        io.to(socket.roomCode).emit('updateState', room);
    });
});

function createDeck() {
    const suits = ['♥','♦','♣','♠'];
    const deck = [{v:0, s:'JK'}, {v:0, s:'JK'}];
    for(let s of suits) { for(let v=1; v<=13; v++) { deck.push({v,s}); }}
    return deck.sort(() => Math.random() - 0.5);
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server running on port ${PORT}`));
