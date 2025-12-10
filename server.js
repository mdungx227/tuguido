// Smart Locker Backend Server
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const admin = require("firebase-admin");
const fs = require("fs");
const jwt = require("jsonwebtoken");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

// =======================
// 0. Cấu hình ROLE (admin theo số điện thoại)
// =======================

// Danh sách số điện thoại admin (chuẩn hoá về dạng 0xxxxxxxxx)
const ADMIN_PHONES = [
  "0976983308", // số admin (bạn sửa lại nếu cần)
  // thêm các số khác nếu cần
];

// Hàm chuẩn hoá SĐT về dạng 0xxxxxxxxx
function normalizePhone(phone) {
  if (!phone) return "";
  phone = phone.toString().replace(/\s+/g, "");
  if (phone.startsWith("+84")) return "0" + phone.slice(3);
  if (phone.startsWith("84")) return "0" + phone.slice(2);
  return phone;
}

// Hàm xác định role dựa trên SĐT
function getRoleForPhone(phoneNumber) {
  const norm = normalizePhone(phoneNumber);
  return ADMIN_PHONES.includes(norm) ? "admin" : "resident";
}

// =======================
// 1.Kết nối Firebase
// =======================
const serviceAccount = JSON.parse(
  fs.readFileSync("./serviceAccountKey.json", "utf8")
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://minhquang-36ee2-default-rtdb.firebaseio.com",
});

const db = admin.database();

// =======================
// 2. Khởi tạo express
// =======================
const app = express();
app.use(cors());
app.use(bodyParser.json());

const PORT = 3000;
const JWT_SECRET = "supersecretkey"; // nhớ đổi khi lên production

// =======================
// Phone Auth Configuration
// =======================
const OTP_EXPIRY_MINUTES = 1;
const RESERVATION_EXPIRY_HOURS = 24 * 3;

// =======================
// 3. Middleware xác thực jwt
// =======================
function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Token missing" });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: "Invalid token" });
    req.user = user;
    next();
  });
}
//middleware xác thực admin
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ success: false, error: "Admin only" });
  }
  next();
}

// Admin: xem tất cả đơn đặt tủ
app.get("/api/admin/reservations-all", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const snap = await db.ref("/Reservations").once("value");
    const data = snap.val() || {};

    const reservations = Object.entries(data)
      .map(([id, r]) => ({
        id,
        receiverPhone: r.receiverPhone || null,
        lockerId: r.lockerId || "Locker1",
        bookingCode: r.bookingCode || r.otpCode || null,
        status: r.status || "unknown",
        createdAt: r.createdAt || null,
        loadedAt: r.loadedAt || null,
        openedAt: r.openedAt || null,
        expiresAt: r.expiresAt || null,
      }))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    res.json({
      success: true,
      reservations,
    });
  } catch (err) {
    console.error("Error getting all reservations (admin):", err);
    res.status(500).json({ success: false, error: "Failed to get reservations" });
  }
});

// Admin: xem log hệ thống
app.get("/api/admin/logs", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const snap = await db.ref("/Logs").limitToLast(200).once("value");
    const data = snap.val() || {};

    const logs = Object.entries(data)
      .map(([id, l]) => ({
        id,
        phone: l.phone || null,
        locker: l.locker || "Locker1",
        action: l.action || "",
        result: l.result || "",
        timestamp: l.timestamp || null,
        reservationId: l.reservationId || null,
      }))
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    res.json({
      success: true,
      logs,
    });
  } catch (err) {
    console.error("Error getting logs (admin):", err);
    res.status(500).json({ success: false, error: "Failed to get logs" });
  }
});




// =======================
// 4. Phone Authentication APIs
// =======================

