// client-app.js (phiên bản: Frontend gọi Backend -> Backend ghi Firebase -> ESP32 đọc)
// Firebase v12 - Database functions are imported in HTML
// Wait for Firebase to be initialized
let database, ref, onValue, set, get;

// ---------------------------- CONFIG ----------------------------
// Thay bằng URL backend của bạn (ví dụ 'https://api.example.com' hoặc '' nếu cùng origin)
const BACKEND_BASE = 'http://localhost:3000'; // <-- cấu hình tại đây, ví dụ 'http://localhost:3000'

// Mặc định frontend sẽ lấy token JWT từ localStorage key 'access_token'
// Nếu bạn dùng cách khác (cookie, session), cập nhật hàm getAuthToken()
function getAuthToken() {
    try {
        return localStorage.getItem('access_token'); // hoặc null nếu chưa login
    } catch (e) {
        console.warn('Không thể đọc token từ localStorage', e);
        return null;
    }
}
// ----------------------------------------------------------------

// Wait for Firebase to be ready
function waitForFirebase() {
    return new Promise((resolve) => {
        const checkFirebase = () => {
            if (window.database && window.ref && window.onValue && window.set && window.get) {
                database = window.database;
                ref = window.ref;
                onValue = window.onValue;
                set = window.set;
                get = window.get;
                console.log('✅ Firebase v12 đã sẵn sàng');
                resolve();
            } else {
                setTimeout(checkFirebase, 100);
            }
        };
        checkFirebase();
    });
}

// Global variables
let isConnected = false;
let currentLockerStatus = 'closed';
let lastUpdateTime = null;

// DOM elements
const connectionStatus = document.getElementById('connectionStatus');
const connectionText = document.getElementById('connectionText');
const lockerStatus = document.getElementById('lockerStatus');
const lastUpdate = document.getElementById('lastUpdate');
const wifiStatus = document.getElementById('wifiStatus');
const activityList = document.getElementById('activityList');
const openBtn = document.getElementById('openBtn');
const closeBtn = document.getElementById('closeBtn');

// Initialize the app
document.addEventListener('DOMContentLoaded', async function() {
    console.log('🚀 Hệ thống tủ khóa đã khởi động');
    
    // Add initial activity log
    addActivityLog('Hệ thống khởi động', 'system');
    
    // Hook button events (buttons call controlLocker, which now calls backend)
    if (openBtn) openBtn.addEventListener('click', () => { if (!openBtn.disabled) controlLocker('open'); });
    if (closeBtn) closeBtn.addEventListener('click', () => { if (!closeBtn.disabled) controlLocker('close'); });

    // Wait for Firebase to be ready
    await waitForFirebase();
    
    // Start listening to Firebase (read-only)
    startFirebaseListener();
    
    // Update time every second
    setInterval(updateTime, 1000);
    
    // Check connection status
    setInterval(checkConnectionStatus, 5000);
});

// Firebase listener (chỉ đọc, giữ nguyên)
function startFirebaseListener() {
    console.log('📡 Bắt đầu lắng nghe Firebase...');
    
    try {
        // Listen to locker status changes (node /Locker1 holds status + metadata)
        const lockerRef = ref(database, '/Locker1');
        
        onValue(lockerRef, (snapshot) => {
            const data = snapshot.val();
            console.log('📨 Nhận dữ liệu từ Firebase:', data);
            if (data) {
                updateLockerStatus(data);
                isConnected = true;
                updateConnectionStatus(true);
                addActivityLog('Kết nối Firebase thành công', 'success');
            } else {
                console.log('⚠️ Không có dữ liệu từ Firebase');
                addActivityLog('Không có dữ liệu từ Firebase', 'error');
            }
        }, (error) => {
            console.error('❌ Lỗi Firebase:', error);
            isConnected = false;
            updateConnectionStatus(false);
            addActivityLog('Lỗi kết nối Firebase: ' + (error.message || error), 'error');
        });
        
        // Test connection
        const connectedRef = ref(database, '.info/connected');
        onValue(connectedRef, (snapshot) => {
            const connected = snapshot.val();
            console.log('🔗 Trạng thái kết nối Firebase:', connected);
            if (connected) {
                addActivityLog('Firebase đã kết nối', 'success');
            } else {
                addActivityLog('Firebase mất kết nối', 'error');
            }
        });
        
        // Listen to status changes specifically (optional: show when a new command appears)
        const statusRef = ref(database, '/Locker1/status');
        onValue(statusRef, (snapshot) => {
            const status = snapshot.val();
            if (status && status !== currentLockerStatus) {
                console.log('📨 Nhận lệnh mới:', status);
                addActivityLog(`Nhận lệnh: ${status}`, 'command');
            }
        });
        
    } catch (error) {
        console.error('❌ Lỗi khởi tạo listener:', error);
        addActivityLog('Lỗi khởi tạo listener: ' + error.message, 'error');
    }
}

