# AnimoChat Matchmaking Service

## Overview

The AnimoChat Matchmaking Service is a core component of the AnimoChat ecosystem, responsible for connecting users with similar interests for one-on-one chat sessions. It leverages a powerful combination of Node.js, Express, and Redis to provide a scalable, real-time matching experience.

This service integrates seamlessly with the **AnimoChat Service Discovery** to dynamically locate and distribute users across available **Chat Services**. It uses Redis not only for queueing and session management but also for real-time notifications via Pub/Sub, ensuring that users are connected as soon as a suitable match is found.

### Core Responsibilities
-   **Interest-Based Matching:** Connects two users who share one or more common interests.
-   **Real-time Notifications:** Uses Server-Sent Events (SSE) and Redis Pub/Sub to instantly notify users when a match is made.
-   **Queue Management:** Manages queues of users waiting for matches across various interests.
-   **Persistent Session Handling:** Creates and manages chat sessions that can be re-joined, providing a seamless user experience.
-   **Dynamic Service Integration:** Registers itself with the service discovery and dynamically fetches the list of available chat servers.
-   **Analytics:** Tracks the popularity of interests to provide insights into user trends.

---

## Features

-   **Real-time Matching:** Long-lived SSE connections ensure users get matched without needing to poll the server.
-   **Multi-Interest Matching:** Users can specify multiple interests, and the service will find a match based on any common interest.
-   **Persistent Chat Sessions:** If a user disconnects, their session is preserved. They can check for and reconnect to an existing chat upon returning.
-   **Dynamic Chat Server Load Balancing:** Fetches a list of active chat servers from the service discovery and distributes matched pairs among them in a round-robin fashion.
-   **Popular Interests Endpoint:** Provides an API to retrieve a list of the most popular interests based on recent matchmaking activity.
-   **Full Service Lifecycle Management:** Automatically handles registration, heartbeats, and graceful unregistration with the service discovery.
-   **Comprehensive Health Check:** A `/status` endpoint provides detailed metrics on service health, Redis connectivity, memory usage, and queue statistics.
-   **Maintenance Mode:** Can be placed in a maintenance state to gracefully handle updates or downtime.

---

## How It Works

The matchmaking process is designed to be efficient and real-time.

1.  A user initiates a request to the `/matchmaking` endpoint with their `userId` and a list of `interests`.
2.  The server establishes a Server-Sent Events (SSE) connection to keep the line open for notifications.
3.  The `MatchmakingService` subscribes the user to a unique Redis Pub/Sub channel (e.g., `match_notification:userId`).
4.  It then iterates through the user's interests, checking the corresponding Redis queues (e.g., `interest:GAMING`) for a waiting user.
5.  **If a match is found:**
    * The matched user is atomically popped from the queue.
    * The service confirms all common interests between the two users.
    * A unique `chatId` is generated.
    * A chat server is assigned via the round-robin load balancer.
    * A persistent chat session is created and stored in Redis.
    * The waiting user is notified of the match via their Redis Pub/Sub channel, which sends the data down their open SSE connection.
    * The initiating user receives the match details immediately in the initial `/matchmaking` response.
6.  **If no match is found:**
    * The initiating user is added to the Redis queues for all of their specified interests.
    * A "WAITING" status is sent down the SSE connection.
    * The user now waits until another user with a common interest connects and finds them in the queue.

---

## API Endpoints

### 1. Find a Match or Wait in Queue

Initiates the matchmaking process for a user. This endpoint uses Server-Sent Events (SSE).

-   **Endpoint:** `GET /matchmaking`
-   **Query Parameters:**
    -   `userId` (string, **required**): The unique ID of the user.
    -   `interest` (string, optional): A comma-separated list of interests (e.g., `gaming,anime,music`). Defaults to `GLOBAL_CHAT` if empty.
-   **Responses (Streaming `text/event-stream`):**
    -   `data: {"state":"WAITING"}`: Sent immediately if no match is found and the user is added to the queue.
    -   `data: {"state":"MATCHED", "matchedUserId": "...", "interest": "...", "chatId": "...", "chatServerUrl": "..."}`: Sent when a match is found. The connection is then closed.
    -   `data: {"state":"MAINTENANCE", "message":"..."}`: If the service is in maintenance mode.
-   **Error Response:**
    -   `400 Bad Request`: If `userId` is missing.

