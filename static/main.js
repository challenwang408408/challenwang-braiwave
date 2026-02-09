// Global state
let ws, audioContext, processor, source, stream;
let isRecording = false;
let isReplaying = false;
let isStopping = false; // Flag to allow final audio processing during stop
let timerInterval;
let startTime;
let audioBuffer = new Int16Array(0);
let wsConnected = false;
let streamInitialized = false;
let isAutoStarted = false;
let userGestureTimestamp = null; // 记录用户手势时间戳，用于移动端自动复制授权

// IndexedDB state
let db = null;
let currentSessionId = null;
let sessionStartTime = null;
let chunkSeq = 0;
let storageAvailable = false;

// DOM elements
const recordButton = document.getElementById('recordButton');
const replayButton = document.getElementById('replayButton');
const storageStatus = document.getElementById('storageStatus');
const transcript = document.getElementById('transcript');
const enhancedTranscript = document.getElementById('enhancedTranscript');
const copyButton = document.getElementById('copyButton');
const copyEnhancedButton = document.getElementById('copyEnhancedButton');
const mobileCopyBar = document.getElementById('mobileCopyBar');
const mobileCopyButton = document.getElementById('mobileCopyButton');
const readabilityButton = document.getElementById('readabilityButton');
const askAIButton = document.getElementById('askAIButton');
const correctnessButton = document.getElementById('correctnessButton');

// Configuration
const targetSeconds = 5;
const urlParams = new URLSearchParams(window.location.search);
const autoStart = urlParams.get('start') === '1';

// Utility functions
const isMobileDevice = () => /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

// Check if running in secure context (HTTPS or localhost)
const isSecureContext = () => {
    return window.isSecureContext || 
           window.location.protocol === 'https:' || 
           window.location.hostname === 'localhost' || 
           window.location.hostname === '127.0.0.1';
};

// Check microphone permission status
async function checkMicrophonePermission() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        return { available: false, reason: '浏览器不支持麦克风API' };
    }
    
    if (!isSecureContext()) {
        return { 
            available: false, 
            reason: 'PC端浏览器需要HTTPS才能访问麦克风。请使用HTTPS访问，或使用localhost',
            needsHttps: true 
        };
    }
    
    try {
        // Check permission status (if supported)
        if (navigator.permissions && navigator.permissions.query) {
            const result = await navigator.permissions.query({ name: 'microphone' });
            if (result.state === 'denied') {
                return { available: false, reason: '麦克风权限已被拒绝，请在浏览器设置中允许访问' };
            }
        }
        return { available: true };
    } catch (error) {
        // Permission API might not be supported, but that's okay
        return { available: true };
    }
}

// Notification system
function showNotification(message, type = 'info') {
    // Remove existing notifications
    const existing = document.querySelector('.notification');
    if (existing) {
        existing.remove();
    }

    const notification = document.createElement('div');
    notification.className = `notification notification-${type}`;
    notification.textContent = message;

    document.body.appendChild(notification);

    // Trigger animation
    requestAnimationFrame(() => {
        notification.classList.add('show');
    });

    // Auto-hide after 3 seconds
    setTimeout(() => {
        notification.classList.remove('show');
        setTimeout(() => {
            notification.remove();
        }, 300);
    }, 3000);
}

// Returns true on success, false on failure.
async function copyToClipboard(text, button) {
    if (!text) return false;

    // Modern Clipboard API
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
            showCopiedFeedback(button, '已复制!');
            return true;
        }
    } catch (err) {
        console.warn('Clipboard API copy failed:', err);
    }

    // Fallback for older browsers (may still be blocked on some mobile browsers)
    try {
        const textArea = document.createElement('textarea');
        textArea.value = text;
        textArea.style.position = 'fixed';
        textArea.style.opacity = '0';
        textArea.style.left = '-9999px';
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(textArea);

        if (ok) {
            showCopiedFeedback(button, '已复制!');
            return true;
        }
        return false;
    } catch (fallbackErr) {
        console.warn('Fallback copy failed:', fallbackErr);
        return false;
    }
}

function showCopiedFeedback(button, message) {
    if (!button) return;
    const originalText = button.textContent;
    button.classList.add('copied');
    button.textContent = message;
    setTimeout(() => {
        button.textContent = originalText;
        button.classList.remove('copied');
    }, 2000);
}

