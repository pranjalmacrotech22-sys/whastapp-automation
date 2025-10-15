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
    const xmlFilesInput = document.getElementById('xmlFiles'); // New
    const uploadButton = document.getElementById('uploadButton'); // New

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

    logoutButton.addEventListener('click', async () => {
        await supabase.auth.signOut();
        socket.disconnect(); // Disconnect and reconnect to start fresh
        socket.connect();
        
        showStep('email-login-container');
        logElement.textContent = '';
        clientIdInput.value = '';
        qrContainer.innerHTML = '';
        statusElement.textContent = 'Connecting...';
    });
    
    socket.on('client_id_verified', (data) => {
        loggedInUserElement.textContent = data.clientId;
        showStep('app-container');
        socket.emit('setup_client', { clientId: data.clientId });
    });

    socket.on('client_id_error', (data) => {
        clientIdError.textContent = data.message;
    });

    socket.on('qr', (qrCodeDataUrl) => {
        qrContainer.innerHTML = `<img src="${qrCodeDataUrl}" alt="QR Code">`;
        statusElement.textContent = 'Please scan the QR Code to connect.';
        uploadButton.disabled = true;
    });

    socket.on('ready', () => {
        statusElement.textContent = 'WhatsApp is connected and ready!';
        qrContainer.innerHTML = '';
        uploadButton.disabled = false;
    });

    socket.on('log', (message) => {
        logElement.textContent += message + '\n';
        logElement.scrollTop = logElement.scrollHeight;
    });

    socket.on('disconnect', () => {
        statusElement.textContent = 'Disconnected from server. Please refresh.';
        uploadButton.disabled = true;
    });

    // --- [NEW] File Upload Logic ---
    uploadButton.addEventListener('click', () => {
        const files = xmlFilesInput.files;
        if (files.length === 0) {
            alert('Please select one or more XML files to process.');
            return;
        }

        uploadButton.disabled = true;
        logElement.textContent = `--- Starting to upload ${files.length} file(s)... ---\n`;

        // The socket will process one file at a time
        // We get the file content and send it to the server
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            const reader = new FileReader();
            
            reader.onload = (e) => {
                const fileContent = e.target.result;
                socket.emit('process_file', {
                    fileName: file.name,
                    content: fileContent
                });
            };

            reader.readAsText(file);
        }

        // Re-enable the button after a short delay
        setTimeout(() => {
            uploadButton.disabled = false;
            xmlFilesInput.value = ''; // Clear the file input
        }, 1500);
    });
});