// Gửi OTP
app.post("/api/auth/send-otp", async (req, res) => {
  const { phoneNumber } = req.body;

  if (!phoneNumber) {
    return res.status(400).json({ error: "Phone number required" });
  }

  // Validate phone number format (Vietnamese)
  const phoneRegex = /^(\+84|84|0)[0-9]{9}$/;
  if (!phoneRegex.test(phoneNumber)) {
    return res.status(400).json({ error: "Invalid phone number format" });
  }

  try {
    // Generate 6-digit OTP
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    const verificationId = uuidv4();
    const expiresAt = Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000;

    // Store OTP in Firebase
    await db.ref(`/OTPs/${verificationId}`).set({
      phoneNumber: phoneNumber,
      otpCode: otpCode,
      expiresAt: expiresAt,
      createdAt: Date.now(),
    });

    // In production, send SMS here
    console.log(`📱 OTP for ${phoneNumber}: ${otpCode}`);
    console.log(`🔑 Verification ID: ${verificationId}`);
    console.log(
      `⏰ Expires at: ${new Date(expiresAt).toLocaleString("vi-VN")}`
    );

    res.json({
      success: true,
      verificationId: verificationId,
      message: "OTP sent successfully",
      otpCode: otpCode, // dev only
      expiresAt: expiresAt,
    });
  } catch (error) {
    console.error("Error sending OTP:", error);
    res.status(500).json({ error: "Failed to send OTP" });
  }
});