// Timer functions
function startTimer() {
    clearInterval(timerInterval);
    document.getElementById('timer').textContent = '00:00';
    startTime = Date.now();
    timerInterval = setInterval(() => {
        const elapsed = Date.now() - startTime;
        const minutes = Math.floor(elapsed / 60000);
        const seconds = Math.floor((elapsed % 60000) / 1000);
        document.getElementById('timer').textContent = 
            `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }, 1000);
}

function stopTimer() {
    clearInterval(timerInterval);
}

// IndexedDB initialization
async function initIndexedDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('brainwave-replay', 1);
        
        request.onerror = () => {
            console.warn('IndexedDB not available, replay disabled');
            storageAvailable = false;
            if (replayButton) {
                replayButton.disabled = true;
                replayButton.title = 'Local storage not available';
            }
            resolve(false);
        };
        
        request.onsuccess = () => {
            db = request.result;
            
            // Check if required object stores exist
            if (!db.objectStoreNames.contains('sessions') || !db.objectStoreNames.contains('chunks')) {
                // Close and delete the database, then reopen to trigger onupgradeneeded
                db.close();
                const deleteRequest = indexedDB.deleteDatabase('brainwave-replay');
                deleteRequest.onsuccess = () => {
                    // Reopen database - this will trigger onupgradeneeded
                    const reopenRequest = indexedDB.open('brainwave-replay', 1);
                    reopenRequest.onsuccess = () => {
                        db = reopenRequest.result;
                        storageAvailable = true;
                        if (replayButton) {
                            replayButton.disabled = false;
                        }
                        updateReplayButtonState();
                        resolve(true);
                    };
                    reopenRequest.onerror = () => {
                        console.warn('Failed to reopen IndexedDB after cleanup');
                        storageAvailable = false;
                        if (replayButton) {
                            replayButton.disabled = true;
                            replayButton.title = 'Local storage not available';
                        }
                        resolve(false);
                    };
                    reopenRequest.onupgradeneeded = (event) => {
                        const db = event.target.result;
                        // Create sessions store
                        if (!db.objectStoreNames.contains('sessions')) {
                            const sessionsStore = db.createObjectStore('sessions', { keyPath: 'id', autoIncrement: true });
                            sessionsStore.createIndex('status', 'status', { unique: false });
                            sessionsStore.createIndex('createdAt', 'createdAt', { unique: false });
                        }
                        // Create chunks store
                        if (!db.objectStoreNames.contains('chunks')) {
                            const chunksStore = db.createObjectStore('chunks', { keyPath: 'id', autoIncrement: true });
                            chunksStore.createIndex('sessionId', 'sessionId', { unique: false });
                            chunksStore.createIndex('seq', 'seq', { unique: false });
                        }
                    };
                };
                deleteRequest.onerror = () => {
                    console.warn('Failed to delete corrupted IndexedDB');
                    storageAvailable = false;
                    if (replayButton) {
                        replayButton.disabled = true;
                        replayButton.title = 'Local storage not available';
                    }
                    resolve(false);
                };
                return;
            }
            
            storageAvailable = true;
            if (replayButton) {
                replayButton.disabled = false;
            }
            updateReplayButtonState();
            resolve(true);
        };
        
        request.onupgradeneeded = (event) => {
            db = event.target.result;
            
            // Create sessions store
            if (!db.objectStoreNames.contains('sessions')) {
                const sessionsStore = db.createObjectStore('sessions', { keyPath: 'id', autoIncrement: true });
                sessionsStore.createIndex('status', 'status', { unique: false });
                sessionsStore.createIndex('createdAt', 'createdAt', { unique: false });
            }
            
            // Create chunks store
            if (!db.objectStoreNames.contains('chunks')) {
                const chunksStore = db.createObjectStore('chunks', { keyPath: 'id', autoIncrement: true });
                chunksStore.createIndex('sessionId', 'sessionId', { unique: false });
                chunksStore.createIndex('seq', 'seq', { unique: false });
            }
        };
    });
}

// Audio processing
function createAudioProcessor() {
    processor = audioContext.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = async (e) => {
        // Allow processing if recording OR if stopping (to capture final audio)
        if (!isRecording && !isStopping) return;
        
        const inputData = e.inputBuffer.getChannelData(0);
        const pcmData = new Int16Array(inputData.length);
        
        for (let i = 0; i < inputData.length; i++) {
            pcmData[i] = Math.max(-32768, Math.min(32767, Math.floor(inputData[i] * 32767)));
        }
        
        const combinedBuffer = new Int16Array(audioBuffer.length + pcmData.length);
        combinedBuffer.set(audioBuffer);
        combinedBuffer.set(pcmData, audioBuffer.length);
        audioBuffer = combinedBuffer;
        
        if (audioBuffer.length >= 24000) {
            const sendBuffer = audioBuffer.slice(0, 24000);
            audioBuffer = audioBuffer.slice(24000);
            
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(sendBuffer.buffer);
                
                // Store chunk in IndexedDB
                if (storageAvailable && currentSessionId && sessionStartTime) {
                    const deltaMs = performance.now() - sessionStartTime;
                    await appendChunk(currentSessionId, {
                        seq: chunkSeq++,
                        deltaMs: deltaMs,
                        kind: 'audio',
                        payload: sendBuffer.buffer,
                        byteLength: sendBuffer.byteLength
                    });
                }
            }
        }
    };
    return processor;
}

async function initAudio(stream) {
    audioContext = new AudioContext();
    source = audioContext.createMediaStreamSource(stream);
    processor = createAudioProcessor();
    source.connect(processor);
    processor.connect(audioContext.destination);
}

// WebSocket handling
function updateConnectionStatus(status) {
    const statusDot = document.getElementById('connectionStatus');
    statusDot.classList.remove('connected', 'connecting', 'idle');

    const statusMessages = {
        'connected': '已连接',
        'connecting': '连接中',
        'idle': '空闲',
        'disconnected': '未连接'
    };

    switch (status) {
        case 'connected':  // OpenAI is connected and ready
            statusDot.classList.add('connected');
            statusDot.setAttribute('data-status', statusMessages.connected);
            break;
        case 'connecting':  // Establishing OpenAI connection
            statusDot.classList.add('connecting');
            statusDot.setAttribute('data-status', statusMessages.connecting);
            break;
        case 'idle':  // Client connected, OpenAI not connected
            statusDot.classList.add('idle');
            statusDot.setAttribute('data-status', statusMessages.idle);
            break;
        default:  // Disconnected
            statusDot.setAttribute('data-status', statusMessages.disconnected);
    }
}

function initializeWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${protocol}://${window.location.host}/api/v1/ws`);
    
    ws.onopen = () => {
        wsConnected = true;
        // Set initial UI state to idle (blue) when socket opens
        updateConnectionStatus('idle');
        if (autoStart && !isRecording && !isAutoStarted) startRecording();
    };
    
    ws.onmessage = async (event) => {
        const data = JSON.parse(event.data);
        switch (data.type) {
            case 'status':
                updateConnectionStatus(data.status);
                // Stop timer when not actively recording/generating
                if (data.status === 'idle' || data.status === 'generating') {
                    stopTimer();
                }
                if (data.status === 'idle') {
                    if (transcript.value.trim()) {
                        // Auto-copy is reliable on desktop, but on many mobile browsers clipboard write
                        // requires a *direct* user gesture at the moment of copying (async callbacks don't count).
                        if (!isMobileDevice()) {
                            const ok = await copyToClipboard(transcript.value, copyButton);
                            if (ok) {
                                showNotification('转录完成!文本已自动复制', 'success');
                            } else {
                                showNotification('转录完成!自动复制失败，请点击复制按钮复制文本', 'success');
                            }
                        } else {
                            // 移动端：不做自动复制；改为弹出一个明显的“点一下复制”按钮（用户手势触发，稳定）
                            showNotification('转录完成!点一下复制即可写入剪贴板', 'success');
                            if (mobileCopyBar && mobileCopyButton) {
                                mobileCopyBar.classList.add('show');
                                mobileCopyBar.setAttribute('aria-hidden', 'false');
                            }
                        }
                    }
                    // Update replay button state when status becomes idle
                    updateReplayButtonState();
                }
                break;
            case 'text':
                if (data.isNewResponse) {
                    transcript.value = data.content;
                    stopTimer();
                } else {
                    transcript.value += data.content;
                }
                transcript.scrollTop = transcript.scrollHeight;
                break;
            case 'error':
                showNotification(data.content || '发生错误', 'error');
                updateConnectionStatus('idle');
                updateReplayButtonState();
                break;
        }
    };
    
    ws.onclose = () => {
        wsConnected = false;
        updateConnectionStatus(false);
        setTimeout(initializeWebSocket, 1000);
    };
}

// IndexedDB helpers
async function createSession() {
    if (!db) return null;
    
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['sessions'], 'readwrite');
        const store = transaction.objectStore('sessions');
        const session = {
            createdAt: new Date(),
            status: 'recording',
            sampleRate: 24000,
            channelCount: 1,
            durationMs: 0
        };
        
        const request = store.add(session);
        request.onsuccess = () => {
            currentSessionId = request.result;
            sessionStartTime = performance.now();
            chunkSeq = 0;
            
            // Store start event
            appendChunk(currentSessionId, {
                seq: 0,
                deltaMs: 0,
                kind: 'start',
                payload: null,
                byteLength: 0
            });
            
            resolve(currentSessionId);
        };
        request.onerror = () => reject(request.error);
    });
}

