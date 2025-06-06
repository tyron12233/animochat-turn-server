import type { Server } from 'ws';
import WS from 'jest-websocket-mock';
import MockRedis from 'ioredis-mock';
import type Redis from 'ioredis';


// --- Mocked Dependencies ---
// This map simulates the server's local connections.
const localPeerConnections = new Map<string, WebSocket>();

// The channel our server listens to.
const REDIS_MATCH_CHANNEL = 'match_notifications';


// --- The message handler function we are testing ---
function setupSubscriber(subscriber: any) {
    subscriber.on('message', (channel: string, message: string) => {
        if (channel === REDIS_MATCH_CHANNEL) {
            console.log(`Received match notification: ${message}`);
            const payload = JSON.parse(message);

            if (localPeerConnections.has(payload.peer1Id)) {
                const ws = localPeerConnections.get(payload.peer1Id)!;
                const serverMessage = { type: 'MATCH_FOUND', partnerId: payload.peer2Id };
                ws.send(JSON.stringify(serverMessage));
                localPeerConnections.delete(payload.peer1Id);
            }

            if (localPeerConnections.has(payload.peer2Id)) {
                const ws = localPeerConnections.get(payload.peer2Id)!;
                const serverMessage = { type: 'MATCH_FOUND', partnerId: payload.peer1Id };
                ws.send(JSON.stringify(serverMessage));
                localPeerConnections.delete(payload.peer2Id);
            }
        }
    });
}


// --- Test Suite ---
describe('Redis Match Notification Subscriber', () => {
    let wsServer: WS;
    let subscriber: any;

    // Before each test, set up a clean environment
    beforeEach(() => {
        // Create a mock WebSocket server
        wsServer = new WS('ws://localhost:9000');
        // Create a new mock Redis subscriber for each test
        subscriber = new MockRedis();
        subscriber.subscribe(REDIS_MATCH_CHANNEL);
        // Set up our message handler logic
        setupSubscriber(subscriber);
        // Clear any old connections
        localPeerConnections.clear();
    });

    // After each test, clean up
    afterEach(() => {
        WS.clean();
    });

    // Test Case 1: Both matched peers are connected to this server instance
    test('should notify both peers when both are local', async () => {
        // Arrange: Connect two clients to our mock WebSocket server
        const client1 = new WebSocket('ws://localhost:9000');
        await wsServer.connected; // Wait for connection
        const client2 = new WebSocket('ws://localhost:9000');
        await wsServer.connected; // Wait for second connection

        const peer1Id = 'peer-1';
        const peer2Id = 'peer-2';

        // Add their WebSocket instances to our local map
        localPeerConnections.set(peer1Id, client1 as unknown as WebSocket);
        localPeerConnections.set(peer2Id, client2 as unknown as WebSocket);

        const matchPayload = { peer1Id, peer2Id };

        // Act: Simulate a message from Redis Pub/Sub
        subscriber.publish(REDIS_MATCH_CHANNEL, JSON.stringify(matchPayload));

        // Assert: Check that both clients received the correct message
        await expect(wsServer).toReceiveMessage(JSON.stringify({ type: 'MATCH_FOUND', partnerId: peer2Id }));
        await expect(wsServer).toReceiveMessage(JSON.stringify({ type: 'MATCH_FOUND', partnerId: peer1Id }));

        // Assert: Check that both were removed from the waiting connections map
        expect(localPeerConnections.has(peer1Id)).toBe(false);
        expect(localPeerConnections.has(peer2Id)).toBe(false);
    });

    // Test Case 2: Only one of the matched peers (peer1) is local
    test('should notify only the local peer (peer1)', async () => {
        // Arrange
        const client1 = new WebSocket('ws://localhost:9000');
        await wsServer.connected;

        const peer1Id = 'local-peer-1';
        const peer2Id = 'remote-peer-2'; // This peer is on another server instance

        localPeerConnections.set(peer1Id, client1 as unknown as WebSocket);

        const matchPayload = { peer1Id, peer2Id };

        // Act
        subscriber.publish(REDIS_MATCH_CHANNEL, JSON.stringify(matchPayload));

        // Assert
        await expect(wsServer).toReceiveMessage(JSON.stringify({ type: 'MATCH_FOUND', partnerId: peer2Id }));
        expect(localPeerConnections.has(peer1Id)).toBe(false);
        expect(localPeerConnections.size).toBe(0);

        // Ensure no other messages were sent
        expect(wsServer.messages).toHaveLength(1);
    });

    // Test Case 3: Only the other matched peer (peer2) is local
    test('should notify only the local peer (peer2)', async () => {
        // Arrange
        const client2 = new WebSocket('ws://localhost:9000');
        await wsServer.connected;

        const peer1Id = 'remote-peer-1';
        const peer2Id = 'local-peer-2';

        localPeerConnections.set(peer2Id, client2 as unknown as WebSocket);

        const matchPayload = { peer1Id, peer2Id };

        // Act
        subscriber.publish(REDIS_MATCH_CHANNEL, JSON.stringify(matchPayload));

        // Assert
        await expect(wsServer).toReceiveMessage(JSON.stringify({ type: 'MATCH_FOUND', partnerId: peer1Id }));
        expect(localPeerConnections.has(peer2Id)).toBe(false);
        expect(localPeerConnections.size).toBe(0);
        expect(wsServer.messages).toHaveLength(1);
    });

    // Test Case 4: Neither matched peer is on this server instance
    test('should do nothing if neither peer is local', () => {
        // Arrange
        const peer1Id = 'remote-peer-1';
        const peer2Id = 'remote-peer-2';

        // Add a random local connection to ensure it is not affected
        localPeerConnections.set('unrelated-peer', new WebSocket('ws://localhost:9000') as unknown as WebSocket);

        const matchPayload = { peer1Id, peer2Id };

        // Act
        subscriber.publish(REDIS_MATCH_CHANNEL, JSON.stringify(matchPayload));

        // Assert
        // No messages should be sent, and the unrelated peer should still be in the map
        expect(wsServer.messages).toHaveLength(0);
        expect(localPeerConnections.has('unrelated-peer')).toBe(true);
        expect(localPeerConnections.size).toBe(1);
    });

    // Test Case 5: Message is published on an irrelevant channel
    test('should ignore messages on other channels', () => {
        // Arrange
        const peer1Id = 'peer-1';
        const peer2Id = 'peer-2';

        localPeerConnections.set(peer1Id, new WebSocket('ws://localhost:9000') as unknown as WebSocket);
        const matchPayload = { peer1Id, peer2Id };

        // Act: Publish to a different channel
        subscriber.publish('some-other-channel', JSON.stringify(matchPayload));

        // Assert: Nothing should happen
        expect(wsServer.messages).toHaveLength(0);
        expect(localPeerConnections.has(peer1Id)).toBe(true);
    });
});
