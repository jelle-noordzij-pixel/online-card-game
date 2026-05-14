const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const { createClient } = require('@supabase/supabase-js');

// --- CONFIGURATIE ---
const SB_URL = 'https://caossvejzjutuwqsjdxc.supabase.co'; 
// PLAK HIERONDER JE SERVICE_ROLE KEY (die begint met eyJ...)
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNhb3NzdmVqemp1dHV3cXNqZHhjIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3ODY3MzkyMSwiZXhwIjoyMDk0MjQ5OTIxfQ.gUBBx8MYlwTziO9IYaXxZ9OLBDdzWGG2Fcf_zR0-H6o'; 

const supabase = createClient(SB_URL, SB_KEY);

app.use(express.static('public'));

let rooms = {};

// --- GAME LOGICA HELPER ---
function createDeck() {
    const suits = ['♥', '♦', '♣', '♠'];
    const values = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
    let deck = [];
    for (let s of suits) {
        for (let v of values) {
            deck.push({ v, s, score: values.indexOf(v) + 2 });
        }
    }
    return deck.sort(() => Math.random() - 0.5);
}

// --- SOCKET VERBINDING ---
io.on('connection', (socket) => {
    console.log('Gebruiker verbonden:', socket.id);

    socket.on('createRoom', ({ userId }) => {
        const code = Math.floor(1000 + Math.random() * 9000).toString();
        rooms[code] = {
            status: 'LOBBY',
            hostId: socket.id,
            players: { [socket.id]: { id: socket.id, userId, name: 'Host', hand: [], score: 0 } },
            playerOrder: [socket.id],
            deck: [],
            openCard: null,
            turn: null,
            roundState: 'DRAW'
        };
        socket.join(code);
        socket.roomCode = code;
        sendUpdate(code);
    });

    socket.on('joinRoom', ({ code, userId }) => {
        if (rooms[code]) {
            socket.join(code);
            socket.roomCode = code;
            rooms[code].players[socket.id] = { id: socket.id, userId, name: 'Speler ' + (rooms[code].playerOrder.length + 1), hand: [], score: 0 };
            rooms[code].playerOrder.push(socket.id);
            sendUpdate(code);
        }
    });

    socket.on('startGame', () => {
        const room = rooms[socket.roomCode];
        if (!room || socket.id !== room.hostId) return;

        room.status = 'PLAYING';
        room.deck = createDeck();
        room.playerOrder.forEach(id => {
            room.players[id].hand = [room.deck.pop(), room.deck.pop(), room.deck.pop(), room.deck.pop()];
        });
        room.openCard = room.deck.pop();
        room.turn = room.playerOrder[0];
        room.roundState = 'DRAW';
        sendUpdate(socket.roomCode);
    });

    socket.on('drawFromDeck', () => {
        const room = rooms[socket.roomCode];
        if (room?.turn === socket.id && room.roundState === 'DRAW') {
            const card = room.deck.pop();
            room.players[socket.id].hand.push(card);
            room.roundState = 'DISCARD';
            sendUpdate(socket.roomCode);
        }
    });

    socket.on('discard', ({ indices }) => {
        const room = rooms[socket.roomCode];
        if (room?.turn === socket.id && room.roundState === 'DISCARD') {
            // Verwijder kaart uit hand en leg op de open stapel
            const discardedCard = room.players[socket.id].hand.splice(indices[0], 1)[0];
            room.openCard = discardedCard;
            
            // Volgende beurt
            const idx = room.playerOrder.indexOf(socket.id);
            room.turn = room.playerOrder[(idx + 1) % room.playerOrder.length];
            room.roundState = 'DRAW';
            sendUpdate(socket.roomCode);
        }
    });

    socket.on('disconnect', () => {
        console.log('Gebruiker weg:', socket.id);
    });
});

function sendUpdate(code) {
    const room = rooms[code];
    io.to(code).emit('updateState', { ...room, myRoomCode: code });
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server draait op poort ${PORT}`));