async function appendChunk(sessionId, chunk) {
    if (!db || !sessionId) return;
    
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['chunks'], 'readwrite');
        const store = transaction.objectStore('chunks');
        const chunkData = {
            sessionId: sessionId,
            seq: chunk.seq,
            deltaMs: chunk.deltaMs,
            kind: chunk.kind,
            payload: chunk.payload,
            byteLength: chunk.byteLength
        };
        
        const request = store.add(chunkData);
        request.onsuccess = () => resolve();
        request.onerror = () => {
            console.warn('Failed to store chunk:', request.error);
            resolve(); // Don't fail recording if storage fails
        };
    });
}

async function completeSession(sessionId, durationMs) {
    if (!db || !sessionId) return;
    
    return new Promise((resolve) => {
        const transaction = db.transaction(['sessions', 'chunks'], 'readwrite');
        const sessionsStore = transaction.objectStore('sessions');
        const chunksStore = transaction.objectStore('chunks');
        
        // Update session status
        const getRequest = sessionsStore.get(sessionId);
        getRequest.onsuccess = () => {
            const session = getRequest.result;
            session.status = 'completed';
            session.durationMs = durationMs;
            sessionsStore.put(session);
            
            // Store stop event
            chunksStore.add({
                sessionId: sessionId,
                seq: chunkSeq++,
                deltaMs: durationMs,
                kind: 'stop',
                payload: null,
                byteLength: 0
            });
            
            // Enforce quota
            enforceQuota({ maxSessions: 5, maxBytes: 100 * 1024 * 1024 });
            
            resolve();
        };
        getRequest.onerror = () => resolve();
    });
}

