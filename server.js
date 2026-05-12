socket.on("discard", ({ indices }) => {
        const g = gameState;
        if (g.status !== 'PLAYING' || socket.id !== g.turn || g.roundState !== 'DISCARD') return;

        const hand = g.players[socket.id].hand;
        if (!indices || !indices.length) return;

        const cards = indices.map(i => hand[i]).filter(c => c !== null);
        
        // Check of alle geselecteerde kaarten dezelfde waarde hebben
        const firstVal = cards[0].v;
        if (!cards.every(c => c.v === firstVal)) {
            socket.emit('actionError', 'JE MAG ALLEEN DEZELFDE KAARTEN GOOIEN!');
            return;
        }

        // Voeg toe aan aflegstapel
        g.tableStack.push(...cards);
        g.lastDiscardCount = cards.length;

        // Verwijder uit hand
        indices.sort((a, b) => b - a).forEach(i => {
            if (i === Math.min(...indices)) {
                hand[i] = null; // Laat één gat over voor de 'pak' actie
            } else {
                hand.splice(i, 1);
            }
        });

        g.roundState = 'DRAW'; // Nu moet de speler een kaart pakken
        sendState();
    });
