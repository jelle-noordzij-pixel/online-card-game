const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { createClient } = require('@supabase/supabase-js');
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

// ── SUPABASE CONFIG ──
const SB_URL = process.env.SB_URL || 'https://caossvejzjutuwqsjdxc.supabase.co';
const SB_KEY = process.env.SB_KEY || 'sb_publishable_-I-ilTRgOdHHcHv2s7rJ7g_ecncNr46';
const sb = createClient(SB_URL, SB_KEY);

// Routes
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/auth.html', (req, res) => res.sendFile(path.join(__dirname, 'auth.html')));

const rooms = {}; 
const suits = ['♥', '♦', '♣', '♠'];

// ── HELPERS ──
function buildDeck() {
    let d = [];
    for (let v = 1; v <= 13; v++) for (let s of suits) d.push({ v, s });
    for (let i = 0; i < 3; i++) d.push({ v: 0, s: null });
    return d.sort(() => Math.random() - 0.5);
}

function calcHand(hand) {
    return hand.filter(x => x).reduce((acc, c) => {
        if (c.v === 0)  return acc;
        if (c.v === 1)  return acc + 1;
        if (c.v === 11) return acc - 1;
        if (c.v >= 12)  return acc + 10;
        return acc + c.v;
    }, 0);
}

function sendState(roomCode) {
    const g = rooms[roomCode];
    if (!g) return;
    g.playerOrder.forEach(id => {
        const view = {
            playerOrder: g.playerOrder,
            players: {},
            tableStack: g.tableStack,
            turn: g.turn,
            roundState: g.roundState,
            lastDiscardCount: g.lastDiscardCount,
            status: g.status,
            totals: g.totals,
            rules: g.rules,
            revealData: g.revealData,
            hostId: g.hostId,
            deckCount: g.deck.length,
            myRoomCode: roomCode
        };
        g.playerOrder.forEach(pid => {
            view.players[pid] = {
                name: g.players[pid].name,
                handCount: g.players[pid].hand.filter(x => x).length,
                hand: pid === id ? g.players[pid].hand : null,
            };
        });
        io.to(id).emit('updateState', view);
    });
}

// ── SOCKETS ──
io.on("connection", (socket) => {
    socket.on("createRoom", async ({ userId }) => {
        try {
            const { data, error } = await sb.from('profiles').select('username').eq('id', userId).single();
            if (error) throw error;
            
            const code = Math.floor(1000 + Math.random() * 9000).toString();
            rooms[code] = {
                players: {}, playerOrder: [], deck: [], tableStack: [],
                turnIndex: 0, status: 'LOBBY', turn: null, roundState: 'DISCARD',
                lastDiscardCount: 0, extraCards: {}, totals: {},
                rules: { limit: 100 }, revealData: null, hostId: socket.id
            };
            joinPlayerToRoom(socket, code, data.username);
        } catch (e) {
            socket.emit('error', 'Database fout: log opnieuw in.');
        }
    });

    socket.on("joinRoom", async ({ code, userId }) => {
        const room = rooms[code];
        if (!room) return socket.emit('error', 'Code niet gevonden!');
        try {
            const { data } = await sb.from('profiles').select('username').eq('id', userId).single();
            joinPlayerToRoom(socket, code, data.username);
        } catch (e) { socket.emit('error', 'Fout bij joinen.'); }
    });

    function joinPlayerToRoom(socket, code, username) {
        const g = rooms[code];
        socket.join(code);
        socket.roomCode = code;
        g.players[socket.id] = { id: socket.id, name: username || "Speler", hand: [] };
        if (!g.playerOrder.includes(socket.id)) g.playerOrder.push(socket.id);
        g.totals[socket.id] = g.totals[socket.id] || 0;
        sendState(code);
    }

    socket.on("startGame", () => {
        const g = rooms[socket.roomCode];
        if (g && socket.id === g.hostId) {
            g.deck = buildDeck();
            g.playerOrder.forEach(id => {
                g.players[id].hand = g.deck.splice(0, 5);
            });
            g.tableStack = [g.deck.pop()];
            g.turn = g.playerOrder[0];
            g.status = 'PLAYING';
            sendState(socket.roomCode);
        }
    });

    socket.on("discard", ({ indices }) => {
        const g = rooms[socket.roomCode];
        if (!g || socket.id !== g.turn) return;
        const hand = g.players[socket.id].hand;
        const cards = indices.map(i => hand[i]).filter(c => c);
        if (cards.every(c => c.v === cards[0].v)) {
            g.tableStack.push(...cards);
            g.lastDiscardCount = cards.length;
            const sortedDesc = [...indices].sort((a, b) => b - a);
            sortedDesc.forEach(i => hand.splice(i, 1));
            g.roundState = 'DRAW';
            sendState(socket.roomCode);
        }
    });

    socket.on("drawFromDeck", () => {
        const g = rooms[socket.roomCode];
        if (g?.turn === socket.id && g.roundState === 'DRAW') {
            g.players[socket.id].hand.push(g.deck.pop());
            nextTurn(socket.roomCode);
        }
    });

    socket.on("drawFromOpen", () => {
        const g = rooms[socket.roomCode];
        if (g?.turn === socket.id && g.roundState === 'DRAW') {
            g.players[socket.id].hand.push(g.tableStack.pop());
            nextTurn(socket.roomCode);
        }
    });

    function nextTurn(roomCode) {
        const g = rooms[roomCode];
        g.turnIndex = (g.turnIndex + 1) % g.playerOrder.length;
        g.turn = g.playerOrder[g.turnIndex];
        g.roundState = 'DISCARD';
        sendState(roomCode);
    }

    socket.on("call", () => {
        const g = rooms[socket.roomCode];
        if (!g || socket.id !== g.turn) return;
        g.status = 'REVEAL';
        const results = {};
        g.playerOrder.forEach(id => {
            const score = calcHand(g.players[id].hand);
            g.totals[id] += score;
            results[id] = { score, hand: g.players[id].hand, total: g.totals[id] };
        });
        g.revealData = { caller: socket.id, results };
        sendState(socket.roomCode);
    });

    socket.on("nextRound", () => {
        const g = rooms[socket.roomCode];
        if (g && socket.id === g.hostId) {
            g.status = 'LOBBY'; // Of direct resetRound
            sendState(socket.roomCode);
        }
    });
});

server.listen(process.env.PORT || 3000);
