<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Router - Multi-Model AI Interface</title>
    <style>
        :root {
            --primary: #00f3ff;
            --secondary: #7f52ff;
            --accent: #00ff88;
            --danger: #ff4757;
            --warning: #ffa502;
            --bg-dark: #0a0a1a;
            --bg-card: rgba(15, 15, 35, 0.85);
            --bg-glass: rgba(25, 25, 55, 0.75);
            --border-color: rgba(0, 243, 255, 0.2);
            --border-hover: rgba(0, 243, 255, 0.5);
            --text-primary: #e0e0ff;
            --text-secondary: #a0a0c0;
            --text-muted: #606080;
        }

        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        html, body {
            height: 100%;
            overflow: hidden;
            font-family: 'JetBrains Mono', 'Fira Code', 'Courier New', monospace;
            font-size: 14px;
        }

        body {
            background: var(--bg-dark);
            color: var(--text-primary);
            position: relative;
        }

        .container {
            position: relative;
            max-width: 1400px;
            margin: 0 auto;
            padding: 15px;
            height: 100vh;
            display: flex;
            flex-direction: column;
        }

        .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 12px 20px;
            background: rgba(15, 15, 35, 0.7);
            border: 1px solid var(--border-color);
            border-radius: 16px;
            margin-bottom: 15px;
        }

        .logo {
            display: flex;
            align-items: center;
            gap: 12px;
        }

        .logo-text {
            font-size: 1.3rem;
            font-weight: 700;
            color: var(--primary);
        }

        .header-controls {
            display: flex;
            gap: 12px;
            align-items: center;
        }

        .btn {
            padding: 8px 18px;
            border: 1px solid var(--border-color);
            border-radius: 10px;
            background: var(--bg-glass);
            color: var(--text-primary);
            font-family: inherit;
            font-size: 0.9rem;
            cursor: pointer;
            transition: all 0.3s ease;
            display: flex;
            align-items: center;
            gap: 6px;
        }

        .btn:hover {
            background: rgba(0, 243, 255, 0.1);
            transform: translateY(-1px);
        }

        .btn-primary {
            background: linear-gradient(135deg, var(--primary), var(--secondary));
            border-color: transparent;
            color: white;
        }

        .btn-danger {
            background: rgba(255, 71, 87, 0.2);
            color: var(--danger);
        }

        .main-content {
            display: flex;
            gap: 15px;
            flex: 1;
            overflow: hidden;
        }

        .sidebar {
            width: 320px;
            background: var(--bg-card);
            border: 1px solid var(--border-color);
            border-radius: 16px;
            overflow: hidden;
            display: flex;
            flex-direction: column;
        }

        .sidebar-tabs {
            display: flex;
            border-bottom: 1px solid var(--border-color);
            background: var(--bg-glass);
        }

        .sidebar-tab {
            flex: 1;
            padding: 12px;
            text-align: center;
            cursor: pointer;
            border-bottom: 2px solid transparent;
            font-size: 0.85rem;
            color: var(--text-secondary);
        }

        .sidebar-tab:hover {
            color: var(--text-primary);
        }

        .sidebar-tab.active {
            border-color: var(--primary);
            color: var(--primary);
        }

        .sidebar-content {
            flex: 1;
            overflow-y: auto;
            padding: 15px;
        }

        .sidebar-item {
            padding: 12px 16px;
            border-radius: 10px;
            margin-bottom: 8px;
            background: var(--bg-glass);
            border: 1px solid var(--border-color);
            cursor: pointer;
        }

        .sidebar-item:hover {
            background: rgba(0, 243, 255, 0.05);
        }

        .sidebar-item.active {
            background: rgba(0, 243, 255, 0.1);
            border-color: var(--primary);
        }

        .chat-container {
            flex: 2;
            display: flex;
            flex-direction: column;
            background: var(--bg-card);
            border: 1px solid var(--border-color);
            border-radius: 16px;
            overflow: hidden;
        }

        .chat-header {
            padding: 12px 20px;
            background: var(--bg-glass);
            border-bottom: 1px solid var(--border-color);
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .session-title {
            font-size: 1.1rem;
            font-weight: 600;
        }

        .chat-messages {
            flex: 1;
            overflow-y: auto;
            padding: 20px;
            display: flex;
            flex-direction: column;
            gap: 18px;
        }

        .message {
            max-width: 80%;
            padding: 14px 18px;
            border-radius: 16px;
            background: var(--bg-glass);
            border: 1px solid var(--border-color);
        }

        .message.user {
            align-self: flex-end;
            background: rgba(0, 243, 255, 0.1);
            border-color: rgba(0, 243, 255, 0.3);
        }

        .message.assistant {
            align-self: flex-start;
            background: rgba(127, 82, 255, 0.1);
            border-color: rgba(127, 82, 255, 0.3);
        }

        .message.system {
            align-self: center;
            background: rgba(0, 0, 0, 0.2);
            color: var(--text-secondary);
        }

        .message-content {
            line-height: 1.5;
            white-space: pre-wrap;
            word-break: break-word;
        }

        .code-block {
            background: rgba(0, 0, 0, 0.3);
            border: 1px solid var(--border-color);
            border-radius: 8px;
            margin: 10px 0;
            overflow: hidden;
        }

        .code-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 6px 12px;
            background: rgba(0, 0, 0, 0.2);
            border-bottom: 1px solid var(--border-color);
            font-size: 0.75rem;
            color: var(--text-secondary);
        }

        .copy-btn {
            background: rgba(0, 0, 0, 0.3);
            border: 1px solid var(--border-color);
            border-radius: 6px;
            padding: 4px 10px;
            color: var(--text-secondary);
            font-size: 0.7rem;
            cursor: pointer;
        }

        .copy-btn:hover {
            color: var(--primary);
        }

        .chat-input {
            padding: 18px;
            background: var(--bg-glass);
            border-top: 1px solid var(--border-color);
            display: flex;
            gap: 12px;
        }

        .chat-input textarea {
            flex: 1;
            background: rgba(0, 0, 0, 0.3);
            border: 1px solid var(--border-color);
            border-radius: 12px;
            padding: 14px 18px;
            color: var(--text-primary);
            font-family: inherit;
            font-size: 0.95rem;
            resize: none;
            height: 70px;
            outline: none;
        }

        .chat-input textarea:focus {
            border-color: var(--primary);
        }

        .send-btn {
            background: linear-gradient(135deg, var(--primary), var(--secondary));
            border: none;
            border-radius: 14px;
            padding: 14px 28px;
            color: white;
            cursor: pointer;
        }

        .no-sessions {
            text-align: center;
            padding: 30px;
            color: var(--text-muted);
        }

        .notification {
            position: fixed;
            top: 20px;
            right: 20px;
            padding: 14px 24px;
            border-radius: 10px;
            background: rgba(15, 15, 35, 0.95);
            z-index: 1000;
        }

        .overlay {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.95);
            z-index: 9999;
        }

        .overlay.visible {
            display: block;
        }

        .model-badge {
            font-size: 0.75rem;
            padding: 4px 10px;
            border-radius: 12px;
            background: rgba(0, 243, 255, 0.2);
            color: var(--primary);
        }

        .message-actions {
            display: flex;
            gap: 10px;
            margin-top: 10px;
        }

        .action-btn {
            background: rgba(0, 0, 0, 0.25);
            border: 1px solid var(--border-color);
            border-radius: 8px;
            padding: 6px 12px;
            color: var(--text-secondary);
            font-size: 0.75rem;
            cursor: pointer;
        }

        .action-btn:hover {
            color: var(--primary);
        }

        .form-group {
            display: flex;
            flex-direction: column;
            gap: 6px;
        }

        .form-group label {
            font-size: 0.85rem;
            color: var(--text-secondary);
        }

        .form-input, .form-select {
            padding: 10px 14px;
            background: rgba(0, 0, 0, 0.3);
            border: 1px solid var(--border-color);
            border-radius: 8px;
            color: var(--text-primary);
            font-family: inherit;
            font-size: 0.85rem;
        }

        .model-list-item {
            border: 1px solid var(--border-color);
            border-radius: 10px;
            padding: 12px;
            margin-bottom: 10px;
            background: var(--bg-glass);
        }

        .model-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .toggle-switch {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 8px 0;
        }

        .switch {
            position: relative;
            display: inline-block;
            width: 40px;
            height: 20px;
        }

        .switch input {
            opacity: 0;
            width: 0;
            height: 0;
        }

        .slider {
            position: absolute;
            cursor: pointer;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: var(--bg-glass);
            border: 1px solid var(--border-color);
            border-radius: 20px;
        }

        .slider:before {
            position: absolute;
            content: "";
            height: 14px;
            width: 14px;
            left: 3px;
            bottom: 3px;
            border-radius: 50%;
            background: white;
        }

        input:checked + .slider {
            background: var(--primary);
        }

        input:checked + .slider:before {
            transform: translateX(20px);
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="logo">
                <div class="logo-text">Router</div>
            </div>
            <div class="header-controls">
                <button class="btn" id="toggleGraphBtn">📊 Graph</button>
                <button class="btn" id="exportBtn">💾 Export</button>
                <button class="btn" id="settingsBtn">⚙️ Settings</button>
                <button class="btn btn-primary" id="newSessionBtn">➕ New</button>
            </div>
        </div>

        <div class="main-content">
            <div class="sidebar">
                <div class="sidebar-tabs">
                    <div class="sidebar-tab active" data-tab="sessions">Sessions</div>
                    <div class="sidebar-tab" data-tab="models">Models</div>
                    <div class="sidebar-tab" data-tab="topology">Network</div>
                    <div class="sidebar-tab" data-tab="settings">Settings</div>
                </div>
                <div class="sidebar-content" id="sidebarContent"></div>
            </div>

            <div class="chat-container">
                <div class="chat-header">
                    <div class="session-info">
                        <span class="session-title" id="sessionTitle">No Session Selected</span>
                    </div>
                    <div class="header-actions">
                        <button class="btn" id="closeSessionBtn" style="display: none;">🔒 Close</button>
                        <button class="btn btn-danger" id="deleteSessionBtn" style="display: none;">🗑️ Delete</button>
                    </div>
                </div>

                <div class="chat-messages" id="chatMessages">
                    <div class="message system">
                        Welcome to Router. Select a session or create a new one to begin.
                    </div>
                </div>

                <div class="chat-input">
                    <textarea id="promptInput" placeholder="Enter your prompt (Ctrl+Enter to send)..."></textarea>
                    <button class="send-btn" id="sendBtn">Send</button>
                </div>
            </div>
        </div>
    </div>

    <div class="notification" id="notification" style="display: none;">
        <span id="notificationMessage"></span>
    </div>

    <div id="graphOverlay" class="overlay">
        <div style="position: absolute; top: 15px; right: 15px; z-index: 10;">
            <button class="btn" id="closeGraphBtn">✕ Close</button>
        </div>
        <div id="fullscreenGraph" style="width: 100%; height: 100%; padding: 20px; overflow: auto;"></div>
    </div>

    <script>
        let state = {
            currentSession: null,
            sessions: [],
            models: [],
            activeTab: 'sessions'
        };

        function showNotification(message, type = 'success') {
            const notif = document.getElementById('notification');
            const notifMsg = document.getElementById('notificationMessage');
            notifMsg.textContent = message;
            notif.style.display = 'block';
            setTimeout(() => {
                notif.style.display = 'none';
            }, 3000);
        }

        async function apiCall(endpoint, data = null, method = 'GET') {
            const url = `/router/api${endpoint}`;
            const options = {
                method: method,
                headers: { 'Content-Type': 'application/json' }
            };
            if (data) {
                options.body = JSON.stringify(data);
            }
            
            const response = await fetch(url, options);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            return await response.json();
        }

        async function init() {
            try {
                await loadSessions();
                await loadModels();
                renderSessions();
                setupEventListeners();
            } catch(e) {
                showNotification('Error initializing: ' + e.message, 'error');
            }
        }

        async function loadSessions() {
            state.sessions = await apiCall('/sessions');
        }

        async function loadModels() {
            state.models = await apiCall('/models');
        }

        function setupEventListeners() {
            document.getElementById('newSessionBtn').addEventListener('click', createSession);
            document.getElementById('sendBtn').addEventListener('click', sendMessage);
            document.getElementById('promptInput').addEventListener('keydown', (e) => {
                if (e.ctrlKey && e.key === 'Enter') {
                    sendMessage();
                }
            });
            document.getElementById('settingsBtn').addEventListener('click', () => switchTab('settings'));
            document.getElementById('exportBtn').addEventListener('click', exportSession);
            document.getElementById('closeSessionBtn').addEventListener('click', closeSession);
            document.getElementById('deleteSessionBtn').addEventListener('click', deleteSession);
            document.getElementById('toggleGraphBtn').addEventListener('click', toggleGraph);
            document.getElementById('closeGraphBtn').addEventListener('click', toggleGraph);

            document.querySelectorAll('.sidebar-tab').forEach(tab => {
                tab.addEventListener('click', () => switchTab(tab.dataset.tab));
            });
        }

        function switchTab(tabName) {
            state.activeTab = tabName;
            document.querySelectorAll('.sidebar-tab').forEach(t => {
                t.classList.toggle('active', t.dataset.tab === tabName);
            });
            renderSidebarContent();
        }

        function renderSidebarContent() {
            const content = document.getElementById('sidebarContent');
            switch(state.activeTab) {
                case 'sessions': renderSessions(content); break;
                case 'models': renderModels(content); break;
                case 'topology': renderTopology(content); break;
                case 'settings': renderSettings(content); break;
            }
        }

        function renderSessions(container) {
            if (state.sessions.length === 0) {
                container.innerHTML = '<div class="no-sessions">No sessions yet. Click "New Session" to create one.</div>';
                return;
            }
            container.innerHTML = '';
            state.sessions.forEach(session => {
                const div = document.createElement('div');
                div.className = `sidebar-item ${session.id === state.currentSession?.id ? 'active' : ''}`;
                div.innerHTML = `<div class="item-header"><span class="item-title">${session.title}</span>
                    <span style="font-size:0.75rem;color:var(--accent)">●</span></div>
                    <div style="font-size:0.75rem;color:var(--text-secondary)">${new Date(session.last_activity * 1000).toLocaleTimeString()}</div>`;
                div.addEventListener('click', () => selectSession(session.id));
                container.appendChild(div);
            });
        }

        async function selectSession(sessionId) {
            try {
                const session = await apiCall(`/sessions/${sessionId}`);
                state.currentSession = session;
                document.getElementById('sessionTitle').textContent = session.title;
                document.getElementById('closeSessionBtn').style.display = 'block';
                document.getElementById('deleteSessionBtn').style.display = 'block';

                const messages = document.getElementById('chatMessages');
                messages.innerHTML = '';
                session.dialogs.forEach(dialog => {
                    const userMsg = document.createElement('div');
                    userMsg.className = 'message user';
                    userMsg.innerHTML = `<div class="message-content">${escapeHtml(dialog.user_input)}</div>`;
                    messages.appendChild(userMsg);

                    if (dialog.responses) {
                        dialog.responses.forEach(resp => {
                            const modelMsg = document.createElement('div');
                            modelMsg.className = 'message assistant';
                            modelMsg.innerHTML = `
                                <div class="model-badge">${resp.model_name} (${resp.role})</div>
                                <div class="message-content">${formatResponse(resp.response)}</div>
                                <div class="message-actions">
                                    <button class="action-btn" onclick="copyCode(this)">Copy Code</button>
                                    <button class="action-btn" onclick="resubmit(this)">Resubmit</button>
                                </div>`;
                            messages.appendChild(modelMsg);
                        });
                    }
                });
                messages.scrollTop = messages.scrollHeight;
            } catch(e) {
                showNotification('Error loading session', 'error');
            }
        }

        function formatResponse(text) {
            if (!text) return '';
            text = escapeHtml(text);
            text = text.replace(/```(\w+)?\n([\s\S]*?)```/g, (match, lang, code) => {
                return `<div class="code-block"><div class="code-header">${lang || 'code'}
                    <button class="copy-btn" onclick="copyToClipboard(this)">📋 Copy</button></div>
                    <pre style="padding:12px;overflow-x:auto;font-size:0.85rem">${code.trim()}</pre></div>`;
            });
            return text;
        }

        function escapeHtml(text) {
            if (!text) return '';
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        function copyToClipboard(button) {
            const pre = button.closest('.code-block').querySelector('pre');
            navigator.clipboard.writeText(pre.textContent).then(() => {
                showNotification('Code copied!');
            }).catch(() => {
                showNotification('Copy failed', 'error');
            });
        }

        function copyCode(button) {
            const msg = button.closest('.message');
            const content = msg.querySelector('.message-content');
            const codeBlocks = content.querySelectorAll('.code-block pre');
            if (codeBlocks.length > 0) {
                navigator.clipboard.writeText(codeBlocks[0].textContent).then(() => {
                    showNotification('Code copied!');
                });
            }
        }

        function resubmit(button) {
            const msg = button.closest('.message');
            const content = msg.querySelector('.message-content');
            document.getElementById('promptInput').value = content.textContent || content.innerText;
        }

        async function sendMessage() {
            const input = document.getElementById('promptInput');
            const prompt = input.value.trim();
            if (!prompt || !state.currentSession) {
                showNotification('Please select a session and enter a prompt', 'error');
                return;
            }
            input.value = '';
            const messages = document.getElementById('chatMessages');
            const userMsg = document.createElement('div');
            userMsg.className = 'message user';
            userMsg.innerHTML = `<div class="message-content">${escapeHtml(prompt)}</div>`;
            messages.appendChild(userMsg);

            const sendBtn = document.getElementById('sendBtn');
            sendBtn.disabled = true;
            sendBtn.textContent = 'Sending...';

            try {
                const response = await apiCall('/query', {
                    prompt: prompt,
                    session_id: state.currentSession.id
                }, 'POST');

                if (response.success && response.responses) {
                    response.responses.forEach(resp => {
                        const modelMsg = document.createElement('div');
                        modelMsg.className = 'message assistant';
                        modelMsg.innerHTML = `
                            <div class="model-badge">${resp.model_name} (${resp.role})</div>
                            <div class="message-content">${formatResponse(resp.response)}</div>
                            <div class="message-actions">
                                <button class="action-btn" onclick="copyCode(this)">Copy Code</button>
                                <button class="action-btn" onclick="resubmit(this)">Resubmit</button>
                            </div>`;
                        messages.appendChild(modelMsg);
                    });
                    messages.scrollTop = messages.scrollHeight;
                }
            } catch(error) {
                showNotification('Error sending message: ' + error.message, 'error');
            }

            sendBtn.disabled = false;
            sendBtn.textContent = 'Send';
        }

        async function createSession() {
            const title = prompt('Enter session name:');
            if (!title) return;
            try {
                const response = await apiCall('/sessions', { title }, 'POST');
                if (response.success) {
                    await loadSessions();
                    renderSessions(document.getElementById('sidebarContent'));
                    await selectSession(response.session_id);
                    showNotification('Session created!');
                }
            } catch(e) {
                showNotification('Error creating session', 'error');
            }
        }

        async function closeSession() {
            if (!state.currentSession) return;
            if (confirm('Close this session?')) {
                try {
                    await apiCall(`/sessions/close/${state.currentSession.id}`);
                    await loadSessions();
                    renderSessions(document.getElementById('sidebarContent'));
                    state.currentSession = null;
                    document.getElementById('sessionTitle').textContent = 'No Session Selected';
                    document.getElementById('closeSessionBtn').style.display = 'none';
                    document.getElementById('deleteSessionBtn').style.display = 'none';
                    document.getElementById('chatMessages').innerHTML = '<div class="message system">Session closed.</div>';
                    showNotification('Session closed');
                } catch(e) {
                    showNotification('Error closing session', 'error');
                }
            }
        }

        async function deleteSession() {
            if (!state.currentSession) return;
            if (confirm('Delete this session permanently?')) {
                try {
                    await apiCall(`/sessions/${state.currentSession.id}`, { delete: true }, 'PUT');
                    await loadSessions();
                    renderSessions(document.getElementById('sidebarContent'));
                    state.currentSession = null;
                    document.getElementById('sessionTitle').textContent = 'No Session Selected';
                    document.getElementById('closeSessionBtn').style.display = 'none';
                    document.getElementById('deleteSessionBtn').style.display = 'none';
                    document.getElementById('chatMessages').innerHTML = '<div class="message system">Session deleted.</div>';
                    showNotification('Session deleted', 'error');
                } catch(e) {
                    showNotification('Error deleting session', 'error');
                }
            }
        }

        function exportSession() {
            if (!state.currentSession) {
                showNotification('No session selected', 'error');
                return;
            }
            window.open(`/router/api/export/${state.currentSession.id}`, '_blank');
            showNotification('Session exported!');
        }

        function toggleGraph() {
            state.graphOpen = !state.graphOpen;
            document.getElementById('graphOverlay').classList.toggle('visible', state.graphOpen);
            if (state.graphOpen) {
                renderFullscreenGraph();
            }
        }

        async function renderFullscreenGraph() {
            const container = document.getElementById('fullscreenGraph');
            try {
                const graphData = await apiCall('/topology');
                container.innerHTML = generateTopologySVG(graphData);
            } catch(e) {
                container.innerHTML = '<div style="color: var(--danger);">Error loading topology</div>';
            }
        }

        function generateTopologySVG(data) {
            const width = 800;
            const height = 600;
            const nodes = data.nodes || [];
            const edges = data.edges || [];

            let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" style="background: rgba(10, 15, 30, 0.8); border-radius: 12px;">`;

            // Draw edges
            edges.forEach(edge => {
                const fromNode = nodes.find(n => n.id === edge.from);
                const toNode = nodes.find(n => n.id === edge.to);
                if (fromNode && toNode) {
                    svg += `<line x1="${fromNode.x || 100}" y1="${fromNode.y || 100}" 
                           x2="${toNode.x || 200}" y2="${toNode.y || 200}" 
                           stroke="rgba(0, 243, 255, 0.3)" stroke-width="2" />`;
                }
            });

            // Draw nodes
            nodes.forEach(node => {
                const x = node.x || 100;
                const y = node.y || 100;
                const r = node.type === 'user' ? 20 : node.type === 'router' ? 15 : 12;
                svg += `<g><circle cx="${x}" cy="${y}" r="${r}" fill="${node.color || '#7f52ff'}" fill-opacity="0.3" stroke="${node.color || '#7f52ff'}" stroke-width="2" />
                <text x="${x}" y="${y + r + 20}" text-anchor="middle" fill="#e0e0ff" font-size="10">${node.label}</text></g>`;
            });

            svg += `</svg>`;
            return svg;
        }

        function renderModels(container) {
            container.innerHTML = '';
            if (state.models.length === 0) {
                container.innerHTML = '<div class="no-sessions">No models configured.</div>';
                return;
            }
            state.models.forEach(model => {
                const div = document.createElement('div');
                div.className = `model-list-item ${model.active ? 'active' : ''}`;
                div.innerHTML = `
                    <div class="model-header">
                        <div>
                            <div class="model-name">${model.name}</div>
                            <div class="model-provider">${model.provider} • ${model.role}</div>
                        </div>
                        <span class="model-status ${model.active ? 'active' : 'offline'}"></span>
                    </div>
                    <div style="font-size:0.7rem;color:var(--text-muted);margin-top:6px">${model.endpoint.substring(0, 40)}...</div>`;
                container.appendChild(div);
            });
        }

        function renderTopology(container) {
            container.innerHTML = `
                <div style="margin-bottom:12px">
                    <button class="btn" onclick="toggleGraph()" style="width:100%">📊 View Full Graph</button>
                </div>
                <div style="height:160px;background:rgba(0,0,0,0.3);border-radius:8px;border:1px solid var(--border-color);padding:10px;overflow:hidden">
                    <div style="color:var(--text-secondary);font-size:0.8rem;padding:10px">
                        Nodes: ${state.sessions.length} sessions, ${state.models.length} models
                    </div>
                </div>`;
        }

        function renderSettings(container) {
            container.innerHTML = `
                <div class="form-group">
                    <label>Theme</label>
                    <select class="form-select" id="settingTheme" onchange="updateSetting('theme', this.value)">
                        <option value="neon">Neon Hacker</option>
                        <option value="dark">Dark Minimal</option>
                        <option value="matrix">Matrix</option>
                    </select>
                </div>
                <div class="toggle-switch">
                    <label>Sound Effects</label>
                    <label class="switch">
                        <input type="checkbox" id="settingSounds" onchange="updateSetting('sounds', this.checked)">
                        <span class="slider"></span>
                    </label>
                </div>
                <div class="toggle-switch">
                    <label>Auto Scroll</label>
                    <label class="switch">
                        <input type="checkbox" id="settingAutoScroll" onchange="updateSetting('autoScroll', this.checked)">
                        <span class="slider"></span>
                    </label>
                </div>
                <button class="btn" style="background:linear-gradient(135deg,var(--primary),var(--secondary));color:white;border:none">Save Settings</button>
            `;

            document.getElementById('settingTheme').value = localStorage.getItem('settings_theme') || 'neon';
            document.getElementById('settingSounds').checked = localStorage.getItem('settings_sounds') !== 'false';
            document.getElementById('settingAutoScroll').checked = localStorage.getItem('settings_autoScroll') !== 'false';
        }

        function updateSetting(key, value) {
            localStorage.setItem(`settings_${key}`, value);
        }

        window.addEventListener('load', init);
    </script>
</body>
</html>