const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

// ── SUPABASE CONFIG ──
const SB_URL = process.env.SB_URL || 'https://caossvejzjutuwqsjdxc.supabase.co';
const SB_KEY = process.env.SB_KEY || 'sb_publishable_-I-ilTRgOdHHcHv2s7rJ7g_ecncNr46';
const sb = createClient(SB_URL, SB_KEY);

// ── SERVEER BESTANDEN ──
app.use(express.static(__dirname));

// Deze regels lossen de "Cannot GET /" op
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/auth.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'auth.html'));
});

// ── GAME STATE ──
const rooms = {};

io.on('connection', (socket) => {
    console.log('Nieuwe verbinding:', socket.id);

    socket.on('createRoom', async ({ userId }) => {
        try {
            const { data, error } = await sb.from('profiles').select('username').eq('id', userId).single();
            if (error) throw error;

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
                lastDiscardCount: 1
            };
            joinPlayer(socket, code, data.username, userId);
        } catch (e) {
            socket.emit('error', 'Kon profiel niet laden. Ben je ingelogd?');
        }
    });

    socket.on('joinRoom', async ({ code, userId }) => {
        const room = rooms[code];
        if (!room) return socket.emit('error', 'Kamer niet gevonden!');
        try {
            const { data, error } = await sb.from('profiles').select('username').eq('id', userId).single();
            if (error) throw error;
            joinPlayer(socket, code, data.username, userId);
        } catch (e) {
            socket.emit('error', 'Kon profiel niet laden.');
        }
    });

    function joinPlayer(socket, code, username, userId) {
        const room = rooms[code];
        socket.join(code);
        socket.roomCode = code;
        room.players[socket.id] = { name: username, userId, hand: [], handCount: 0 };
        if (!room.playerOrder.includes(socket.id)) room.playerOrder.push(socket.id);
        room.totals[socket.id] = room.totals[socket.id] || 0;
        io.to(code).emit('updateState', { ...room, myRoomCode: code });
    }

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

    socket.on('drawFromDeck', () => {
        const room = rooms[socket.roomCode];
        if (!room || room.turn !== socket.id || room.roundState !== 'DRAW') return;
        room.players[socket.id].hand.push(room.deck.pop());
        room.roundState = 'DISCARD';
        io.to(socket.roomCode).emit('updateState', room);
    });

    socket.on('drawFromOpen', () => {
        const room = rooms[socket.roomCode];
        if (!room || room.turn !== socket.id || room.roundState !== 'DRAW') return;
        const count = room.lastDiscardCount || 1;
        const targetIdx = room.tableStack.length - count - 1;
        if (targetIdx < 0) return;
        room.players[socket.id].hand.push(room.tableStack.splice(targetIdx, 1)[0]);
        room.roundState = 'DISCARD';
        io.to(socket.roomCode).emit('updateState', room);
    });

    socket.on('discard', ({ indices }) => {
        const room = rooms[socket.roomCode];
        if (!room || room.turn !== socket.id || room.roundState !== 'DISCARD') return;
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
        if (!room || room.turn !== socket.id) return;
        room.status = 'REVEAL';
        const results = {};
        room.playerOrder.forEach(id => {
            const pts = room.players[id].hand.reduce((sum, c) => sum + (c.v === 0 ? -5 : (c.v === 11 ? -1 : (c.v >= 12 ? 10 : c.v))), 0);
            results[id] = { hand: room.players[id].hand, ptsThisRound: pts };
            room.totals[id] += pts;
        });
        room.revealData = { results };
        io.to(socket.roomCode).emit('updateState', room);
    });

    socket.on('nextRound', () => {
        const room = rooms[socket.roomCode];
        if (room && socket.id === room.hostId) {
            room.status = 'LOBBY';
            io.to(socket.roomCode).emit('updateState', room);
        }
    });

    socket.on('disconnect', () => {
        const code = socket.roomCode;
        if (rooms[code]) {
            rooms[code].playerOrder = rooms[code].playerOrder.filter(id => id !== socket.id);
            delete rooms[code].players[socket.id];
            if (rooms[code].playerOrder.length === 0) delete rooms[code];
            else if (rooms[code].hostId === socket.id) rooms[code].hostId = rooms[code].playerOrder[0];
            io.to(code).emit('updateState', rooms[code]);
        }
    });
});

function createDeck() {
    const suits = ['♥','♦','♣','♠'];
    const deck = [{v:0, s:'JK'}, {v:0, s:'JK'}];
    for(let s of suits) { for(let v=1; v<=13; v++) { deck.push({v,s}); }}
    return deck.sort(() => Math.random() - 0.5);
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`✅ Server draait op poort ${PORT}`));
