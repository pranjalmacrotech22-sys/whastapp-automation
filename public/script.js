document.addEventListener('DOMContentLoaded', () => {
    const socket = io();

    // --- Supabase Config ---
    const supabaseUrl = 'https://xcglljpdnofeipgytigz.supabase.co';
    const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhjZ2xsanBkbm9mZWlwZ3l0aWd6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjAwMzU1MzEsImV4cCI6MjA3NTYxMTUzMX0.XIZ8sP1PF6GAxp08h3x8mIZGQr0fWcUeN9cJ3HjowCE';
    const supabase = window.supabase.createClient(supabaseUrl, supabaseAnonKey);

    // --- All Form Steps ---
    const steps = document.querySelectorAll('.form-step');

    // --- Login Elements ---
    const emailInput = document.getElementById('email');
    const passwordInput = document.getElementById('password');
    const emailLoginButton = document.getElementById('emailLoginButton');
    const loginError = document.getElementById('login-error');

    // --- Client ID Elements ---
    const clientIdInput = document.getElementById('clientId');
    const startSessionButton = document.getElementById('startSessionButton');
    const clientIdError = document.getElementById('client-id-error');

    // --- App Elements ---
    const loggedInUserElement = document.getElementById('loggedInUser');
    const logoutButton = document.getElementById('logoutButton');
    const statusElement = document.getElementById('status');
    const qrContainer = document.getElementById('qrcode-container');
    const logElement = document.getElementById('log');
    const startButton = document.getElementById('startButton');
    const stopButton = document.getElementById('stopButton');
    const sourceFolderInput = document.getElementById('sourceFolder');
    const processedFolderInput = document.getElementById('processedFolder');

    const showStep = (stepId) => {
        steps.forEach(step => step.classList.remove('active'));
        document.getElementById(stepId).classList.add('active');
    };

    emailLoginButton.addEventListener('click', async () => {
        loginError.textContent = '';
        emailLoginButton.disabled = true;
        emailLoginButton.textContent = 'Logging in...';

        const { data, error } = await supabase.auth.signInWithPassword({
            email: emailInput.value.trim(),
            password: passwordInput.value.trim(),
        });
        
        emailLoginButton.disabled = false;
        emailLoginButton.textContent = 'Login';

        if (error) {
            loginError.textContent = `Login Failed: ${error.message}`;
        } else {
            showStep('client-id-container');
            passwordInput.value = '';
        }
    });
    
    startSessionButton.addEventListener('click', async () => {
        clientIdError.textContent = '';
        const clientId = clientIdInput.value.trim();
        if (!clientId) {
            alert('Please enter a Client ID to start a session.');
            return;
        }
        
        const { data: { session }, error } = await supabase.auth.getSession();
        if (error || !session) {
            clientIdError.textContent = 'Could not get user session. Please log in again.';
            return;
        }

        const accessToken = session.access_token;
        socket.emit('verify_client_id', { clientId, accessToken });
    });

    logoutButton.addEventListener('click', () => {
        socket.emit('stop_watching', async () => {
            await supabase.auth.signOut();
            
            showStep('email-login-container');
            logElement.textContent = '';
            clientIdInput.value = '';
            qrContainer.innerHTML = '';
            statusElement.textContent = 'Connecting...';
        });
    });
    
    socket.on('client_id_verified', (data) => {
        loggedInUserElement.textContent = data.clientId;
        showStep('app-container');
        socket.emit('setup_client', { clientId: data.clientId });
    });

    socket.on('client_id_error', (data) => {
        clientIdError.textContent = data.message;
    });

    const setInputsDisabled = (disabled) => {
        sourceFolderInput.disabled = disabled;
        processedFolderInput.disabled = disabled;
    };

    socket.on('qr', (qrCodeDataUrl) => {
        qrContainer.innerHTML = `<img src="${qrCodeDataUrl}" alt="QR Code">`;
        statusElement.textContent = 'Please scan the QR Code to connect.';
        startButton.disabled = true;
    });

    socket.on('ready', () => {
        statusElement.textContent = 'WhatsApp is connected and ready!';
        qrContainer.innerHTML = '';
        startButton.disabled = false;
    });

    socket.on('watching', () => {
        statusElement.textContent = 'Actively watching for new files...';
        startButton.disabled = true;
        stopButton.disabled = false;
        setInputsDisabled(true);
    });
    
    socket.on('stopped_watching', () => {
        statusElement.textContent = 'Stopped watching. Ready to start again.';
        startButton.disabled = false;
        stopButton.disabled = true;
        setInputsDisabled(false);
        logElement.textContent += '\n--- Watcher Stopped ---\n';
    });
    
    socket.on('log', (message) => {
        logElement.textContent += message + '\n';
        logElement.scrollTop = logElement.scrollHeight;
    });

    socket.on('disconnect', () => {
        statusElement.textContent = 'Disconnected from server. Please refresh.';
        startButton.disabled = true;
        stopButton.disabled = true;
        setInputsDisabled(true);
    });

    startButton.addEventListener('click', () => {
        const sourcePath = sourceFolderInput.value.trim();
        const processedPath = processedFolderInput.value.trim();
        if (!sourcePath || !processedPath) {
            alert('Please provide paths for both the Source and Processed folders.');
            return;
        }
        logElement.textContent = '--- Watcher Starting ---\n';
        socket.emit('start_watching', {
            source: sourcePath,
            processed: processedPath
        });
    });

    stopButton.addEventListener('click', () => {
        socket.emit('stop_watching', () => {
             console.log('Server confirmed watcher has stopped.');
        });
    });
});