async function enforceQuota({ maxSessions, maxBytes }) {
    if (!db) return;
    
    const transaction = db.transaction(['sessions', 'chunks'], 'readwrite');
    const sessionsStore = transaction.objectStore('sessions');
    const chunksStore = transaction.objectStore('chunks');
    const index = sessionsStore.index('createdAt');
    
    const sessions = [];
    index.openCursor().onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor) {
            sessions.push(cursor.value);
            cursor.continue();
        } else {
            // Sort by creation time (oldest first)
            sessions.sort((a, b) => a.createdAt - b.createdAt);
            
            // Delete oldest sessions if over limit
            while (sessions.length > maxSessions) {
                const session = sessions.shift();
                deleteSession(session.id);
            }
        }
    };
}

async function deleteSession(sessionId) {
    if (!db) return;
    
    const transaction = db.transaction(['sessions', 'chunks'], 'readwrite');
    const sessionsStore = transaction.objectStore('sessions');
    const chunksStore = transaction.objectStore('chunks');
    const index = chunksStore.index('sessionId');
    
    // Delete all chunks for this session
    index.openKeyCursor(IDBKeyRange.only(sessionId)).onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor) {
            chunksStore.delete(cursor.primaryKey);
            cursor.continue();
        }
    };
    
    // Delete session
    sessionsStore.delete(sessionId);
}

