const http = require('http');
const { randomUUID } = require('crypto');
const WebSocket = require('ws');

// --- YOUR CONFIGURATION ---
const GATEWAY_URL = 'wss://poorna-clawe.fly.dev'; // Connect to hosted Fly.io app
const GATEWAY_TOKEN = '12f82512f0891c59aaed895b5c74c072ddc5ce59768732bc568d705162f4b65a'; // Your secure token
const API_PORT = 3001; // The port for THIS local adapter
// --------------------------

// Global State
let ws = null;
let isConnected = false;

// Maps
const pendingHttp = new Map(); // reqId -> { res, startTime, fullText: '' }
const activeRuns = new Map();  // runId -> reqId (pointer to pendingHttp key)
const earlyEvents = new Map(); // runId -> [eventFrames]

function connectGateway() {
    console.log(`[Gateway] Connecting to ${GATEWAY_URL}...`);
    ws = new WebSocket(GATEWAY_URL);

    ws.onopen = () => {
        console.log('[Gateway] Connected. Sending handshake...');
        ws.send(JSON.stringify({
            type: 'req',
            id: 'handshake-' + Date.now(),
            method: 'connect',
            params: {
                minProtocol: 3, maxProtocol: 3,
                client: { id: 'gateway-client', version: '1.0.0', platform: 'node', mode: 'backend' },
                auth: { token: GATEWAY_TOKEN }
            }
        }));
    };

    ws.onmessage = (event) => {
        try {
            const frame = JSON.parse(event.data);

            // 1. Handshake Response
            if (frame.type === 'res' && frame.id.startsWith('handshake-')) {
                if (frame.ok) {
                    isConnected = true;
                    console.log('[Gateway] Authenticated!');
                } else {
                    console.error('[Gateway] Auth Failed:', frame.error);
                }
                return;
            }

            // 2. Response to chat.send (links reqId -> runId)
            if (frame.type === 'res' && pendingHttp.has(frame.id)) {
                const reqId = frame.id;

                if (!frame.ok) {
                    console.error('[Req Failed]', reqId, frame.error);
                    const client = pendingHttp.get(reqId);
                    client.res.writeHead(500);
                    client.res.end(JSON.stringify({ error: frame.error }));
                    pendingHttp.delete(reqId);
                    return;
                }

                const runId = frame.payload?.runId;
                if (runId) {
                    console.log(`[Linked] Req ${reqId} -> Run ${runId}`);
                    activeRuns.set(runId, reqId);

                    // Replay any early events
                    if (earlyEvents.has(runId)) {
                        console.log(`[Replay] Processing ${earlyEvents.get(runId).length} queued events for ${runId}`);
                        const events = earlyEvents.get(runId);
                        events.forEach(evt => processChatEvent(evt));
                        earlyEvents.delete(runId);
                    }
                }
                return;
            }

            // 3. Chat Events
            if (frame.type === 'event' && frame.event === 'chat') {
                processChatEvent(frame);
            }

        } catch (e) {
            console.error('Message error:', e);
        }
    };

    ws.onclose = () => {
        console.log('[Gateway] Disconnected. Reconnecting in 3s...');
        isConnected = false;
        setTimeout(connectGateway, 3000);
    };

    ws.onerror = (e) => console.error('[Gateway] Error:', e.message || e);
}

function processChatEvent(frame) {
    const { runId, state, message } = frame.payload;

    if (!activeRuns.has(runId)) {
        if (pendingHttp.size > 0) {
            console.log(`[Queue] Early event for unknown Run ${runId}`);
            if (!earlyEvents.has(runId)) earlyEvents.set(runId, []);
            earlyEvents.get(runId).push(frame);
        }
        return;
    }

    const reqId = activeRuns.get(runId);
    const client = pendingHttp.get(reqId);

    if (!client) return;

    if (state === 'delta') {
        let text = '';
        if (message?.content && Array.isArray(message.content)) {
            text = message.content.map(c => c.text || '').join('');
        } else {
            text = message?.text || '';
        }
        client.fullText = text;
    } else if (state === 'final') {
        console.log(`[Done] Run ${runId} finished. Replying to HTTP.`);
        client.res.writeHead(200, { 'Content-Type': 'application/json' });
        client.res.end(JSON.stringify({
            ok: true,
            response: client.fullText
        }));

        pendingHttp.delete(reqId);
        activeRuns.delete(runId);
    } else if (state === 'error') {
        client.res.writeHead(500);
        client.res.end(JSON.stringify({ error: frame.payload.errorMessage || 'Agent Error' }));
        pendingHttp.delete(reqId);
        activeRuns.delete(runId);
    }
}

connectGateway();

const server = http.createServer(async (req, res) => {
    const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';

    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (req.url === '/api/chat' && req.method === 'POST') {
        console.log(`[HTTP] POST /api/chat`);

        if (!isConnected) {
            res.writeHead(503);
            res.end(JSON.stringify({ error: 'Gateway not connected' }));
            return;
        }

        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { message } = JSON.parse(body);
                const reqId = 'http-req-' + randomUUID();

                console.log(`[HTTP] Received: "${message}" -> ID: ${reqId}`);

                pendingHttp.set(reqId, { res, fullText: '', startTime: Date.now() });

                ws.send(JSON.stringify({
                    type: 'req',
                    id: reqId,
                    method: 'chat.send',
                    params: {
                        sessionKey: 'main',
                        message: message,
                        idempotencyKey: randomUUID()
                    } // Make sure to close this bracket!
                }));

                setTimeout(() => {
                    if (pendingHttp.has(reqId)) {
                        console.log(`[Timeout] ${reqId}`);
                        const r = pendingHttp.get(reqId);
                        r.res.writeHead(504);
                        r.res.end(JSON.stringify({ error: 'Timeout waiting for agent' }));
                        pendingHttp.delete(reqId);
                    }
                }, 30000);

            } catch (e) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Invalid JSON' }));
            }
        });
        return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not Found' }));
});


server.listen(API_PORT, () => {
    console.log(`REST Adapter running at http://localhost:${API_PORT}`);
});