// Update locker status display
function updateLockerStatus(data) {
    const currentStatus = data.current_status || data.status || 'closed';
    const lastUpdateVal = data.last_update || data.updatedAt || Date.now();
    
    currentLockerStatus = currentStatus;
    lastUpdateTime = new Date(parseInt(lastUpdateVal));
    
    // Update status display
    const statusElement = lockerStatus.querySelector('.status-text');
    const statusIcon = lockerStatus.querySelector('.status-icon');
    
    lockerStatus.className = 'locker-status ' + currentStatus;
    
    switch(currentStatus) {
        case 'open':
            statusElement.textContent = 'Mở';
            statusIcon.textContent = '🔓';
            break;
        case 'closed':
            statusElement.textContent = 'Đóng';
            statusIcon.textContent = '🔒';
            break;
        case 'opening':
            statusElement.textContent = 'Đang mở...';
            statusIcon.textContent = '🔄';
            break;
        case 'closing':
            statusElement.textContent = 'Đang đóng...';
            statusIcon.textContent = '🔄';
            break;
        case 'reserved':
            statusElement.textContent = 'Đã đặt trước';
            statusIcon.textContent = '📦';
            break;
        default:
            statusElement.textContent = currentStatus;
            statusIcon.textContent = 'ℹ️';
    }
    
    // Update buttons
    updateButtonStates(currentStatus);
    
    // Update last update time
    updateLastUpdateTime();
}

// Update button states
function updateButtonStates(status) {
    if (status === 'opening' || status === 'closing') {
        openBtn.disabled = true;
        closeBtn.disabled = true;
    } else {
        openBtn.disabled = false;
        closeBtn.disabled = false;
    }
}

// ---------------- IMPORTANT: sendCommandViaBackend ----------------
// Frontend không ghi trực tiếp lên Firebase nữa.
// Gọi backend API: POST /api/command  { lockerId, action }
// Header: Authorization: Bearer <token> (nếu có)
async function sendCommandViaBackend(lockerId = 'Locker1', action = 'open') {
    console.log(`🎮 Gọi backend gửi lệnh: ${action} cho ${lockerId}`);
    
    // UI loading
    if (action === 'open') {
        openBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Đang gửi...';
        openBtn.disabled = true;
    } else {
        closeBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Đang gửi...';
        closeBtn.disabled = true;
    }

    const token = getAuthToken();
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    try {
        const res = await fetch(`${BACKEND_BASE}/api/command`, {
            method: 'POST',
            headers,
            credentials: 'include', // nếu backend dùng cookie/session; tùy cấu hình
            body: JSON.stringify({ lockerId, action })
        });

        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            const msg = data.error || data.message || `HTTP ${res.status}`;
            throw new Error(msg);
        }

        addActivityLog(`Yêu cầu lệnh gửi tới backend: ${action}`, 'user');
        console.log('↪ Backend response:', data);

        // Backend sẽ, nếu hợp lệ, ghi lệnh vào Firebase (Commands/..., hoặc /Locker1/status)
        // Client sẽ thấy cập nhật qua Firebase listener.

    } catch (error) {
        console.error('❌ Lỗi gọi backend:', error);
        addActivityLog('Lỗi gọi backend: ' + (error.message || error), 'error');
        alert('Không thể gửi lệnh đến server: ' + (error.message || error));
    } finally {
        resetButtons();
    }
}

// Control locker function (thay vì ghi trực tiếp vào Firebase, gọi backend)
function controlLocker(action) {
    console.log(`🎮 Yêu cầu điều khiển tủ: ${action}`);
    
    // Optional: user confirmation for sensitive actions
    // if (!confirm(`Bạn có chắc muốn ${action} tủ?`)) return;

    // Show processing state immediately
    if (action === 'open') {
        openBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Đang xử lý...';
        openBtn.disabled = true;
    } else {
        closeBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Đang xử lý...';
        closeBtn.disabled = true;
    }

    // Call backend to perform the command
    sendCommandViaBackend('Locker1', action);
}

// Reset buttons
function resetButtons() {
    openBtn.innerHTML = '<i class="fas fa-unlock"></i> Mở Tủ';
    closeBtn.innerHTML = '<i class="fas fa-lock"></i> Đóng Tủ';
    openBtn.disabled = false;
    closeBtn.disabled = false;
}

// Update connection status
function updateConnectionStatus(connected) {
    if (connected) {
        connectionStatus.className = 'status-dot online';
        connectionText.textContent = 'Đã kết nối';
        wifiStatus.textContent = 'Kết nối tốt';
        wifiStatus.style.color = '#2f855a';
    } else {
        connectionStatus.className = 'status-dot offline';
        connectionText.textContent = 'Mất kết nối';
        wifiStatus.textContent = 'Mất kết nối';
        wifiStatus.style.color = '#c53030';
    }
}

