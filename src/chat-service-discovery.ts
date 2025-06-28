import { DISCOVERY_SERVER_URL } from "./service";

const CHAT_SERVICE_NAME = 'chat-service';
const CHAT_SERVICE_VERSION = '1.0.0';

/**
 * Retrieves the list of chat services available in the system.
 * This function queries the service discovery system to get the names of all registered chat services.
 * * @returns {Promise<string[]>} A promise that resolves to an array of chat service names. 
 **/
export async function getChatServices(): Promise<string[]> {
    // api:
    // app.get('/discover/:serviceName/:version/all')
    try {
        const response = await fetch(`${DISCOVERY_SERVER_URL}/discover/${CHAT_SERVICE_NAME}/${CHAT_SERVICE_VERSION}/all`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
            },
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch chat services. Status: ${response.status}`);
        }

        const data = await response.json();

        // make sure the data is an array of objects with url key
        if (Array.isArray(data) && data.every(service => typeof service.url === 'string')) {
            return data.map(service => service.url);
        } else {
            throw new Error('Invalid data format received from discovery server');
        }
    } catch (error) {
        console.error('Error fetching chat services:', (error as Error).message);
    }
    return [];
}


console.log(await getChatServices());
