// Authentication Management for Smart Locker System
class AuthManager {
    constructor() {
        this.baseURL = '/api';
        // Không giữ token nữa, chỉ giữ thông tin hiển thị
        this.phoneNumber = localStorage.getItem('phoneNumber');
        this.role = localStorage.getItem('role') || 'resident';
    }

    // Gửi OTP tới số điện thoại
    async sendOTP(phoneNumber) {
        try {
            const response = await fetch(`${this.baseURL}/auth/send-otp`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                // cookie chưa cần ở bước này, nhưng để cho thống nhất vẫn có thể dùng credentials
                credentials: 'include',
                body: JSON.stringify({ phoneNumber })
            });

            const data = await response.json();
            
            if (data.success) {
                return {
                    success: true,
                    verificationId: data.verificationId,
                    message: data.message
                };
            } else {
                throw new Error(data.error || 'Failed to send OTP');
            }
        } catch (error) {
            console.error('Error sending OTP:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    // Verify OTP (đăng nhập)
    async verifyOTP(verificationId, otpCode) {
        try {
            const response = await fetch(`${this.baseURL}/auth/verify-otp`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                credentials: 'include', // để browser gửi/nhận cookie
                body: JSON.stringify({ verificationId, otpCode })
            });

            const data = await response.json();
            
            if (data.success) {
                // backend đã set cookie authToken rồi
                // ở đây chỉ cần lưu phone + role để UI dùng
                this.setSession(data.phoneNumber, data.role);

                return {
                    success: true,
                    phoneNumber: data.phoneNumber,
                    role: data.role,
                    user: data.user
                };
            } else {
                throw new Error(data.error || 'Failed to verify OTP');
            }
        } catch (error) {
            console.error('Error verifying OTP:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    // Đăng ký user mới
    async registerUser(phoneNumber, fullName, apartment, verificationId, otpCode) {
        try {
            const response = await fetch(`${this.baseURL}/auth/register`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                credentials: 'include',
                body: JSON.stringify({ phoneNumber, fullName, apartment, verificationId, otpCode })
            });

            const data = await response.json();
            
            if (data.success) {
                // backend cũng set cookie authToken sau khi đăng ký
                this.setSession(data.user.phoneNumber, data.user.role);

                return {
                    success: true,
                    user: data.user
                };
            } else {
                throw new Error(data.error || 'Failed to register user');
            }
        } catch (error) {
            console.error('Error registering user:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    // Lưu session (chỉ phone + role, KHÔNG lưu token nữa)
    setSession(phoneNumber, role = 'resident') {
        this.phoneNumber = phoneNumber;
        this.role = role;
        localStorage.setItem('phoneNumber', phoneNumber);
        localStorage.setItem('role', role);
    }

    // Kiểm tra đã đăng nhập chưa (dựa trên phoneNumber lưu lại)
    isAuthenticated() {
        this.phoneNumber = localStorage.getItem('phoneNumber');
        this.role = localStorage.getItem('role') || 'resident';
        return !!this.phoneNumber;
    }

    // Trước dùng để gửi Authorization header, giờ bỏ token nên chỉ cần Content-Type
    getAuthHeaders() {
        return {
            'Content-Type': 'application/json'
        };
    }

    // Đăng xuất
    async logout() {
        // Option: nếu em có thêm endpoint /api/auth/logout để clear cookie, gọi ở đây:
        try {
            await fetch(`${this.baseURL}/auth/logout`, {
                method: 'POST',
                credentials: 'include'
            });
        } catch (e) {
            console.warn('Logout API error (có thể chưa implement):', e);
        }

        this.phoneNumber = null;
        this.role = null;
        localStorage.removeItem('phoneNumber');
        localStorage.removeItem('role');

        // Trang login là index.html
        window.location.href = '/index.html';
    }

    // Bắt buộc phải đăng nhập, không thì đá về index
    requireAuth() {
        if (!this.isAuthenticated()) {
            window.location.href = '/index.html';
            return false;
        }
        return true;
    }

    // Format SĐT cho đẹp
    formatPhoneNumber(phoneNumber) {
        if (!phoneNumber) return '';
        
        if (phoneNumber.startsWith('+84')) {
            return '0' + phoneNumber.substring(3);
        } else if (phoneNumber.startsWith('84')) {
            return '0' + phoneNumber.substring(2);
        }
        return phoneNumber;
    }

    // Validate SĐT
    validatePhoneNumber(phoneNumber) {
        const phoneRegex = /^(\+84|84|0)[0-9]{9}$/;
        return phoneRegex.test(phoneNumber);
    }

    // Chuẩn hoá SĐT về +84
    normalizePhoneNumber(phoneNumber) {
        if (phoneNumber.startsWith('+84')) {
            return phoneNumber;
        } else if (phoneNumber.startsWith('84')) {
            return '+' + phoneNumber;
        } else if (phoneNumber.startsWith('0')) {
            return '+84' + phoneNumber.substring(1);
        }
        return phoneNumber;
    }
}

// Tạo instance global
const authManager = new AuthManager();

        // Đọc token & phone từ localStorage (dùng key 'token')


// Utility functions for UI
function showMessage(message, type = 'info') {
    const messageDiv = document.getElementById('message');
    if (messageDiv) {
        messageDiv.innerHTML = message;
        messageDiv.className = `message message-${type}`;
        messageDiv.style.display = 'block';
        
        // Auto hide after 5 seconds
        setTimeout(() => {
            messageDiv.style.display = 'none';
        }, 5000);
    }
}

function showLoading(show = true) {
    const loadingDiv = document.getElementById('loading');
    if (loadingDiv) {
        loadingDiv.style.display = show ? 'block' : 'none';
    }
}

function disableForm(disable = true) {
    const inputs = document.querySelectorAll('input, button');
    inputs.forEach(input => {
        input.disabled = disable;
    });
}

// Countdown timer for OTP resend
function startCountdown(seconds, buttonId) {
    const button = document.getElementById(buttonId);
    if (!button) return;

    let remaining = seconds;
    button.disabled = true;
    button.textContent = `Gửi lại sau ${remaining}s`;

    const interval = setInterval(() => {
        remaining--;
        button.textContent = `Gửi lại sau ${remaining}s`;
        
        if (remaining <= 0) {
            clearInterval(interval);
            button.disabled = false;
            button.textContent = 'Gửi lại OTP';
        }
    }, 1000);
}