// Check connection status
function checkConnectionStatus() {
    const connected = navigator.onLine && isConnected;
    updateConnectionStatus(connected);
}

// Add activity log
function addActivityLog(message, type = 'info') {
    const now = new Date();
    const timeString = now.toLocaleTimeString('vi-VN');
    
    const activityItem = document.createElement('div');
    activityItem.className = 'activity-item';
    
    const icon = getActivityIcon(type);
    activityItem.innerHTML = `
        <span class="time">${timeString}</span>
        <span class="action">${icon} ${message}</span>
    `;
    
    // Add to top of list
    activityList.insertBefore(activityItem, activityList.firstChild);
    
    // Keep only last 20 items
    while (activityList.children.length > 20) {
        activityList.removeChild(activityList.lastChild);
    }
}

// Get activity icon
function getActivityIcon(type) {
    switch(type) {
        case 'user': return '👤';
        case 'command': return '📨';
        case 'system': return '⚙️';
        case 'error': return '❌';
        case 'success': return '✅';
        default: return 'ℹ️';
    }
}

// Update time display
function updateTime() {
    if (lastUpdateTime) {
        const now = new Date();
        const diff = Math.floor((now - lastUpdateTime) / 1000);
        
        if (diff < 60) {
            lastUpdate.textContent = `${diff}s trước`;
        } else if (diff < 3600) {
            lastUpdate.textContent = `${Math.floor(diff / 60)}m trước`;
        } else {
            lastUpdate.textContent = lastUpdateTime.toLocaleTimeString('vi-VN');
        }
    }
}

// Update last update time
function updateLastUpdateTime() {
    if (lastUpdateTime) {
        lastUpdate.textContent = lastUpdateTime.toLocaleTimeString('vi-VN');
    }
}

// Handle online/offline events
window.addEventListener('online', () => {
    console.log('🌐 Kết nối internet đã được khôi phục');
    addActivityLog('Kết nối internet đã được khôi phục', 'success');
});

window.addEventListener('offline', () => {
    console.log('🌐 Mất kết nối internet');
    addActivityLog('Mất kết nối internet', 'error');
    updateConnectionStatus(false);
});

// Settings functions (safely guard DOM access)
const autoCloseEl = document.getElementById('autoCloseTime');
if (autoCloseEl) {
    autoCloseEl.addEventListener('change', function() {
        const value = this.value;
        console.log(`⚙️ Thời gian tự đóng: ${value}s`);
        addActivityLog(`Cập nhật thời gian tự đóng: ${value}s`, 'system');
    });
}
const checkIntervalEl = document.getElementById('checkInterval');
if (checkIntervalEl) {
    checkIntervalEl.addEventListener('change', function() {
        const value = this.value;
        console.log(`⚙️ Tần suất kiểm tra: ${value}s`);
        addActivityLog(`Cập nhật tần suất kiểm tra: ${value}s`, 'system');
    });
}

// Keyboard shortcuts
document.addEventListener('keydown', function(event) {
    if (event.ctrlKey || event.metaKey) {
        switch(event.key) {
            case 'o':
                event.preventDefault();
                if (!openBtn.disabled) controlLocker('open');
                break;
            case 'c':
                event.preventDefault();
                if (!closeBtn.disabled) controlLocker('close');
                break;
        }
    }
});

// Add keyboard shortcut info
addActivityLog('Phím tắt: Ctrl+O (Mở), Ctrl+C (Đóng)', 'system');

// Debug function (GHI lên /debug — VẪN CÒN, nhưng KHÔNG dùng để gửi lệnh nhạy cảm)
function debugFirebase() {
    console.log('🔍 Debug Firebase...');
    console.log('Database:', database);
    console.log('Ref function:', ref);
    console.log('Set function:', set);
    console.log('OnValue function:', onValue);
    
    // Test simple write (chỉ debug non-sensitive node)
    try {
        const debugRef = ref(database, '/debug');
        set(debugRef, { 
            test: true, 
            time: Date.now(),
            message: 'Debug test from web'
        })
        .then(() => {
            console.log('✅ Debug write OK');
            addActivityLog('Debug write thành công', 'success');
        })
        .catch(err => {
            console.error('❌ Debug write failed:', err);
            addActivityLog('Debug write thất bại: ' + err.message, 'error');
        });
    } catch (error) {
        console.error('❌ Debug error:', error);
        addActivityLog('Debug error: ' + error.message, 'error');
    }
}

// Chạy debug sau 3 giây
setTimeout(debugFirebase, 3000);
