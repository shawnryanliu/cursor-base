require("dotenv").config();
const express = require("express");
const cors = require("cors");
const Anthropic = require("@anthropic-ai/sdk");
const mysql = require("mysql2/promise");
const { v4: uuidv4 } = require("uuid");
const multer = require("multer");
const COS = require("cos-nodejs-sdk-v5");

const cos = new COS({
  SecretId: process.env.COS_SECRET_ID,
  SecretKey: process.env.COS_SECRET_KEY,
});
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

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

// MySQL connection pool
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

// GET /api/conversations - list all conversations
app.get("/api/conversations", async (req, res) => {
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

// POST /api/conversations - create new conversation
app.post("/api/conversations", async (req, res) => {
  const id = uuidv4();
  try {
    await db.query(
      "INSERT INTO conversations (id, title) VALUES (?, ?)",
      [id, "新对话"]
    );
    res.json({ id, title: "新对话" });
  } catch (err) {
    console.error("DB error:", err.message);
    res.status(500).json({ error: "Database error" });
  }
});

// GET /api/conversations/:id/messages - get messages for a conversation
app.get("/api/conversations/:id/messages", async (req, res) => {
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

// DELETE /api/conversations/:id - delete a conversation
app.delete("/api/conversations/:id", async (req, res) => {
  try {
    await db.query("DELETE FROM conversations WHERE id = ?", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error("DB error:", err.message);
    res.status(500).json({ error: "Database error" });
  }
});

// POST /api/upload - upload image to COS
app.post("/api/upload", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file provided" });

  const ext = req.file.originalname.split(".").pop().toLowerCase();
  const allowed = ["jpg", "jpeg", "png", "gif", "webp"];
  if (!allowed.includes(ext)) {
    return res.status(400).json({ error: "File type not allowed" });
  }

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
    res.json({ url });
  } catch (err) {
    console.error("COS upload error:", err.message);
    res.status(500).json({ error: "Upload failed" });
  }
});

// POST /api/chat - send message and stream response
app.post("/api/chat", async (req, res) => {
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

  // Save user message
  try {
    await db.query(
      "INSERT INTO messages (conversation_id, role, content) VALUES (?, 'user', ?)",
      [conversationId, prompt.trim()]
    );
  } catch (err) {
    console.error("DB error saving user message:", err.message);
  }

  // Fetch conversation history for context
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
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        aiResponse += event.delta.text;
        res.write(`data: ${JSON.stringify({ text: event.delta.text })}\n\n`);
      }
    }

    // Save AI response
    await db.query(
      "INSERT INTO messages (conversation_id, role, content) VALUES (?, 'ai', ?)",
      [conversationId, aiResponse]
    );

    // Update conversation title from first user message if still default
    const [conv] = await db.query(
      "SELECT title FROM conversations WHERE id = ?",
      [conversationId]
    );
    if (conv[0]?.title === "新对话") {
      const title = prompt.trim().slice(0, 30);
      await db.query("UPDATE conversations SET title = ? WHERE id = ?", [
        title,
        conversationId,
      ]);
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
