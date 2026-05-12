const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

let gameState = {
    players: {}, 
    playerOrder: [],
    deck: [],
    tableStack: [],
    turnIndex: 0,
    status: 'LOBBY' 
};

function buildDeck() {
    const suits = ['♥','♦','♣','♠'];
    let d = [];
    for (let v = 1; v <= 13; v++) for (let s of suits) d.push({ v, s });
    for (let i = 0; i < 3; i++) d.push({ v: 0, s: null });
    return d.sort(() => Math.random() - 0.5);
}

// Functie om de state veilig te versturen (verbergt kaarten van anderen)
function sendStateToAll() {
    gameState.playerOrder.forEach((socketId) => {
        let privateState = JSON.parse(JSON.stringify(gameState));
        
        // Verberg handen van anderen
        Object.keys(privateState.players).forEach(id => {
            if (id !== socketId) {
                privateState.players[id].hand = new Array(privateState.players[id].hand.length).fill({v: '?', s: ''});
            }
        });
        
        io.to(socketId).emit("updateState", privateState);
    });
}

io.on("connection", (socket) => {
    socket.on("joinGame", (name) => {
        if (gameState.status !== 'LOBBY') return;
        
        gameState.players[socket.id] = {
            id: socket.id,
            name: name || "Speler " + (gameState.playerOrder.length + 1),
            hand: [],
            score: 0
        };
        gameState.playerOrder.push(socket.id);
        sendStateToAll();
    });

    socket.on("startGame", () => {
        if (gameState.playerOrder.length < 1) return; // Voor testen op 1 gezet, zet op 2 voor echt spel
        
        gameState.status = 'PLAYING';
        gameState.deck = buildDeck();
        gameState.tableStack = [gameState.deck.pop()];
        
        gameState.playerOrder.forEach(id => {
            gameState.players[id].hand = gameState.deck.splice(0, 5);
        });
        
        gameState.turnIndex = 0;
        sendStateToAll();
    });

    socket.on("disconnect", () => {
        gameState.playerOrder = gameState.playerOrder.filter(id => id !== socket.id);
        delete gameState.players[socket.id];
        sendStateToAll();
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server live op ${PORT}`));
