const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.use(express.static(path.join(__dirname, 'public')));

let rooms = {};

// ─── HELPERS ────────────────────────────────────────────────────────────────

function createDeck() {
    const suits = ['♥', '♦', '♣', '♠'];
    const values = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
    let deck = [];
    for (let s of suits) {
        for (let v of values) {
            let score;
            if (v === 'A') score = 1;
            else if (v === 'J') score = -1;
            else if (v === 'Q' || v === 'K') score = 10;
            else score = parseInt(v);
            deck.push({ v, s, score });
        }
    }
    // Voeg 2 jokers toe
    deck.push({ v: '🃏', s: '', score: 0, isJoker: true });
    deck.push({ v: '🃏', s: '', score: 0, isJoker: true });
    return deck.sort(() => Math.random() - 0.5);
}

function handScore(hand) {
    return hand.reduce((sum, c) => sum + c.score, 0);
}

function generateCode() {
    return Math.floor(1000 + Math.random() * 9000).toString();
}

// Stuur gepersonaliseerde state naar elke speler in de room
function sendUpdate(code) {
    const room = rooms[code];
    if (!room) return;

    room.playerOrder.forEach(socketId => {
        const socket = io.sockets.sockets.get(socketId);
        if (!socket) return;

        // Bouw een veilige state: andere spelers krijgen geen handkaarten te zien
        const safePlayers = {};
        room.playerOrder.forEach(id => {
            const p = room.players[id];
            safePlayers[id] = {
                id: p.id,
                name: p.name,
                score: p.score,
                cardCount: p.hand.length,
                // Eigen hand wel meesturen, andere spelers niet
                hand: id === socketId ? p.hand : undefined
            };
        });

        socket.emit('updateState', {
            status: room.status,
            hostId: room.hostId,
            playerOrder: room.playerOrder,
            players: safePlayers,
            openCard: room.openCard,
            deckCount: room.deck.length,
            turn: room.turn,
            roundState: room.roundState,
            myRoomCode: code,
            phase: room.phase,       // 'DISCARD' of 'DRAW'
            message: room.message || ''
        });
    });
}

// ─── SOCKET EVENTS ───────────────────────────────────────────────────────────

io.on('connection', (socket) => {
    console.log('Verbonden:', socket.id);

    // NIEUW SPEL AANMAKEN
    socket.on('createRoom', ({ userName }) => {
        const code = generateCode();
        rooms[code] = {
            status: 'LOBBY',
            hostId: socket.id,
            players: {
                [socket.id]: {
                    id: socket.id,
                    name: userName || 'Speler 1',
                    hand: [],
                    score: 0,
                    extraCards: 0
                }
            },
            playerOrder: [socket.id],
            deck: [],
            discardPile: [],
            openCard: null,
            turn: null,
            phase: 'DISCARD',
            message: ''
        };
        socket.join(code);
        socket.roomCode = code;
        sendUpdate(code);
    });

    // BESTAAND SPEL JOINEN
    socket.on('joinRoom', ({ code, userName }) => {
        const room = rooms[code];
        if (!room) {
            socket.emit('error', 'Kamer niet gevonden.');
            return;
        }
        if (room.status !== 'LOBBY') {
            socket.emit('error', 'Spel is al bezig.');
            return;
        }
        socket.join(code);
        socket.roomCode = code;
        room.players[socket.id] = {
            id: socket.id,
            name: userName || ('Speler ' + (room.playerOrder.length + 1)),
            hand: [],
            score: 0,
            extraCards: 0
        };
        room.playerOrder.push(socket.id);
        sendUpdate(code);
    });

    // NAAM INSTELLEN
    socket.on('setName', ({ name }) => {
        const room = rooms[socket.roomCode];
        if (room && room.players[socket.id]) {
            room.players[socket.id].name = name;
            sendUpdate(socket.roomCode);
        }
    });

    // SPEL STARTEN
    socket.on('startGame', () => {
        const room = rooms[socket.roomCode];
        if (!room || socket.id !== room.hostId) return;
        startRound(socket.roomCode);
    });

    // KAART PAKKEN VAN DICHTE STAPEL
    socket.on('drawFromDeck', () => {
        const room = rooms[socket.roomCode];
        if (!room || room.turn !== socket.id || room.phase !== 'DRAW') return;

        if (room.deck.length === 0) reshuffleDeck(socket.roomCode);
        const card = room.deck.pop();
        room.players[socket.id].hand.push(card);
        room.phase = 'DISCARD';
        room.message = '';
        sendUpdate(socket.roomCode);
    });

    // KAART PAKKEN VAN OPEN STAPEL
    socket.on('drawFromOpen', () => {
        const room = rooms[socket.roomCode];
        if (!room || room.turn !== socket.id || room.phase !== 'DRAW') return;
        if (!room.openCard) return;

        room.players[socket.id].hand.push(room.openCard);
        // Pak de kaart onder de openCard (= vorige discard)
        room.openCard = room.discardPile.length > 0 ? room.discardPile.pop() : null;
        room.phase = 'DISCARD';
        room.message = '';
        sendUpdate(socket.roomCode);
    });

    // KAARTEN WEGGOOIEN
    socket.on('discard', ({ indices }) => {
        const room = rooms[socket.roomCode];
        if (!room || room.turn !== socket.id || room.phase !== 'DISCARD') return;

        const hand = room.players[socket.id].hand;

        // Validatie: indices moeten geldig zijn
        if (!indices || indices.length === 0) return;
        if (indices.some(i => i < 0 || i >= hand.length)) return;

        // Meerdere kaarten? Dan moeten ze dezelfde waarde hebben
        if (indices.length > 1) {
            const vals = indices.map(i => hand[i].v);
            if (new Set(vals).size > 1) {
                socket.emit('invalidAction', 'Meerdere kaarten moeten dezelfde waarde hebben!');
                return;
            }
        }

        // Gooi kaarten weg (van hoog naar laag, zodat indices kloppen)
        const sorted = [...indices].sort((a, b) => b - a);
        let lastDiscarded;
        sorted.forEach(i => {
            lastDiscarded = hand.splice(i, 1)[0];
        });

        // Leg op discard pile, openCard = bovenste
        if (room.openCard) room.discardPile.push(room.openCard);
        room.openCard = lastDiscarded;

        // Volgende speler
        nextTurn(socket.roomCode);
        sendUpdate(socket.roomCode);
    });

    // KAMO CALLEN
    socket.on('callKamo', () => {
        const room = rooms[socket.roomCode];
        if (!room || room.turn !== socket.id || room.phase !== 'DISCARD') return;

        const callerScore = handScore(room.players[socket.id].hand);
        if (callerScore > 5) {
            socket.emit('invalidAction', 'Je hebt meer dan 5 punten, je kunt niet callen!');
            return;
        }

        endRound(socket.roomCode, socket.id);
    });

    // DISCONNECT
    socket.on('disconnect', () => {
        console.log('Weg:', socket.id);
        const code = socket.roomCode;
        if (!code || !rooms[code]) return;

        const room = rooms[code];
        delete room.players[socket.id];
        room.playerOrder = room.playerOrder.filter(id => id !== socket.id);

        if (room.playerOrder.length === 0) {
            delete rooms[code];
            return;
        }

        // Als host weg is, nieuwe host
        if (room.hostId === socket.id) {
            room.hostId = room.playerOrder[0];
        }

        // Als het zijn beurt was
        if (room.turn === socket.id && room.status === 'PLAYING') {
            nextTurn(code);
        }

        sendUpdate(code);
    });
});