async function getLatestCompletedSession() {
    if (!db) return null;
    
    return new Promise((resolve) => {
        const transaction = db.transaction(['sessions'], 'readonly');
        const store = transaction.objectStore('sessions');
        const index = store.index('status');
        const request = index.getAll('completed');
        
        request.onsuccess = () => {
            const sessions = request.result;
            if (sessions.length === 0) {
                resolve(null);
                return;
            }
            
            // Sort by creation time (newest first)
            sessions.sort((a, b) => b.createdAt - a.createdAt);
            resolve(sessions[0]);
        };
        request.onerror = () => resolve(null);
    });
}

async function getSessionChunks(sessionId) {
    if (!db || !sessionId) return [];
    
    return new Promise((resolve) => {
        const transaction = db.transaction(['chunks'], 'readonly');
        const store = transaction.objectStore('chunks');
        const index = store.index('sessionId');
        const request = index.getAll(sessionId);
        
        request.onsuccess = () => {
            const chunks = request.result;
            chunks.sort((a, b) => a.seq - b.seq);
            resolve(chunks);
        };
        request.onerror = () => resolve([]);
    });
}

// Recording control
async function startRecording() {
    if (isRecording || isReplaying) return;
    
    try {
        transcript.value = '';
        enhancedTranscript.value = '';

        // Hide mobile copy bar when starting a new recording
        if (mobileCopyBar) {
            mobileCopyBar.classList.remove('show');
            mobileCopyBar.setAttribute('aria-hidden', 'true');
        }

        // Check microphone availability and permissions first
        const permissionCheck = await checkMicrophonePermission();
        if (!permissionCheck.available) {
            showNotification(permissionCheck.reason, 'error');
            if (permissionCheck.needsHttps) {
                console.error('HTTPS required for microphone access on PC browsers');
            }
            return;
        }

        // Check if mediaDevices API is available
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            showNotification('您的浏览器不支持麦克风访问', 'error');
            return;
        }

        if (!streamInitialized) {
            try {
                stream = await navigator.mediaDevices.getUserMedia({ 
                    audio: {
                        channelCount: 1,
                        echoCancellation: true,
                        noiseSuppression: true,
                        autoGainControl: true,
                        sampleRate: 48000  // Explicitly request 48kHz
                    } 
                });
                streamInitialized = true;
            } catch (getUserMediaError) {
                console.error('getUserMedia error:', getUserMediaError);
                let errorMessage = '无法访问麦克风';
                
                if (getUserMediaError.name === 'NotAllowedError' || getUserMediaError.name === 'PermissionDeniedError') {
                    errorMessage = '麦克风权限被拒绝。请点击地址栏的锁图标，允许麦克风访问，然后刷新页面';
                } else if (getUserMediaError.name === 'NotFoundError' || getUserMediaError.name === 'DevicesNotFoundError') {
                    errorMessage = '未检测到麦克风设备。请检查设备连接';
                } else if (getUserMediaError.name === 'NotReadableError' || getUserMediaError.name === 'TrackStartError') {
                    errorMessage = '麦克风被其他应用占用。请关闭其他使用麦克风的程序';
                } else if (getUserMediaError.name === 'OverconstrainedError' || getUserMediaError.name === 'ConstraintNotSatisfiedError') {
                    errorMessage = '无法满足音频约束要求。尝试使用其他音频设备';
                } else if (getUserMediaError.name === 'SecurityError') {
                    errorMessage = '安全错误：PC端浏览器需要HTTPS才能访问麦克风';
                } else {
                    errorMessage = `无法访问麦克风: ${getUserMediaError.message || getUserMediaError.name}`;
                }
                
                showNotification(errorMessage, 'error');
                throw getUserMediaError;
            }
        }

        if (!stream) {
            throw new Error('音频流初始化失败');
        }
        
        if (!audioContext) {
            await initAudio(stream);
        }

        isRecording = true;
        const modelSelect = document.getElementById('modelSelect');
        const selectedModel = modelSelect ? modelSelect.value : 'gpt-realtime-mini-2025-12-15';
        
        // Create session in IndexedDB
        if (storageAvailable) {
            await createSession();
        }
        
        await ws.send(JSON.stringify({ type: 'start_recording', model: selectedModel }));
        
        startTimer();
        recordButton.querySelector('.button-text').textContent = '停止';
        recordButton.classList.add('recording');
        if (replayButton) replayButton.disabled = true;

        // Visual feedback
        showNotification('录音已开始', 'success');
        
    } catch (error) {
        console.error('Error starting recording:', error);
        // Error messages are already handled above
        if (!error.message || !error.message.includes('无法访问')) {
            showNotification('启动录音失败，请重试', 'error');
        }
    }
}

