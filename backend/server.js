require("dotenv").config();
const express = require("express");
const cors = require("cors");
const Anthropic = require("@anthropic-ai/sdk");
const mysql = require("mysql2/promise");
const { v4: uuidv4 } = require("uuid");
const multer = require("multer");
const COS = require("cos-nodejs-sdk-v5");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");

// ── COS ──────────────────────────────────────────────
const cos = new COS({
  SecretId: process.env.COS_SECRET_ID,
  SecretKey: process.env.COS_SECRET_KEY,
});
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

// ── Email transporter ────────────────────────────────
const mailer = nodemailer.createTransport({
  host: "smtp.qq.com",
  port: 465,
  secure: true,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

const app = express();
const PORT = process.env.PORT || 4000;

if (!process.env.MINIMAX_API_KEY) {
  console.error("Error: MINIMAX_API_KEY is not set in .env");
  process.exit(1);
}

const client = new Anthropic({
  apiKey: process.env.MINIMAX_API_KEY,
  baseURL: "https://api.minimax.io/anthropic",
});

// ── MySQL ────────────────────────────────────────────
const db = mysql.createPool({
  host: process.env.MYSQL_HOST || "localhost",
  user: process.env.MYSQL_USER || "root",
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DB || "claude_chat",
  waitForConnections: true,
  connectionLimit: 10,
});

app.use(cors());
app.use(express.json());

// ── Auth middleware ───────────────────────────────────
function requireAuth(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

// ── POST /api/auth/register ───────────────────────────
app.post("/api/auth/register", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email and password are required" });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Invalid email" });
  if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" });

  try {
    // Check if email already registered or pending
    const [[existing]] = await db.query("SELECT id FROM users WHERE email = ?", [email]);
    if (existing) return res.status(409).json({ error: "Email already registered" });

    const [[pending]] = await db.query(
      "SELECT token FROM pending_registrations WHERE email = ? AND expires_at > NOW()",
      [email]
    );
    if (pending) return res.status(409).json({ error: "A pending registration already exists for this email" });

    const passwordHash = await bcrypt.hash(password, 10);
    const token = uuidv4();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    await db.query(
      "INSERT INTO pending_registrations (token, email, password_hash, expires_at) VALUES (?, ?, ?, ?)",
      [token, email, passwordHash, expiresAt]
    );

    const approveUrl = `${process.env.APP_URL}/api/auth/approve/${token}`;

    await mailer.sendMail({
      from: `"${process.env.APP_NAME || "系统"}" <${process.env.SMTP_USER}>`,
      to: process.env.ADMIN_EMAIL,
      subject: `新用户注册申请 - ${email}`,
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;">
          <h2 style="color:#19c37d;">新用户注册申请</h2>
          <p>用户 <strong>${email}</strong> 申请注册账号。</p>
          <p>申请时间：${new Date().toLocaleString("zh-CN")}</p>
          <p>点击下方按钮批准该注册申请：</p>
          <a href="${approveUrl}" style="display:inline-block;margin-top:16px;padding:12px 28px;background:#19c37d;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;">
            批准注册
          </a>
          <p style="margin-top:24px;color:#888;font-size:0.85rem;">此链接 7 天内有效。如不批准，请忽略此邮件。</p>
          <hr style="border:none;border-top:1px solid #eee;margin:24px 0;">
          <p style="color:#aaa;font-size:0.8rem;">批准链接：${approveUrl}</p>
        </div>
      `,
    });

    res.json({ ok: true, message: "Registration request submitted. Waiting for admin approval." });
  } catch (err) {
    console.error("Register error:", err.message);
    res.status(500).json({ error: "Registration failed" });
  }
});

// ── GET /api/auth/approve/:token ──────────────────────
app.get("/api/auth/approve/:token", async (req, res) => {
  const { token } = req.params;
  try {
    const [[pending]] = await db.query(
      "SELECT * FROM pending_registrations WHERE token = ? AND expires_at > NOW()",
      [token]
    );

    if (!pending) {
      return res.send(approvalPage("批准失败", "链接无效或已过期。", false));
    }

    const [[existing]] = await db.query("SELECT id FROM users WHERE email = ?", [pending.email]);
    if (existing) {
      await db.query("DELETE FROM pending_registrations WHERE token = ?", [token]);
      return res.send(approvalPage("已注册", "该邮箱已完成注册。", false));
    }

    const id = uuidv4();
    await db.query(
      "INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)",
      [id, pending.email, pending.password_hash]
    );
    await db.query("DELETE FROM pending_registrations WHERE token = ?", [token]);

    res.send(approvalPage("批准成功", `用户 ${pending.email} 已成功注册。`, true));
  } catch (err) {
    console.error("Approve error:", err.message);
    res.status(500).send(approvalPage("错误", "服务器错误，请重试。", false));
  }
});

function approvalPage(title, message, success) {
  const color = success ? "#19c37d" : "#e55";
  return `<!DOCTYPE html><html lang="zh"><head><meta charset="UTF-8"><title>${title}</title>
  <style>body{font-family:sans-serif;background:#212121;color:#ececec;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;}
  .box{background:#2a2a2a;border-radius:16px;padding:40px;text-align:center;max-width:400px;}
  h2{color:${color};margin-bottom:12px;}p{color:#aaa;}
  a{display:inline-block;margin-top:20px;padding:10px 24px;background:${color};color:#fff;text-decoration:none;border-radius:8px;}</style>
  </head><body><div class="box"><h2>${title}</h2><p>${message}</p>
  <a href="${process.env.APP_URL}/login.html">前往登录</a></div></body></html>`;
}

// ── POST /api/auth/login ──────────────────────────────
app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email and password are required" });

  try {
    const [[user]] = await db.query("SELECT * FROM users WHERE email = ?", [email]);
    if (!user) return res.status(401).json({ error: "Invalid email or password" });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: "Invalid email or password" });

    const token = jwt.sign(
      { id: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );
    res.json({ token, email: user.email });
  } catch (err) {
    console.error("Login error:", err.message);
    res.status(500).json({ error: "Login failed" });
  }
});

// ── GET /api/auth/me ──────────────────────────────────
app.get("/api/auth/me", requireAuth, (req, res) => {
  res.json({ id: req.user.id, email: req.user.email });
});

// ── Protected routes ──────────────────────────────────

// GET /api/conversations
app.get("/api/conversations", requireAuth, async (req, res) => {
  try {
    const [rows] = await db.query(
      "SELECT id, title, updated_at FROM conversations ORDER BY updated_at DESC"
    );
    res.json(rows);
  } catch (err) {
    console.error("DB error:", err.message);
    res.status(500).json({ error: "Database error" });
  }
});

// POST /api/conversations
app.post("/api/conversations", requireAuth, async (req, res) => {
  const id = uuidv4();
  try {
    await db.query("INSERT INTO conversations (id, title) VALUES (?, ?)", [id, "新对话"]);
    res.json({ id, title: "新对话" });
  } catch (err) {
    console.error("DB error:", err.message);
    res.status(500).json({ error: "Database error" });
  }
});

// GET /api/conversations/:id/messages
app.get("/api/conversations/:id/messages", requireAuth, async (req, res) => {
  try {
    const [rows] = await db.query(
      "SELECT role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at ASC",
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    console.error("DB error:", err.message);
    res.status(500).json({ error: "Database error" });
  }
});

// DELETE /api/conversations/:id
app.delete("/api/conversations/:id", requireAuth, async (req, res) => {
  try {
    await db.query("DELETE FROM conversations WHERE id = ?", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error("DB error:", err.message);
    res.status(500).json({ error: "Database error" });
  }
});

// POST /api/upload
app.post("/api/upload", requireAuth, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file provided" });
  const ext = req.file.originalname.split(".").pop().toLowerCase();
  const allowed = ["jpg", "jpeg", "png", "gif", "webp"];
  if (!allowed.includes(ext)) return res.status(400).json({ error: "File type not allowed" });
  const key = `uploads/${Date.now()}-${uuidv4()}.${ext}`;
  try {
    await cos.putObject({
      Bucket: process.env.COS_BUCKET,
      Region: process.env.COS_REGION,
      Key: key,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
    });
    const url = `https://${process.env.COS_BUCKET}.cos.${process.env.COS_REGION}.myqcloud.com/${key}`;
    res.json({ url, key });
  } catch (err) {
    console.error("COS upload error:", err.message);
    res.status(500).json({ error: "Upload failed" });
  }
});

// GET /api/photos
app.get("/api/photos", requireAuth, async (req, res) => {
  try {
    const [rows] = await db.query(
      "SELECT id, url, description, created_at FROM photos ORDER BY created_at DESC"
    );
    res.json(rows);
  } catch (err) {
    console.error("DB error:", err.message);
    res.status(500).json({ error: "Database error" });
  }
});

// POST /api/photos
app.post("/api/photos", requireAuth, async (req, res) => {
  const { url, cosKey, description = "" } = req.body;
  if (!url || !cosKey) return res.status(400).json({ error: "url and cosKey are required" });
  const id = uuidv4();
  try {
    await db.query(
      "INSERT INTO photos (id, url, cos_key, description) VALUES (?, ?, ?, ?)",
      [id, url, cosKey, description]
    );
    const [[row]] = await db.query("SELECT id, url, description, created_at FROM photos WHERE id = ?", [id]);
    res.status(201).json(row);
  } catch (err) {
    console.error("DB error:", err.message);
    res.status(500).json({ error: "Database error" });
  }
});

// PUT /api/photos/:id
app.put("/api/photos/:id", requireAuth, async (req, res) => {
  const { description } = req.body;
  if (description === undefined) return res.status(400).json({ error: "description is required" });
  try {
    const [[photo]] = await db.query("SELECT id FROM photos WHERE id = ?", [req.params.id]);
    if (!photo) return res.status(404).json({ error: "Photo not found" });
    await db.query("UPDATE photos SET description = ? WHERE id = ?", [description, req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error("DB error:", err.message);
    res.status(500).json({ error: "Database error" });
  }
});

// DELETE /api/photos/:id
app.delete("/api/photos/:id", requireAuth, async (req, res) => {
  try {
    const [[photo]] = await db.query("SELECT id, cos_key FROM photos WHERE id = ?", [req.params.id]);
    if (!photo) return res.status(404).json({ error: "Photo not found" });
    await cos.deleteObject({ Bucket: process.env.COS_BUCKET, Region: process.env.COS_REGION, Key: photo.cos_key });
    await db.query("DELETE FROM photos WHERE id = ?", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error("Delete error:", err.message);
    res.status(500).json({ error: "Delete failed" });
  }
});

// POST /api/chat
app.post("/api/chat", requireAuth, async (req, res) => {
  const { prompt, conversationId } = req.body;
  if (!prompt || typeof prompt !== "string" || prompt.trim() === "") {
    return res.status(400).json({ error: "prompt is required" });
  }
  if (!conversationId) {
    return res.status(400).json({ error: "conversationId is required" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  try {
    await db.query(
      "INSERT INTO messages (conversation_id, role, content) VALUES (?, 'user', ?)",
      [conversationId, prompt.trim()]
    );
  } catch (err) {
    console.error("DB error saving user message:", err.message);
  }

  let history = [];
  try {
    const [rows] = await db.query(
      "SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at ASC",
      [conversationId]
    );
    history = rows.map((r) => ({
      role: r.role === "ai" ? "assistant" : "user",
      content: r.content,
    }));
  } catch (err) {
    console.error("DB error fetching history:", err.message);
  }

  let aiResponse = "";
  try {
    const stream = client.messages.stream({
      model: "MiniMax-M2.5",
      max_tokens: 1024,
      messages: history,
    });

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        aiResponse += event.delta.text;
        res.write(`data: ${JSON.stringify({ text: event.delta.text })}\n\n`);
      }
    }

    await db.query(
      "INSERT INTO messages (conversation_id, role, content) VALUES (?, 'ai', ?)",
      [conversationId, aiResponse]
    );

    const [conv] = await db.query("SELECT title FROM conversations WHERE id = ?", [conversationId]);
    if (conv[0]?.title === "新对话") {
      const title = prompt.trim().slice(0, 30);
      await db.query("UPDATE conversations SET title = ? WHERE id = ?", [title, conversationId]);
    }

    res.write("data: [DONE]\n\n");
    res.end();
  } catch (err) {
    console.error("MiniMax API error:", err.message);
    res.write(`data: ${JSON.stringify({ error: "API call failed" })}\n\n`);
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});
