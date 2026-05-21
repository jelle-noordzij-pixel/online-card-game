const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.use(express.static(path.join(__dirname, 'public')));

let rooms = {};

// ─── DECK ─────────────────────────────────────────────────────────────────────

function cardName(c) {
    if (!c) return '?';
    const v = c.v === 0 ? 'J' : c.v === 1 ? 'A' : c.v === 11 ? 'B' : c.v === 12 ? 'V' : c.v === 13 ? 'H' : c.v;
    return v + (c.s || '');
}

function buildDeck() {
    const suits = ['♥','♦','♣','♠'];
    let d = [];
    for (let v = 1; v <= 13; v++) for (let s of suits) d.push({ v, s });
    for (let i = 0; i < 3; i++) d.push({ v: 0, s: null }); // jokers
    return d.sort(() => Math.random() - 0.5);
}

function cardScore(c) {
    if (!c) return 0;
    if (c.v === 0)  return 0;   // Joker
    if (c.v === 1)  return 1;   // Aas
    if (c.v === 11) return -1;  // Boer
    if (c.v >= 12)  return 10;  // Vrouw / Heer
    return c.v;
}

function handScore(hand) {
    return hand.filter(x => x).reduce((a, c) => a + cardScore(c), 0);
}

function generateCode() {
    return Math.floor(1000 + Math.random() * 9000).toString();
}

// ─── SEND STATE ───────────────────────────────────────────────────────────────

function sendUpdate(code) {
    const room = rooms[code];
    if (!room) return;
    room.playerOrder.forEach(sid => {
        const sock = io.sockets.sockets.get(sid);
        if (!sock) return;
        const safePlayers = {};
        room.playerOrder.forEach(id => {
            const p = room.players[id];
            safePlayers[id] = {
                id: p.id,
                name: p.name,
                score: p.score,
                cardCount: p.hand.filter(x => x).length,
                hand: id === sid ? p.hand : undefined,
                handScore: id === sid ? handScore(p.hand) : undefined,
            };
        });
        sock.emit('updateState', {
            status: room.status,
            hostId: room.hostId,
            playerOrder: room.playerOrder,
            players: safePlayers,
            openStack: room.openStack,
            deckCount: room.deck.length,
            turn: room.turn,
            phase: room.phase,
            lastDiscardCount: room.lastDiscardCount,
            myRoomCode: code,
            rules: room.rules,
        });
    });
}

// ─── GAME FLOW ────────────────────────────────────────────────────────────────

function startRound(code) {
    const room = rooms[code];
    room.status = 'PLAYING';
    room.deck = buildDeck();
    room.openStack = [];
    room.lastDiscardCount = 0;

    room.playerOrder.forEach(id => {
        const p = room.players[id];
        const count = 5 + (p.extraCards || 0);
        p.hand = room.deck.splice(0, count);
        p.extraCards = 0;
    });

    room.openStack.push(room.deck.pop());
    room.turn = room.playerOrder[0];
    room.phase = 'DISCARD';
    sendUpdate(code);
}

function nextTurn(code) {
    const room = rooms[code];
    const idx = room.playerOrder.indexOf(room.turn);
    room.turn = room.playerOrder[(idx + 1) % room.playerOrder.length];
    room.phase = 'DISCARD';
    room.lastDiscardCount = 0;
}