async function stopRecording() {
    if (!isRecording) return;
    
    // 记录用户手势时间戳（用于移动端自动复制授权）
    // 用户手势通常在5秒内有效，足够转录完成
    userGestureTimestamp = Date.now();
    
    // Set stopping flag first to allow final audio processing
    isStopping = true;
    isRecording = false;
    const durationMs = performance.now() - sessionStartTime;
    
    // Stop local timer immediately on stop
    stopTimer();
    
    // Wait a bit to allow any in-flight onaudioprocess callbacks to complete
    // This ensures we capture the last bit of audio data
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Send any remaining audio buffer
    if (audioBuffer.length > 0 && ws.readyState === WebSocket.OPEN) {
        const sendBuffer = audioBuffer.slice();
        ws.send(sendBuffer.buffer);
        
        // Store final chunk
        if (storageAvailable && currentSessionId && sessionStartTime) {
            const deltaMs = performance.now() - sessionStartTime;
            await appendChunk(currentSessionId, {
                seq: chunkSeq++,
                deltaMs: deltaMs,
                kind: 'audio',
                payload: sendBuffer.buffer,
                byteLength: sendBuffer.byteLength
            });
        }
        
        audioBuffer = new Int16Array(0);
    }
    
    // Clear stopping flag
    isStopping = false;
    
    // Wait a bit more to ensure all audio is sent before stopping
    await new Promise(resolve => setTimeout(resolve, 500));
    await ws.send(JSON.stringify({ type: 'stop_recording' }));
    
    // Complete session in IndexedDB
    if (storageAvailable && currentSessionId) {
        await completeSession(currentSessionId, durationMs);
        currentSessionId = null;
        sessionStartTime = null;
        chunkSeq = 0;
    }
    
    recordButton.querySelector('.button-text').textContent = '开始';
    recordButton.classList.remove('recording');
    updateReplayButtonState();

    // Visual feedback
    showNotification('录音已停止,正在处理...', 'info');
}

// Replay functionality
async function replayLastRecording() {
    if (isRecording || isReplaying || !storageAvailable) return;
    
    const session = await getLatestCompletedSession();
    if (!session) {
        showNotification('没有找到可重放的录音', 'warning');
        return;
    }

    if (isRecording) {
        showNotification('请先停止录音再重放', 'warning');
        return;
    }
    
    isReplaying = true;
    recordButton.disabled = true;
    if (replayButton) {
        replayButton.disabled = true;
        replayButton.title = '重放中...';
        replayButton.style.animation = 'spin 1s linear infinite';
    }

    showNotification('开始重放录音...', 'info');
    
    try {
        // Get chunks for this session
        const chunks = await getSessionChunks(session.id);
        if (chunks.length === 0) {
            throw new Error('No chunks found for session');
        }
        
        // Clear transcript
        transcript.value = '';
        enhancedTranscript.value = '';
        
        // Ensure WebSocket is connected
        if (!wsConnected || ws.readyState !== WebSocket.OPEN) {
            await new Promise((resolve) => {
                const checkConnection = setInterval(() => {
                    if (wsConnected && ws.readyState === WebSocket.OPEN) {
                        clearInterval(checkConnection);
                        resolve();
                    }
                }, 100);
            });
        }
        
        // Send start_recording message
        const modelSelect = document.getElementById('modelSelect');
        const selectedModel = modelSelect ? modelSelect.value : 'gpt-realtime-mini-2025-12-15';
        await ws.send(JSON.stringify({ type: 'start_recording', model: selectedModel }));
        
        // Wait a bit for backend to initialize
        await new Promise(resolve => setTimeout(resolve, 200));
        
        // Replay audio chunks - send as fast as possible
        const audioChunks = chunks.filter(c => c.kind === 'audio' && c.payload);
        
        // Send all audio chunks immediately
        for (const chunk of audioChunks) {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(chunk.payload);
            } else {
                throw new Error('WebSocket closed during replay');
            }
        }
        
        // Send stop_recording after all audio chunks
        await ws.send(JSON.stringify({ type: 'stop_recording' }));
        
    } catch (error) {
        console.error('Error replaying recording:', error);
        showNotification('重放失败: ' + error.message, 'error');
    } finally {
        isReplaying = false;
        recordButton.disabled = false;
        updateReplayButtonState();
    }
}