// Đăng nhập bằng OTP (verify + tạo token)
app.post("/api/auth/verify-otp", async (req, res) => {
  const { verificationId, otpCode } = req.body;

  if (!verificationId || !otpCode) {
    return res
      .status(400)
      .json({ error: "Thiếu verificationId hoặc otpCode" });
  }

  try {
    // 1. Lấy OTP từ Firebase
    const otpSnapshot = await db.ref(`/OTPs/${verificationId}`).once("value");
    const otpData = otpSnapshot.val();

    if (!otpData) {
      return res
        .status(400)
        .json({ error: "Verification ID không hợp lệ" });
    }

    // 2. Kiểm tra hết hạn
    if (Date.now() > otpData.expiresAt) {
      return res.status(400).json({ error: "OTP đã hết hạn" });
    }

    // 3. Kiểm tra mã OTP
    if (otpData.otpCode !== otpCode) {
      return res.status(400).json({ error: "Mã OTP không đúng" });
    }

    const phoneNumber = otpData.phoneNumber;

    // 4. Lấy thông tin user từ /Users
    const userRef = db.ref(`/Users/${phoneNumber}`);
    const userSnapshot = await userRef.once("value");
    const userData = userSnapshot.val();

    if (!userData) {
      // User chưa đăng ký → không login, yêu cầu đăng ký trước
      return res.status(400).json({
        error: "Số điện thoại này chưa đăng ký tài khoản",
      });
    }

    // 5. Cập nhật lastLogin
    const now = Date.now();
    await userRef.update({ lastLogin: now });

    // 6. Xác định role (ưu tiên logic admin theo phone)
    const role = getRoleForPhone(phoneNumber) || userData.role || "resident";

    // 7. Tạo JWT token có phone + role
    const token = jwt.sign(
      { phoneNumber: phoneNumber, role: role },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    // 8. Xoá OTP vì đã dùng xong
    await db.ref(`/OTPs/${verificationId}`).remove();

    // 9. Trả kết quả cho frontend
    res.json({
      success: true,
      token: token,
      phoneNumber: phoneNumber,
      role: role,
      user: { ...userData, lastLogin: now, role },
    });
  } catch (error) {
    console.error("Error verifying OTP:", error);
    res.status(500).json({ error: "Lỗi xác thực OTP" });
  }
});

// Đăng ký user mới
app.post("/api/auth/register", async (req, res) => {
  const { phoneNumber, fullName, verificationId, otpCode, apartment } = req.body;

  if (!phoneNumber || !fullName || !verificationId || !otpCode) {
    return res
      .status(400)
      .json({ error: "All fields required (phone, name, otp...)" });
  }

  try {
    // Verify OTP
    const otpSnapshot = await db.ref(`/OTPs/${verificationId}`).once("value");
    const otpData = otpSnapshot.val();

    if (
      !otpData ||
      otpData.otpCode !== otpCode ||
      Date.now() > otpData.expiresAt
    ) {
      return res.status(400).json({ error: "Invalid or expired OTP" });
    }

    // Check if user already exists
    const userRef = db.ref(`/Users/${phoneNumber}`);
    const userSnapshot = await userRef.once("value");
    if (userSnapshot.exists()) {
      return res.status(400).json({ error: "User already exists" });
    }

    // Xác định role theo số điện thoại
    const userRole = getRoleForPhone(phoneNumber);

    // Create user
    const userData = {
      phoneNumber: phoneNumber,
      fullName: fullName,
      apartment: apartment || "",
      role: userRole,
      createdAt: Date.now(),
      lastLogin: Date.now(),
    };

    await userRef.set(userData);

    // Generate JWT token
    const token = jwt.sign(
      { phoneNumber: phoneNumber, role: userData.role },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    // Clean up OTP
    await db.ref(`/OTPs/${verificationId}`).remove();

    res.json({
      success: true,
      user: userData,
      token: token,
    });
  } catch (error) {
    console.error("Error registering user:", error);
    res.status(500).json({ error: "Failed to register user" });
  }
});

// =======================
// 5. API: Gửi lệnh mở/đóng locker
// =======================
app.post("/api/command", authenticateToken, requireAdmin, async (req, res) => {
  const { lockerId, action } = req.body;
  const phoneNumber = req.user.phoneNumber;

  if (!["open", "close"].includes(action)) {
    return res.status(400).json({ error: "Invalid action" });
  }

  try {
    const lockerRef = db.ref(`/Locker1`);
    await lockerRef.update({
      status: action,
      last_update: Date.now(),
    });

    const logRef = db.ref("/Logs").push();
    await logRef.set({
      phone: phoneNumber,
      locker: lockerId,
      action,
      timestamp: Date.now(),
      result: "success",
    });

    res.json({ message: `Command '${action}' sent to ${lockerId}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to send command" });
  }
});

// =======================
// 6. API: Lấy trạng thái locker
// =======================
app.get("/api/locker/:id/status", authenticateToken, async (req, res) => {
  const lockerId = req.params.id;
  try {
    const lockerSnapshot = await db.ref(`/Locker1`).once("value");
    const lockerData = lockerSnapshot.val();
    res.json(lockerData || { status: "unknown" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to get locker status" });
  }
});

/// Cư dân đặt tủ trước
app.post("/api/user/reserve-locker", authenticateToken, async (req, res) => {
  const { lockerId } = req.body;
  const receiverPhone = req.user.phoneNumber;  // cư dân đang login

  if (!lockerId) {
    return res.status(400).json({ error: "Locker ID required" });
  }

  try {
    // TODO: kiểm tra locker có đang rảnh không (chưa có đơn pending)
    // tạm bỏ qua để đơn giản

    const reservationId = uuidv4();
    const bookingCode = Math.floor(100000 + Math.random() * 900000).toString(); // mã 6 số
    const expiresAt = Date.now() + (RESERVATION_EXPIRY_HOURS * 60 * 60 * 1000); // 3 ngày

    await db.ref(`/Reservations/${reservationId}`).set({
      receiverPhone,
      lockerId,
      bookingCode,
      pickupOtp: null,      // chưa có OTP mở tủ
      status: "booked",     // đã đặt, chưa bỏ hàng
      createdAt: Date.now(),
      expiresAt
    });

    res.json({
      success: true,
      reservationId,
      lockerId,
      bookingCode,   // cái này cư dân gửi cho shipper
      expiresAt
    });
  } catch (err) {
    console.error("Error reserving locker:", err);
    res.status(500).json({ error: "Failed to reserve locker" });
  }
});

// Lấy lịch sử đặt tủ của cư dân (theo số đang đăng nhập)
app.get("/api/user/reservations", authenticateToken, async (req, res) => {
  const phoneNumber = req.user.phoneNumber; // lấy từ token JWT

  try {
    // Lọc tất cả reservation mà người nhận = số điện thoại đang login
    const snap = await db
      .ref("/Reservations")
      .orderByChild("receiverPhone")
      .equalTo(phoneNumber)
      .once("value");

    const data = snap.val() || {};

    // Convert object -> array, sort theo thời gian tạo mới nhất
    const reservations = Object.entries(data)
      .map(([id, r]) => ({
        id,
        lockerId: r.lockerId || "Locker1",
        // Nếu bạn dùng bookingCode (đặt tủ trước) thì lấy bookingCode,
        // nếu chưa có thì fallback sang otpCode cho đỡ bị null.
        bookingCode: r.bookingCode || r.otpCode || null,
        status: r.status || "unknown",
        createdAt: r.createdAt || null,
        expiresAt: r.expiresAt || null,
      }))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    res.json({
      success: true,
      reservations,
    });
  } catch (err) {
    console.error("Error getting user reservations:", err);
    res.status(500).json({ error: "Failed to get user reservations" });
  }
});

// Shipper dùng mã đặt tủ (bookingCode) để mở tủ và đánh dấu đã bỏ hàng
app.post("/api/shipper/use-reservation", async (req, res) => {
  const { bookingCode } = req.body;

  if (!bookingCode) {
    return res.status(400).json({ error: "Booking code required" });
  }

  try {
    // 1. Tìm reservation theo bookingCode
    const snap = await db
      .ref("/Reservations")
      .orderByChild("bookingCode")
      .equalTo(bookingCode)
      .once("value");

    const reservations = snap.val();

    if (!reservations) {
      return res.status(400).json({ error: "Không tìm thấy mã đặt tủ này" });
    }

    const [reservationId, reservation] = Object.entries(reservations)[0];

    // 2. Kiểm tra hết hạn & trạng thái
    if (Date.now() > reservation.expiresAt) {
      return res.status(400).json({ error: "Đơn đặt tủ đã hết hạn" });
    }

    if (reservation.status !== "booked") {
      return res.status(400).json({ error: `Trạng thái hiện tại: ${reservation.status}, không thể dùng mã này.` });
    }

    // 3. Mở tủ cho shipper
    const lockerRef = db.ref(`/Locker1`); // hoặc `/Lockers/${reservation.lockerId}` nếu bạn tách nhiều tủ
    await lockerRef.update({
      status: "open",
      last_update: Date.now(),
    });

    // 4. Sinh OTP cho cư dân mở tủ lần sau
    const pickupOtp = Math.floor(100000 + Math.random() * 900000).toString();

    await db.ref(`/Reservations/${reservationId}`).update({
      status: "loaded",      // đã bỏ hàng vào tủ
      loadedAt: Date.now(),
      pickupOtp: pickupOtp,  // OTP cho cư dân
      otpCode: pickupOtp     // để code cũ dùng otpCode cũng không bị hỏng
    });

    console.log(`🎯 OTP cho người nhận (${reservation.receiverPhone}): ${pickupOtp}`);

    // TODO: thực tế thì gửi SMS cho receiver ở đây
    /*Trong thực tế, chỗ này sẽ:

Gọi API của dịch vụ SMS (Twilio, Nexmo, Viettel, v.v…)

Gửi OTP qua SMS cho số receiverPhone.

Nhưng với đồ án, bạn chỉ cần:

Ghi rõ trong báo cáo: “Hệ thống demo OTP bằng console log; trong triển khai thực tế sẽ tích hợp với dịch vụ SMS”.

Chụp ảnh console có dòng OTP để minh họa.*/

    res.json({
      success: true,
      lockerId: reservation.lockerId,
      message: "Đã mở tủ cho shipper và tạo OTP cho người nhận.",
    });
  } catch (err) {
    console.error("Error using reservation by shipper:", err);
    res.status(500).json({ error: "Lỗi xử lý mã đặt tủ cho shipper" });
  }
});



// =======================
// Receiver: kiểm tra xem có hàng trong tủ không
// =======================
app.post("/api/receiver/check-reservation", authenticateToken, async (req, res) => {
  const phoneNumber = req.user.phoneNumber;

  try {
    const snap = await db
      .ref("/Reservations")
      .orderByChild("receiverPhone")
      .equalTo(phoneNumber)
      .once("value");

    const reservations = snap.val();

    if (!reservations) {
      return res.json({ hasReservation: false });
    }

    // Tìm reservation mới nhất đang ở trạng thái "loaded" (hàng đã được bỏ vào tủ)
    const now = Date.now();
    const loadedList = Object.entries(reservations)
      .map(([id, r]) => ({ id, ...r }))
      .filter(r => r.status === "loaded" && now < (r.expiresAt || 0))
      .sort((a, b) => (b.loadedAt || b.createdAt || 0) - (a.loadedAt || a.createdAt || 0));

    if (loadedList.length === 0) {
      return res.json({ hasReservation: false });
    }

    const r = loadedList[0]; // lấy đơn mới nhất

    res.json({
      success: true,
      hasReservation: true,
      reservation: {
        id: r.id,
        lockerId: r.lockerId || "Locker1",
        status: r.status,
        createdAt: r.createdAt || null,
        loadedAt: r.loadedAt || null,
        expiresAt: r.expiresAt || null,
        // KHÔNG trả OTP ở đây, OTP coi như đã gửi qua SMS
      }
    });
  } catch (error) {
    console.error("Error checking receiver reservation:", error);
    res.status(500).json({ error: "Failed to check reservation" });
  }
});

// =======================
// Receiver: nhập OTP để mở tủ
// =======================
app.post("/api/receiver/verify-and-open", authenticateToken, async (req, res) => {
  const { reservationId, otpCode } = req.body;
  const phoneNumber = req.user.phoneNumber;

  if (!reservationId || !otpCode) {
    return res.status(400).json({ error: "Reservation ID và OTP là bắt buộc" });
  }

  try {
    const reservationRef = db.ref(`/Reservations/${reservationId}`);
    const snapshot = await reservationRef.once("value");
    const reservation = snapshot.val();

    if (!reservation) {
      return res.status(400).json({ error: "Không tìm thấy đơn đặt tủ" });
    }

    // Đảm bảo đúng người nhận
    if (reservation.receiverPhone !== phoneNumber) {
      return res.status(403).json({ error: "Bạn không có quyền mở đơn đặt tủ này" });
    }

    // Kiểm tra trạng thái
    if (reservation.status !== "loaded") {
      return res.status(400).json({ error: `Đơn ở trạng thái '${reservation.status}', không thể mở bằng OTP` });
    }

    // Kiểm tra hết hạn
    if (Date.now() > (reservation.expiresAt || 0)) {
      return res.status(400).json({ error: "Đơn đặt tủ đã hết hạn" });
    }

    // Kiểm tra OTP (ưu tiên pickupOtp, fallback otpCode)
    const storedOtp = reservation.pickupOtp || reservation.otpCode;
    if (!storedOtp || storedOtp !== otpCode) {
      return res.status(400).json({ error: "Mã OTP không đúng" });
    }

    // Mở tủ: cập nhật node Locker1 (hoặc Lockers/lockerId nếu bạn tách)
    const lockerRef = db.ref(`/Locker1`);
    await lockerRef.update({
      status: "open",
      last_update: Date.now(),
    });

    // Cập nhật trạng thái đơn
    await reservationRef.update({
      status: "opened",
      openedAt: Date.now(),
    });

    // Ghi log
    const logRef = db.ref("/Logs").push();
    await logRef.set({
      phone: phoneNumber,
      locker: reservation.lockerId,
      action: "open_by_receiver",
      timestamp: Date.now(),
      result: "success",
      reservationId: reservationId
    });

    res.json({
      success: true,
      lockerOpened: true,
      message: "Mở tủ thành công, bạn có thể lấy hàng."
    });
  } catch (error) {
    console.error("Error verifying OTP & opening locker:", error);
    res.status(500).json({ error: "Lỗi khi xác thực OTP và mở tủ" });
  }
});

// =======================
// 9. Serve static HTML files
// =======================

// Serve toàn bộ file tĩnh trong thư mục cha (index.html, dashboard.html, shipper.html,...)
app.use(express.static(path.join(__dirname, "..")));

// Trang chính (login/index)
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "/index.html"));
});

// Dashboard cư dân
app.get("/dashboard", (req, res) => {
  res.sendFile(path.join(__dirname, "/dashboard.html"));
});

// Trang shipper
app.get("/shipper", (req, res) => {
  res.sendFile(path.join(__dirname, "/shipper.html"));
});

// (nếu có trang receiver.html thì giữ, không có thì bỏ)
app.get("/receiver", (req, res) => {
  res.sendFile(path.join(__dirname, "/receiver.html"));
});

app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "/admin.html"));
});



// =======================
// 10. Start Server
// =======================
app.listen(PORT, () => {
  console.log(`🚀 Smart Locker Backend running at http://localhost:${PORT}`);
  console.log(`📱 Main page: http://localhost:${PORT}`);
  console.log(`🔍 Shipper page: http://localhost:${PORT}/shipper`);

});
