const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const { Client, MessageMedia, LocalAuth } = require('whatsapp-web.js');
const fs = require('fs-extra');
const path = require('path');
const xml2js = require('xml2js');
const qrcode = require('qrcode');
// const chokidar = require('chokidar'); // No longer needed
const { createClient } = require('@supabase/supabase-js');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const port = process.env.PORT || 3000;

// Supabase Setup
const supabaseUrl = 'https://xcglljpdnofeipgytigz.supabase.co';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

app.use(express.static(path.join(__dirname, 'public')));

const clients = new Map();
// const watchers = new Map(); // No longer needed
// const processingQueue = []; // We process immediately now
// let isWorkerRunning = false; // No longer needed

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const releaseClient = async (clientId) => {
    if (!clientId) return;
    console.log(`Releasing client ID in Supabase: ${clientId}`);
    const { error } = await supabase
        .from('profiles')
        .update({ is_running: false })
        .eq('uniqe_user_id', clientId);
    if (error) {
        console.error(`Error releasing client ID ${clientId}:`, error.message);
    } else {
        console.log(`Successfully released client ID: ${clientId}`);
    }
};

io.on('connection', (socket) => {
    console.log(`A user connected with socket ID: ${socket.id}`);

    // ... (verify_client_id and setup_client are the same)
    socket.on('verify_client_id', async ({ clientId, accessToken }) => {
        if (!accessToken) return socket.emit('client_id_error', { message: 'Authentication token is missing.' });

        const { data: { user }, error: userError } = await supabase.auth.getUser(accessToken);
        if (userError || !user) return socket.emit('client_id_error', { message: 'Invalid session. Please log in again.' });

        const { data, error } = await supabase
            .from('profiles')
            .select('is_running')
            .eq('uniqe_user_id', clientId).eq('user_id', user.id)
            .single();

        if (error || !data) return socket.emit('client_id_error', { message: 'Client ID is invalid or not linked to your account.' });
        if (data.is_running) return socket.emit('client_id_error', { message: 'This Client ID is already in use.' });

        const { error: updateError } = await supabase
            .from('profiles')
            .update({ is_running: true })
            .eq('uniqe_user_id', clientId);

        if (updateError) return socket.emit('client_id_error', { message: `Database error: ${updateError.message}` });

        socket.clientId = clientId;
        socket.emit('client_id_verified', { clientId });
    });

    socket.on('setup_client', ({ clientId }) => {
        if (!clients.has(clientId)) {
            const newClient = new Client({
                authStrategy: new LocalAuth({
                    clientId: clientId,
                }),
                puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] },
                webVersionCache: { type: 'remote', remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html' }
            });
            newClient.on('qr', async (qr) => {
                socket.emit('qr', await qrcode.toDataURL(qr));
            });
            newClient.on('ready', () => {
                const clientEntry = clients.get(clientId);
                if (clientEntry) clientEntry.ready = true;
                socket.emit('ready');
            });
            newClient.on('auth_failure', msg => console.error(`AUTH FAILURE for ${clientId}:`, msg));
            newClient.initialize().catch(err => console.error(`Init error for ${clientId}:`, err));
            clients.set(clientId, { client: newClient, ready: false });
        } else {
            const clientEntry = clients.get(clientId);
            if (clientEntry && clientEntry.ready) socket.emit('ready');
        }
    });
    
    // --- [NEW] This replaces the entire file watcher logic ---
    socket.on('process_file', async ({ fileName, content }) => {
        const { clientId } = socket;
        const sendLog = (message) => socket.emit('log', message);
        
        sendLog(`--- Received file: ${fileName} ---`);

        const clientEntry = clients.get(clientId);
        if (!clientEntry || !clientEntry.ready) {
            return sendLog(`ERROR: WhatsApp client is not ready. Cannot process ${fileName}.`);
        }

        try {
            await processSingleFile(clientEntry.client, sendLog, fileName, content);
        } catch (error) {
            sendLog(`FATAL ERROR processing ${fileName}: ${error.message}`);
        }
    });


    socket.on('disconnect', async () => {
        // Release the client ID in Supabase when the user disconnects
        await releaseClient(socket.clientId);
    });
});

// The processSingleFile function is now simplified
async function processSingleFile(client, sendLog, fileName, xmlContent) {
    try {
        // Clean the BOM character just in case
        const cleanedXmlData = xmlContent.replace(/^\uFEFF/, '');
        const result = await new xml2js.Parser().parseStringPromise(cleanedXmlData);
        
        if (!result.ENVELOP) throw new Error(`Missing <ENVELOP> tag.`);
        
        const countryCode = result.ENVELOP.COUNTRYCODE[0];
        const mobileNumber = result.ENVELOP.MOBILE[0];
        const messageText = result.ENVELOP.TEXT[0];
        const pdfPath = result.ENVELOP.PATH ? result.ENVELOP.PATH[0] : null; // Handle optional PDF path
        const chatId = `${countryCode}${mobileNumber}@c.us`;

        await client.sendMessage(chatId, messageText);
        sendLog(`Message sent to ${countryCode}${mobileNumber} for file ${fileName}`);

        // The PDF attachment logic will NOT work in this workflow because
        // the browser cannot access local file paths like "C:\...".
        // This would have to be implemented with a second file upload input.
        if (pdfPath && pdfPath.trim() !== "") {
            sendLog(`WARNING: PDF attachments are not supported in this workflow. Attachment at ${pdfPath} was ignored.`);
        }
        
        sendLog(`Successfully processed ${fileName}.`);
        
        sendLog(`Waiting for 3 seconds...`);
        await delay(3000);

    } catch (error) {
        sendLog(`ERROR processing ${fileName}: ${error.message}`);
        throw error; // Propagate error to be caught by the caller
    }
}

server.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});