function updateReplayButtonState() {
    if (!replayButton) return;
    
    if (!storageAvailable) {
        replayButton.disabled = true;
        replayButton.title = 'Local storage not available';
        return;
    }
    
    if (isRecording || isReplaying) {
        replayButton.disabled = true;
        if (isReplaying) {
            replayButton.title = 'Replaying...';
            replayButton.style.animation = 'spin 1s linear infinite';
        } else {
            replayButton.title = 'Recording in progress';
            replayButton.style.animation = '';
        }
        return;
    }
    
    // Check if there's a completed session
    getLatestCompletedSession().then(session => {
        if (session) {
            replayButton.disabled = false;
            replayButton.title = 'Replay last recording';
            replayButton.style.animation = '';
        } else {
            replayButton.disabled = true;
            replayButton.title = 'No recording to replay';
            replayButton.style.animation = '';
        }
    });
}

// Event listeners
recordButton.onclick = () => isRecording ? stopRecording() : startRecording();
if (replayButton) replayButton.onclick = replayLastRecording;
copyButton.onclick = async () => {
    const ok = await copyToClipboard(transcript.value, copyButton);
    if (!ok) showNotification('复制失败：请长按文本框选择复制', 'warning');
};
copyEnhancedButton.onclick = async () => {
    const ok = await copyToClipboard(enhancedTranscript.value, copyEnhancedButton);
    if (!ok) showNotification('复制失败：请长按文本框选择复制', 'warning');
};

// Mobile prominent copy button (user gesture)
if (mobileCopyButton) {
    mobileCopyButton.onclick = async () => {
        const ok = await copyToClipboard(transcript.value, copyButton || mobileCopyButton);
        if (ok) {
            showNotification('已复制到剪贴板', 'success');
            if (mobileCopyBar) {
                mobileCopyBar.classList.remove('show');
                mobileCopyBar.setAttribute('aria-hidden', 'true');
            }
            userGestureTimestamp = null;
        } else {
            showNotification('复制失败：请点击右上角复制，或长按文本框复制', 'warning');
        }
    };
}


// Handle spacebar toggle
document.addEventListener('keydown', (event) => {
    if (event.code === 'Space') {
        const activeElement = document.activeElement;
        if (!activeElement.tagName.match(/INPUT|TEXTAREA/) && !activeElement.isContentEditable) {
            event.preventDefault();
            recordButton.click();
        }
    }
});

// Add visual feedback for button presses
function addButtonPressEffect(button) {
    button.addEventListener('mousedown', () => {
        button.style.transform = 'scale(0.97)';
    });

    button.addEventListener('mouseup', () => {
        button.style.transform = '';
    });

    button.addEventListener('mouseleave', () => {
        button.style.transform = '';
    });
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', async () => {
    await initIndexedDB();
    initializeWebSocket();
    initializeTheme();

    // Add press effects to buttons
    [recordButton, replayButton, readabilityButton, correctnessButton, copyButton, copyEnhancedButton]
        .filter(btn => btn)
        .forEach(addButtonPressEffect);

    // Check microphone availability on page load
    const permissionCheck = await checkMicrophonePermission();
    if (!permissionCheck.available) {
        // Show warning but don't block the UI
        setTimeout(() => {
            showNotification(permissionCheck.reason, 'warning');
        }, 1000);
    }

    // Show a welcome notification
    setTimeout(() => {
        if (!isRecording && !isAutoStarted) {
            if (permissionCheck.available) {
                showNotification('准备就绪,点击开始按钮或按空格键开始录音', 'info');
            }
        }
    }, 500);
});
// Readability and AI handlers
if (readabilityButton) readabilityButton.onclick = async () => {
    startTimer();
    const inputText = transcript.value.trim();
    if (!inputText) {
        showNotification('请先输入文本再进行优化', 'warning');
        stopTimer();
        return;
    }

    readabilityButton.classList.add('loading');
    readabilityButton.disabled = true;

    try {
        const response = await fetch('/api/v1/readability', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: inputText })
        });

        if (!response.ok) throw new Error('Readability enhancement failed');

        // Some mobile browsers (notably older iOS Safari / in-app browsers) don't support
        // streaming responses (response.body may be null). Fall back to response.text().
        let fullText = '';
        enhancedTranscript.value = '';

        if (!response.body || !response.body.getReader) {
            fullText = await response.text();
            enhancedTranscript.value = fullText;
        } else {
            const reader = response.body.getReader();
            const decoder = new TextDecoder();

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                fullText += decoder.decode(value, { stream: true });
                enhancedTranscript.value = fullText;
                enhancedTranscript.scrollTop = enhancedTranscript.scrollHeight;
            }
        }

        if (!isMobileDevice()) copyToClipboard(fullText, copyEnhancedButton);
        stopTimer();

    } catch (error) {
        console.error('Error:', error);
        showNotification('优化失败,请重试', 'error');
        stopTimer();
    } finally {
        readabilityButton.classList.remove('loading');
        readabilityButton.disabled = false;
    }
};

