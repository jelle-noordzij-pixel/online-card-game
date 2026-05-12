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

function sendStateToAll() {
    gameState.playerOrder.forEach((socketId) => {
        let privateState = JSON.parse(JSON.stringify(gameState));
        Object.keys(privateState.players).forEach(id => {
            if (id !== socketId) {
                // Kaarten van anderen zijn geheim
                privateState.players[id].hand = new Array(privateState.players[id].hand.length).fill({v: '?', s: ''});
            }
        });
        io.to(socketId).emit("updateState", privateState);
    });
}

io.on("connection", (socket) => {
    console.log("Nieuwe speler verbonden:", socket.id);

    socket.on("joinGame", (name) => {
        if (gameState.status !== 'LOBBY') return;
        
        gameState.players[socket.id] = {
            id: socket.id,
            name: name || "Speler " + (gameState.playerOrder.length + 1),
            hand: [],
            score: 0
        };
        
        // Alleen toevoegen als de speler nog niet in de lijst staat
        if (!gameState.playerOrder.includes(socket.id)) {
            gameState.playerOrder.push(socket.id);
        }
        
        console.log(`${name} is gejoind.`);
        sendStateToAll();
    });

    socket.on("startGame", () => {
        console.log("Startknop ingedrukt door:", socket.id);
        
        // Reset alles voor een schone start
        gameState.status = 'PLAYING';
        gameState.deck = buildDeck();
        gameState.tableStack = [gameState.deck.pop()];
        
        gameState.playerOrder.forEach(id => {
            if (gameState.players[id]) {
                gameState.players[id].hand = gameState.deck.splice(0, 5);
            }
        });
        
        gameState.turnIndex = 0;
        
        // Belangrijk: Eerst de status naar iedereen sturen
        io.emit("gameStarted"); // Extra signaal voor de zekerheid
        sendStateToAll();
    });

    socket.on("disconnect", () => {
        console.log("Speler weg:", socket.id);
        gameState.playerOrder = gameState.playerOrder.filter(id => id !== socket.id);
        delete gameState.players[socket.id];
        sendStateToAll();
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server draait op poort ${PORT}`));
