// PASTE THIS ENTIRE CODE INTO YOUR server.js FILE

const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const { Client, MessageMedia, LocalAuth } = require('whatsapp-web.js');
const fs = require('fs-extra');
const path = require('path');
const xml2js = require('xml2js');
const qrcode = require('qrcode');
const chokidar = require('chokidar');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const port = process.env.PORT || 3000;

const supabaseUrl = 'https://xcglljpdnofeipgytigz.supabase.co';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

app.use(express.static(path.join(__dirname, 'public')));

const clients = new Map();
const watchers = new Map();
const processingQueue = [];
let isWorkerRunning = false;

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

    socket.on('verify_client_id', async ({ clientId, accessToken }) => {
        // ... (rest of the code is the same)
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
                    clientId: clientId
                    // The `dataPath` option has been REMOVED.
                    // The session will be stored temporarily and lost on restart.
                }),
                puppeteer: {
                    headless: true,
                    args: [
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-dev-shm-usage',
                        '--single-process'
                    ]
                },
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

    // ... (rest of the file is exactly the same)
    const sendLog = (message) => socket.emit('log', message);

    socket.on('start_watching', (paths) => {
        const { clientId } = socket;
        if (!clientId || !paths || !paths.source || !paths.processed) return;
        if (watchers.has(socket.id)) watchers.get(socket.id).close();
        sendLog(`Starting to watch folder: ${paths.source}`);
        const watcher = chokidar.watch(paths.source, {
            ignored: /^\./, persistent: true,
            awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 100 }
        });
        watchers.set(socket.id, watcher);
        socket.emit('watching');
        watcher.on('add', (filePath) => {
            if (path.extname(filePath).toLowerCase() === '.xml') {
                const clientEntry = clients.get(clientId);
                if (clientEntry && clientEntry.ready) {
                    sendLog(`New file queued: ${path.basename(filePath)}`);
                    processingQueue.push({ client: clientEntry.client, sendLog, filePath, processedFolderPath: paths.processed });
                    startQueueWorker();
                } else {
                    sendLog(`Client for ${clientId} not ready. Cannot process.`);
                }
            }
        });
        watcher.on('error', (error) => sendLog(`Watcher error: ${error}`));
    });

    socket.on('stop_watching', async (callback) => {
        if (watchers.has(socket.id)) {
            watchers.get(socket.id).close();
            watchers.delete(socket.id);
        }
        await releaseClient(socket.clientId);
        socket.emit('stopped_watching');
        if (typeof callback === 'function') {
            callback();
        }
    });

    socket.on('disconnect', async () => {
        if (watchers.has(socket.id)) {
            watchers.get(socket.id).close();
            watchers.delete(socket.id);
        }
        await releaseClient(socket.clientId);
    });
});

async function startQueueWorker() {
    if (isWorkerRunning) return;
    isWorkerRunning = true;
    while (processingQueue.length > 0) {
        const job = processingQueue.shift();
        job.sendLog(`--- Processing: ${path.basename(job.filePath)} ---`);
        try {
            await processSingleFile(job.client, job.sendLog, job.filePath, job.processedFolderPath);
        } catch (error) {
            job.sendLog(`FATAL ERROR processing ${path.basename(job.filePath)}: ${error.message}`);
        }
    }
    isWorkerRunning = false;
}

async function processSingleFile(client, sendLog, filePath, processedFolderPath) {
    const fileName = path.basename(filePath);
    try {
        const fileBuffer = await fs.readFile(filePath);
        let xmlData;
        if (fileBuffer[0] === 0xFF && fileBuffer[1] === 0xFE) {
            sendLog(`Detected UTF-16 LE encoding for ${fileName}.`);
            xmlData = fileBuffer.toString('utf16le');
        } else {
            sendLog(`Assuming UTF-8 encoding for ${fileName}.`);
            xmlData = fileBuffer.toString('utf8');
        }
        const cleanedXmlData = xmlData.replace(/^\uFEFF/, '');
        const result = await new xml2js.Parser().parseStringPromise(cleanedXmlData);
        if (!result.ENVELOP) throw new Error(`Missing <ENVELOP> tag.`);
        const countryCode = result.ENVELOP.COUNTRYCODE[0];
        const mobileNumber = result.ENVELOP.MOBILE[0];
        const messageText = result.ENVELOP.TEXT[0];
        const pdfPath = result.ENVELOP.PATH[0];
        const chatId = `${countryCode}${mobileNumber}@c.us`;

        await client.sendMessage(chatId, messageText);
        sendLog(`Message sent to ${countryCode}${mobileNumber}`);

        if (pdfPath && pdfPath.trim() !== "" && await fs.exists(pdfPath)) {
            const media = MessageMedia.fromFilePath(pdfPath);
            await client.sendMessage(chatId, media);
            sendLog(`Attachment sent for ${fileName}`);
        } else if (pdfPath && pdfPath.trim() !== "") {
            sendLog(`WARNING: Attachment not found at ${pdfPath}`);
        }

        const newPath = path.join(processedFolderPath, fileName);
        await fs.move(filePath, newPath, { overwrite: true });
        sendLog(`Moved ${fileName} to processed folder.`);

        sendLog(`Waiting for 3 seconds...`);
        await delay(3000);

    } catch (error) {
        sendLog(`ERROR processing ${fileName}: ${error.message}`);
        throw error;
    }
}

server.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});