if (askAIButton) askAIButton.onclick = async () => {
    startTimer();
    const inputText = transcript.value.trim();
    if (!inputText) {
        showNotification('请先输入文本再进行提问', 'warning');
        stopTimer();
        return;
    }

    askAIButton.classList.add('loading');
    askAIButton.disabled = true;

    try {
        const response = await fetch('/api/v1/ask_ai', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: inputText })
        });

        if (!response.ok) throw new Error('AI request failed');

        const result = await response.json();
        enhancedTranscript.value = result.answer;
        if (!isMobileDevice()) copyToClipboard(result.answer, copyEnhancedButton);
        stopTimer();

    } catch (error) {
        console.error('Error:', error);
        showNotification('AI 请求失败,请重试', 'error');
        stopTimer();
    } finally {
        askAIButton.classList.remove('loading');
        askAIButton.disabled = false;
    }
};

if (correctnessButton) correctnessButton.onclick = async () => {
    startTimer();
    const inputText = transcript.value.trim();
    if (!inputText) {
        showNotification('请先输入文本再进行检查', 'warning');
        stopTimer();
        return;
    }

    correctnessButton.classList.add('loading');
    correctnessButton.disabled = true;

    try {
        const response = await fetch('/api/v1/correctness', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: inputText })
        });

        if (!response.ok) throw new Error('Correctness check failed');

        // Some mobile browsers (notably older iOS Safari / in-app browsers) don't support
        // streaming responses (response.body may be null). Fall back to response.text().
        let fullText = '';
        enhancedTranscript.value = '';

        if (!response.body || !response.body.getReader) {
            fullText = await response.text();
            enhancedTranscript.value = fullText;
        } else {
            const reader = response.body.getReader();
            const decoder = new TextDecoder();

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                fullText += decoder.decode(value, { stream: true });
                enhancedTranscript.value = fullText;
                enhancedTranscript.scrollTop = enhancedTranscript.scrollHeight;
            }
        }

        if (!isMobileDevice()) copyToClipboard(fullText, copyEnhancedButton);
        stopTimer();

    } catch (error) {
        console.error('Error:', error);
        showNotification('检查失败,请重试', 'error');
        stopTimer();
    } finally {
        correctnessButton.classList.remove('loading');
        correctnessButton.disabled = false;
    }
};

// Theme handling
function toggleTheme() {
    const body = document.body;
    const themeToggle = document.getElementById('themeToggle');
    const isDarkTheme = body.classList.toggle('dark-theme');
    
    // Update button text
    themeToggle.textContent = isDarkTheme ? '☀️' : '🌙';
    
    // Save preference to localStorage
    localStorage.setItem('darkTheme', isDarkTheme);
}

// Initialize theme from saved preference
function initializeTheme() {
    const darkTheme = localStorage.getItem('darkTheme') === 'true';
    const themeToggle = document.getElementById('themeToggle');
    
    if (darkTheme) {
        document.body.classList.add('dark-theme');
        themeToggle.textContent = '☀️';
    }
}

// Add to your existing event listeners
document.getElementById('themeToggle').onclick = toggleTheme;
