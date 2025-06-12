import MatchmakingClient from '../client-sample/matchmaking-client.js';
import { EventSource } from 'eventsource';

const CLIENT_COUNT = 2;

describe('MatchmakingClient', () => {
    // create array of 1-10 then map it to an array of client objects
    let clients = Array.from({ length: CLIENT_COUNT }, (_, i) => new MatchmakingClient({
        userId: `test-user-${i + 1}`,
        baseUrl: 'http://localhost:3000/matchmaking',
        EventSourceClass: EventSource,
    }));

    test("all clients should be matched", () => {
        return Promise.all(clients.map(client => {
            return new Promise((resolve, reject) => {
                client.onMatched = (data) => {
                    expect(data).toHaveProperty('state', 'MATCHED');
                    expect(data).toHaveProperty('matchedUserId');
                    resolve();
                };
                client.onError = (error) => {
                    reject(new Error(`Client ${client.userId} encountered an error: ${error}`));
                };
                client.connect();
            });
        }));
    })
});