// ─── GAME FLOW ────────────────────────────────────────────────────────────────

function startRound(code) {
    const room = rooms[code];
    room.status = 'PLAYING';
    room.deck = createDeck();
    room.discardPile = [];

    room.playerOrder.forEach(id => {
        const p = room.players[id];
        const startCards = 5 + (p.extraCards || 0);
        p.hand = [];
        for (let i = 0; i < startCards; i++) {
            p.hand.push(room.deck.pop());
        }
    });

    room.openCard = room.deck.pop();
    room.turn = room.playerOrder[0];
    room.phase = 'DISCARD';
    room.message = 'Ronde begonnen!';
    sendUpdate(code);
}

function nextTurn(code) {
    const room = rooms[code];
    const idx = room.playerOrder.indexOf(room.turn);
    room.turn = room.playerOrder[(idx + 1) % room.playerOrder.length];
    room.phase = 'DISCARD';
}

function reshuffleDeck(code) {
    const room = rooms[code];
    room.deck = room.discardPile.sort(() => Math.random() - 0.5);
    room.discardPile = [];
}

function endRound(code, callerId) {
    const room = rooms[code];
    const callerScore = handScore(room.players[callerId].hand);

    // Bereken scores van alle spelers
    const scores = {};
    room.playerOrder.forEach(id => {
        scores[id] = handScore(room.players[id].hand);
    });

    // Check of iemand anders ≤ callerScore heeft
    let kamoFail = false;
    let blocker = null;
    room.playerOrder.forEach(id => {
        if (id !== callerId && scores[id] <= callerScore) {
            kamoFail = true;
            if (!blocker || scores[id] < scores[blocker]) blocker = id;
        }
    });

    const roundResult = {};
    if (kamoFail) {
        // Caller wordt gestraft
        room.playerOrder.forEach(id => {
            if (id === callerId) {
                roundResult[id] = { points: callerScore + 20, penalty: true, extraCard: true };
                room.players[id].score += callerScore + 20;
                room.players[id].extraCards = (room.players[id].extraCards || 0) + 1;
            } else if (id === blocker) {
                roundResult[id] = { points: 0, blocker: true };
            } else {
                roundResult[id] = { points: scores[id] };
                room.players[id].score += scores[id];
            }
        });
    } else {
        // Succesvolle call
        room.playerOrder.forEach(id => {
            if (id === callerId) {
                roundResult[id] = { points: 0, winner: true };
            } else {
                roundResult[id] = { points: scores[id] };
                room.players[id].score += scores[id];
            }
        });
    }

    // Stuur round reveal naar iedereen
    const revealData = {
        callerId,
        kamoFail,
        blocker,
        roundResult,
        hands: {}
    };
    room.playerOrder.forEach(id => {
        revealData.hands[id] = {
            name: room.players[id].name,
            hand: room.players[id].hand,
            score: room.players[id].score,
            roundPoints: roundResult[id]
        };
    });

    io.to(code).emit('roundEnd', revealData);

    // Check game over (bijv. bij 100 punten)
    const LIMIT = 100;
    const loser = room.playerOrder.find(id => room.players[id].score >= LIMIT);
    if (loser) {
        io.to(code).emit('gameOver', {
            loserId: loser,
            loserName: room.players[loser].name,
            loserScore: room.players[loser].score,
            players: room.playerOrder.map(id => ({
                name: room.players[id].name,
                score: room.players[id].score
            }))
        });
        delete rooms[code];
    }
    // Anders: na 5 seconden nieuwe ronde
    else {
        setTimeout(() => {
            if (rooms[code]) startRound(code);
        }, 6000);
    }
}

// ─── START ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`✅ Server draait op http://localhost:${PORT}`));
