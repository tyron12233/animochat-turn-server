
class MatchmakingClient {

    /**
 * @param {object} options - Configuration for the client.
 * @param {string} options.userId - The ID of the user to start matchmaking for.
 * @param {string} options.baseUrl - The base URL for the matchmaking endpoint (e.g., 'http://localhost:3000/matchmaking').
 * @param {function} [options.onOpen] - Callback for when the connection opens.
 * @param {function} [options.onMessage] - Callback for a generic message. Receives the full data object.
 * @param {function} [options.onMatched] - Callback for when a match is found. Receives the match data.
 * @param {function} [options.onError] - Callback for when a connection error occurs. Receives the event object.
 * @param {object} [options.EventSourceClass=EventSource] - (For testing) The EventSource class to use.
 */
    constructor(options) {
        this.userId = options.userId;
        this.baseUrl = options.baseUrl;

        // Callbacks
        this.onOpen = options.onOpen || (() => { });
        this.onMessage = options.onMessage || (() => { });
        this.onMatched = options.onMatched || (() => { });
        this.onError = options.onError || (() => { });

        // Dependency Injection for testing
        this.EventSourceClass = options.EventSourceClass || window.EventSource;

        this.eventSource = null;
    }


    /**
 * Starts listening for messages from the server.
 */
    connect() {
        if (this.eventSource) {
            console.warn("Connection already established.");
            return;
        }

        const url = `${this.baseUrl}?userId=${this.userId}`;
        this.eventSource = new this.EventSourceClass(url);

        this.eventSource.onopen = (event) => {
            this.onOpen(event);
        };

        this.eventSource.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);

                this.onMessage(data);

                if (data.state === 'MATCHED') {
                    this.onMatched(data);
                    this.close();
                }
            } catch (e) {
                console.error("Failed to parse message data:", event.data, e);
            }
        };

        this.eventSource.onerror = (event) => {
            console.error("Error occurred:", event);
            this.onError(event);
            this.close();
        };
    }

    /**
     * Closes the connection to the server.
     */
    close() {
        if (this.eventSource) {
            this.eventSource.close();
            this.eventSource = null;
        }
    }
}

export default MatchmakingClient;