function endRound(code, callerId) {
    const room = rooms[code];
    const callerScore = handScore(room.players[callerId].hand);
    const scores = {};
    room.playerOrder.forEach(id => { scores[id] = handScore(room.players[id].hand); });

    let kamoFail = false;
    let blockerId = null;
    room.playerOrder.forEach(id => {
        if (id !== callerId && scores[id] <= callerScore) {
            if (!blockerId || scores[id] < scores[blockerId]) {
                kamoFail = true;
                blockerId = id;
            }
        }
    });

    const results = {};
    room.playerOrder.forEach(id => {
        let pts = scores[id];
        let badge = null;
        if (kamoFail && id === callerId) {
            pts = scores[id] + 20;
            badge = 'KAMO_FAIL';
            room.players[id].extraCards = 1;
        } else if (!kamoFail && id === callerId) {
            pts = 0;
            badge = 'WINNER';
        } else if (kamoFail && id === blockerId) {
            pts = 0;
            badge = 'WINNER';
        }
        room.players[id].score += pts;
        results[id] = { pts, badge, handScore: scores[id], hand: room.players[id].hand };
    });

    // Check mijlpalen en game over
    const LIMIT = room.rules?.limit || 100;
    const milestones = room.rules?.milestones || [];

    // Bepaal welke spelers een mijlpaal bereikten deze ronde
    const milestoneHits = [];
    room.playerOrder.forEach(id => {
        const p = room.players[id];
        milestones.forEach(m => {
            if (m.pts === 'go') return; // game over apart afgehandeld
            const scoreBefore = p.score - results[id].pts;
            if (scoreBefore < m.pts && p.score >= m.pts) {
                milestoneHits.push({ name: p.name, pts: m.pts, n: m.n, t: m.t });
            }
        });
    });

    const losers = room.playerOrder.filter(id => room.players[id].score >= LIMIT);
    const goMilestone = milestones.find(m => m.pts === 'go');

    // Speler met meeste handpunten deze ronde (de caller met 0 telt niet mee als winner)
    let highStrafHit = null;
    const highStraf = room.rules?.highStraf;
    if (highStraf && highStraf.n > 0) {
        let highScore = -1, highId = null;
        room.playerOrder.forEach(id => {
            const sc = scores[id];
            if (sc > highScore) { highScore = sc; highId = id; }
        });
        if (highId) {
            highStrafHit = {
                id: highId,
                name: room.players[highId].name,
                score: highScore,
                n: highStraf.n,
                t: highStraf.t
            };
        }
    }

    const revealPayload = {
        callerId,
        callerName: room.players[callerId].name,
        kamoFail,
        results,
        players: room.playerOrder.map(id => ({
            id,
            name: room.players[id].name,
            score: room.players[id].score,
            hand: room.players[id].hand,
            result: results[id],
        })),
        losers: losers.map(id => ({ id, name: room.players[id].name, score: room.players[id].score })),
        milestoneHits,
        goMilestone,
        highStrafHit,
        rules: room.rules,
    };

    io.to(code).emit('roundEnd', revealPayload);

    if (losers.length > 0) {
        // Game over na 1s
        setTimeout(() => io.to(code).emit('gameOver', revealPayload), 1000);
        delete rooms[code];
    }
    // anders: volgende ronde na knop (client stuurt 'nextRound')
}

