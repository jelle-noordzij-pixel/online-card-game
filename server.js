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

// ── MULTI-ROOM STATE ──
const rooms = {}; 

// ── HELPERS ──
const suits = ['♥', '♦', '♣', '♠'];

function buildDeck() {
    let d = [];
    for (let v = 1; v <= 13; v++) for (let s of suits) d.push({ v, s });
    for (let i = 0; i < 3; i++) d.push({ v: 0, s: null });
    return d.sort(() => Math.random() - 0.5);
}

function calcHand(hand) {
    return hand.filter(x => x).reduce((acc, c) => {
        if (c.v === 0)  return acc;       // Joker = 0
        if (c.v === 1)  return acc + 1;   // Aas = 1
        if (c.v === 11) return acc - 1;   // Boer = -1
        if (c.v >= 12)  return acc + 10;  // Vrouw/Heer = 10
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

// ── SOCKET EVENTS ──
io.on("connection", (socket) => {

    socket.on("createRoom", async ({ userId }) => {
        try {
            const { data } = await sb.from('profiles').select('username').eq('id', userId).single();
            const code = Math.floor(1000 + Math.random() * 9000).toString();
            
            rooms[code] = {
                players: {},
                playerOrder: [],
                deck: [],
                tableStack: [],
                turnIndex: 0,
                status: 'LOBBY',
                turn: null,
                roundState: 'DISCARD',
                lastDiscardCount: 0,
                extraCards: {},
                totals: {},
                rules: { limit: 100, straf: { n: 5, t: 'slokken' } },
                revealData: null,
                pendingLosers: [],
                hostId: socket.id
            };

            joinPlayerToRoom(socket, code, data.username);
        } catch (e) { socket.emit('error', 'Kon geen kamer aanmaken.'); }
    });

    socket.on("joinRoom", async ({ code, userId }) => {
        const room = rooms[code];
        if (!room) return socket.emit('error', 'Code niet gevonden!');
        if (room.status !== 'LOBBY') return socket.emit('error', 'Spel is al bezig!');

        try {
            const { data } = await sb.from('profiles').select('username').eq('id', userId).single();
            joinPlayerToRoom(socket, code, data.username);
        } catch (e) { socket.emit('error', 'Fout bij ophalen profiel.'); }
    });

    function joinPlayerToRoom(socket, code, username) {
        const g = rooms[code];
        socket.join(code);
        socket.roomCode = code;

        g.players[socket.id] = { id: socket.id, name: username || "Speler", hand: [] };
        if (!g.playerOrder.includes(socket.id)) g.playerOrder.push(socket.id);
        g.totals[socket.id] = 0;
        g.extraCards[socket.id] = 0;
        
        sendState(code);
    }

    socket.on("startGame", () => {
        const g = rooms[socket.roomCode];
        if (!g || socket.id !== g.hostId) return;
        if (g.playerOrder.length < 2) return socket.emit('error', 'Minimaal 2 spelers nodig');
        
        resetRound(socket.roomCode);
    });

    function resetRound(roomCode) {
        const g = rooms[roomCode];
        g.deck = buildDeck();
        g.playerOrder.forEach(id => {
            const extra = g.extraCards[id] || 0;
            g.players[id].hand = g.deck.splice(0, 5 + extra);
            g.extraCards[id] = 0;
        });
        g.tableStack = [g.deck.pop()];
        g.turn = g.playerOrder[0];
        g.turnIndex = 0;
        g.roundState = 'DISCARD';
        g.lastDiscardCount = 0;
        g.status = 'PLAYING';
        g.revealData = null;
        g.pendingLosers = [];
        sendState(roomCode);
    }

    socket.on("discard", ({ indices }) => {
        const g = rooms[socket.roomCode];
        if (!g || g.status !== 'PLAYING' || socket.id !== g.turn || g.roundState !== 'DISCARD') return;

        const hand = g.players[socket.id].hand;
        const cards = indices.map(i => hand[i]).filter(c => c);
        if (!cards.length || !cards.every(c => c.v === cards[0].v)) {
            return socket.emit('actionError', 'ALLEEN DEZELFDE KAARTEN!');
        }

        g.tableStack.push(...cards);
        g.lastDiscardCount = cards.length;

        const sortedDesc = [...indices].sort((a, b) => b - a);
        const lowestIdx = sortedDesc[sortedDesc.length - 1];
        sortedDesc.forEach(i => {
            if (i === lowestIdx) hand[i] = null;
            else hand.splice(i, 1);
        });

        g.roundState = 'DRAW';
        sendState(socket.roomCode);
    });

    socket.on("drawFromDeck", () => {
        const g = rooms[socket.roomCode];
        if (!g || g.roundState !== 'DRAW' || socket.id !== g.turn) return;

        if (g.deck.length === 0) g.deck = buildDeck();
        const card = g.deck.pop();
        const hand = g.players[socket.id].hand;
        const slot = hand.indexOf(null);
        if (slot !== -1) hand[slot] = card; else hand.push(card);

        g.lastDiscardCount = 0;
        nextTurn(socket.roomCode);
    });

    socket.on("drawFromOpen", () => {
        const g = rooms[socket.roomCode];
        if (!g || g.roundState !== 'DRAW' || socket.id !== g.turn) return;

        const available = g.tableStack.length - g.lastDiscardCount;
        if (available <= 0) return socket.emit('actionError', 'PAK VAN HET DECK!');

        const card = g.tableStack.splice(available - 1, 1)[0];
        const hand = g.players[socket.id].hand;
        const slot = hand.indexOf(null);
        if (slot !== -1) hand[slot] = card; else hand.push(card);

        g.lastDiscardCount = 0;
        nextTurn(socket.roomCode);
    });

    function nextTurn(roomCode) {
        const g = rooms[roomCode];
        g.turnIndex = (g.turnIndex + 1) % g.playerOrder.length;
        g.turn = g.playerOrder[g.turnIndex];
        g.roundState = 'DISCARD';
        g.lastDiscardCount = 0;
        sendState(roomCode);
    }

    socket.on("call", () => {
        const g = rooms[socket.roomCode];
        if (!g || socket.id !== g.turn || g.roundState !== 'DISCARD') return;
        if (calcHand(g.players[socket.id].hand) > 5) return socket.emit('actionError', 'JE HEBT MEER DAN 5 PUNTEN!');
        resolveRound(socket.roomCode, socket.id);
    });

    function resolveRound(roomCode, callerId) {
        const g = rooms[roomCode];
        const scores = {};
        g.playerOrder.forEach(id => { scores[id] = calcHand(g.players[id].hand); });
        
        const callerScore = scores[callerId];
        const kamoFail = g.playerOrder.some(id => id !== callerId && scores[id] <= callerScore);
        const results = {};
        g.pendingLosers = [];

        g.playerOrder.forEach(id => {
            let ptsThisRound = scores[id];
            let badge = '';
            if (kamoFail && id === callerId) { ptsThisRound += 20; badge = 'KAMO'; g.extraCards[id] = 1; }
            else if (!kamoFail && id === callerId) { ptsThisRound = 0; badge = 'WIN'; }
            else if (kamoFail && id !== callerId && scores[id] === Math.min(...g.playerOrder.map(x => scores[x]))) { ptsThisRound = 0; badge = 'WIN'; }
            
            g.totals[id] = (g.totals[id] || 0) + ptsThisRound;
            if (g.totals[id] >= g.rules.limit) g.pendingLosers.push(id);
            results[id] = { score: scores[id], ptsThisRound, total: g.totals[id], badge, hand: g.players[id].hand.filter(x => x) };
        });

        g.revealData = { caller: callerId, results, kamoFail };
        g.status = g.pendingLosers.length > 0 ? 'GAMEOVER' : 'REVEAL';
        sendState(roomCode);
    }

    socket.on("nextRound", () => {
        const g = rooms[socket.roomCode];
        if (g && socket.id === g.hostId && g.status === 'REVEAL') resetRound(socket.roomCode);
    });

    socket.on("newGame", () => {
        const g = rooms[socket.roomCode];
        if (g && socket.id === g.hostId) {
            g.playerOrder.forEach(id => { g.totals[id] = 0; g.extraCards[id] = 0; });
            g.status = 'LOBBY';
            sendState(socket.roomCode);
        }
    });

    socket.on("disconnect", () => {
        const code = socket.roomCode;
        const g = rooms[code];
        if (g) {
            g.playerOrder = g.playerOrder.filter(id => id !== socket.id);
            delete g.players[socket.id];
            if (g.playerOrder.length === 0) delete rooms[code];
            else {
                if (g.hostId === socket.id) g.hostId = g.playerOrder[0];
                sendState(code);
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Server online op poort ${PORT}`));