### 2. Check for an Active Session

Checks if a user has an existing, active chat session. Clients should call this on startup.

-   **Endpoint:** `GET /session/:userId`
-   **Success Response (`200 OK`):**
    -   If a session exists, returns the session details:
        ```json
        {
            "chatId": "a1b2c3d4e5f6",
            "serverUrl": "[http://chat-server-1.example.com](http://chat-server-1.example.com)",
            "participants": ["user123", "user456"]
        }
        ```
    -   If no session exists:
        ```json
        { "message": "No active session found for this user." }
        ```

### 3. Disconnect a Session

Manually ends the user's current chat session.

-   **Endpoint:** `POST /session/disconnect`
-   **Body:**
    ```json
    { "userId": "user123" }
    ```
-   **Success/Error Responses:**
    -   `200 OK`: `{ "message": "Session disconnected successfully." }`
    -   `404 Not Found`: `{ "message": "No active session found to disconnect." }`
    -   `400 Bad Request`: `{ "message": "User ID is required..." }`

### 4. Cancel Matchmaking

Removes a user from all waiting queues.

-   **Endpoint:** `POST /cancel_matchmaking`
-   **Body:**
    ```json
    {
      "userId": "user123",
      "interests": ["gaming", "anime"]
    }
    ```
-   **Success Response (`200 OK`):**
    `{ "message": "Matchmaking cancelled successfully." }`

### 5. Get Popular Interests

Retrieves a list of the most popular interests based on recent activity.

-   **Endpoint:** `GET /interests/popular`
-   **Success Response (`200 OK`):**
    ```json
    [
      { "interest": "GAMING", "count": 150 },
      { "interest": "MUSIC", "count": 125 },
      { "interest": "MOVIES", "count": 90 }
    ]
    ```

### 6. Service Status & Health

-   **Endpoint:** `GET /status`
    -   Returns a detailed JSON object with service state, Redis connectivity, queue/session metrics, OS info, and memory usage.
-   **Endpoint:** `GET /maintenance`
    -   Returns the current maintenance state of the service.

---

## Redis Data Structures

The service relies on several Redis key patterns:

-   `interest:<INTEREST_NAME>` (Set): Stores `userId`s waiting in a specific interest queue.
-   `user_interests:<userId>` (Set): Stores the complete list of interests for a user while they are in the queue.
-   `chat_session:<chatId>` (String, JSON): Contains the `serverUrl` and `participants` for an active chat.
-   `user_session:<userId>` (String): Maps a `userId` to their active `chatId` for quick lookups.
-   `popular:<INTEREST_NAME>` (Sorted Set): Members are `userId`s, scores are timestamps. Used to calculate recent popularity.
-   `match_notification:<userId>` (Pub/Sub Channel): A unique channel per user for receiving match notifications.

---

## Environment Variables

-   **`PORT`**: The port for the matchmaking server. Default: `3000`.
-   **`REDIS_URL`**: The connection URL for the Redis instance. Default: `redis://localhost:6379`.
-   **`DISCOVERY_SERVER_URL`**: The base URL of the AnimoChat Service Discovery. Default: `https://animochat-service-discovery.onrender.com/`.
-   **`RENDER_EXTERNAL_URL`**: The publicly accessible URL of this service. **Required for service registration.** This is often provided by hosting platforms like Render.

---

## Getting Started

### Prerequisites

-   [Node.js](https://nodejs.org/) (v16.x or higher)
-   [npm](https://www.npmjs.com/) or [yarn](https://yarnpkg.com/)
-   A running [Redis](https://redis.io/) instance.
-   A running instance of the [AnimoChat Service Discovery](#).

### Installation & Running

1.  **Clone the repository:**
    ```bash
    git clone <your-repository-url>
    cd <repository-directory>
    ```

2.  **Install dependencies:**
    ```bash
    npm install
    ```

3.  **Configure environment:**
    Create a `.env` file in the root of the project and add the necessary variables:
    ```env
    PORT=3000
    REDIS_URL=redis://127.0.0.1:6379
    DISCOVERY_SERVER_URL=http://localhost:3009
    RENDER_EXTERNAL_URL=http://localhost:3000
    ```

4.  **Run the server:**
    ```bash
    npm start
    ```

The server should now be running and will attempt to register itself with the discovery service.