// ─── SOCKET ───────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
    console.log('+ verbonden:', socket.id);

    socket.on('createRoom', ({ userName, rules }) => {
        const code = generateCode();
        rooms[code] = {
            status: 'LOBBY',
            hostId: socket.id,
            players: {
                [socket.id]: { id: socket.id, name: userName || 'Speler 1', hand: [], score: 0, extraCards: 0 }
            },
            playerOrder: [socket.id],
            deck: [], openStack: [],
            turn: null, phase: 'DISCARD',
            lastDiscardCount: 0,
            rules: rules || { limit: 100, straf: { n: 5, t: 'slokken' } },
        };
        socket.join(code);
        socket.roomCode = code;
        sendUpdate(code);
    });

    socket.on('joinRoom', ({ code, userName }) => {
        const room = rooms[code];
        if (!room) { socket.emit('error', 'Kamer niet gevonden.'); return; }
        if (room.status !== 'LOBBY') { socket.emit('error', 'Spel is al bezig.'); return; }
        if (room.playerOrder.length >= 6) { socket.emit('error', 'Kamer is vol (max 6 spelers).'); return; }
        socket.join(code);
        socket.roomCode = code;
        room.players[socket.id] = { id: socket.id, name: userName || ('Speler ' + (room.playerOrder.length + 1)), hand: [], score: 0, extraCards: 0 };
        room.playerOrder.push(socket.id);
        sendUpdate(code);
    });

    socket.on('updateRules', ({ rules }) => {
        const room = rooms[socket.roomCode];
        if (!room || socket.id !== room.hostId) return;
        room.rules = rules;
        sendUpdate(socket.roomCode);
    });

    socket.on('startGame', () => {
        const room = rooms[socket.roomCode];
        if (!room || socket.id !== room.hostId) return;
        if (room.playerOrder.length < 2) { socket.emit('error', 'Minimaal 2 spelers nodig.'); return; }
        startRound(socket.roomCode);
    });

    socket.on('discard', ({ indices }) => {
        const room = rooms[socket.roomCode];
        if (!room || room.turn !== socket.id || room.phase !== 'DISCARD') return;
        const hand = room.players[socket.id].hand;
        if (!indices?.length) return;
        if (indices.some(i => i < 0 || i >= hand.length || !hand[i])) return;

        // Valideer: zelfde waarde
        const vals = indices.map(i => hand[i].v);
        if (new Set(vals).size > 1) { socket.emit('invalidAction', 'Alleen kaarten met dezelfde waarde!'); return; }

        const cards = indices.map(i => hand[i]);
        room.openStack.push(...cards);
        room.lastDiscardCount = cards.length;

        // Verwijder uit hand (null voor eerste slot, splice voor rest)
        indices.sort((a,b) => b - a);
        const firstIdx = Math.min(...indices);
        indices.forEach(i => {
            if (i === firstIdx) hand[i] = null;
            else hand.splice(i, 1);
        });

        room.phase = 'DRAW';

        // Logboek: stuur naar alle spelers wat er weggegooid is
        const playerName = room.players[socket.id].name;
        const cardNames  = cards.map(c => cardName(c)).join(', ');
        const logText    = cards.length > 1
            ? '<span class="log-name">' + playerName + '</span> gooit ' + cards.length + 'x ' + cardNames + ' weg'
            : '<span class="log-name">' + playerName + '</span> gooit ' + cardNames + ' weg';
        io.to(socket.roomCode).emit('logEvent', { text: logText });

        sendUpdate(socket.roomCode);
    });

    socket.on('drawDeck', () => {
        const room = rooms[socket.roomCode];
        if (!room || room.turn !== socket.id || room.phase !== 'DRAW') return;
        if (room.deck.length === 0) room.deck = buildDeck();
        const card = room.deck.pop();
        const hand = room.players[socket.id].hand;
        const slot = hand.indexOf(null);
        if (slot !== -1) hand[slot] = card; else hand.push(card);
        nextTurn(socket.roomCode);
        sendUpdate(socket.roomCode);
    });

    socket.on('drawOpen', () => {
        const room = rooms[socket.roomCode];
        if (!room || room.turn !== socket.id || room.phase !== 'DRAW') return;
        const available = room.openStack.length - room.lastDiscardCount;
        if (available <= 0) { socket.emit('invalidAction', 'Geen kaart beschikbaar!'); return; }
        const card = room.openStack.splice(available - 1, 1)[0];
        const hand = room.players[socket.id].hand;
        const slot = hand.indexOf(null);
        if (slot !== -1) hand[slot] = card; else hand.push(card);
        room.lastDiscardCount = 0;
        nextTurn(socket.roomCode);
        sendUpdate(socket.roomCode);
    });

    socket.on('callKamo', () => {
        const room = rooms[socket.roomCode];
        if (!room || room.turn !== socket.id || room.phase !== 'DISCARD') return;
        const score = handScore(room.players[socket.id].hand);
        if (score > 5) { socket.emit('invalidAction', 'Je hebt meer dan 5 punten!'); return; }
        const callerName = room.players[socket.id].name;
        io.to(socket.roomCode).emit('logEvent', { text: '<span class="log-name">' + callerName + '</span> roept CALL! (' + score + ' PT)' });
        endRound(socket.roomCode, socket.id);
    });

    socket.on('nextRound', () => {
        const room = rooms[socket.roomCode];
        if (!room || socket.id !== room.hostId) return;
        startRound(socket.roomCode);
    });

    socket.on('disconnect', () => {
        console.log('- weg:', socket.id);
        const code = socket.roomCode;
        if (!code || !rooms[code]) return;
        const room = rooms[code];
        delete room.players[socket.id];
        room.playerOrder = room.playerOrder.filter(id => id !== socket.id);
        if (room.playerOrder.length === 0) { delete rooms[code]; return; }
        if (room.hostId === socket.id) room.hostId = room.playerOrder[0];
        if (room.turn === socket.id && room.status === 'PLAYING') nextTurn(code);
        sendUpdate(code);
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`✅ http://localhost:${PORT}`));
